use tauri::State;

use crate::agent::{codex_availability, Bounds, CodexRunner, EchoRunner};
use crate::commands::agent_run_store::{
    fetch_agent_runs, fetch_log_tail, insert_agent_run, new_run_id,
};
use crate::db::Db;
use crate::error::AppError;
use crate::jobs::{JobManager, NewAgentRun};
use crate::models::{
    AgentRail, AgentRunView, CodexAvailability, Engine, Sandbox, TriggerCodexInput,
    TriggerEchoInput,
};

/// codex 설치/인증 상태 (graceful degrade — 프런트가 자동화 UI 활성/비활성 결정).
#[tauri::command]
#[specta::specta]
pub async fn codex_status(jm: State<'_, JobManager>) -> Result<CodexAvailability, AppError> {
    Ok(codex_availability(jm.codex_bin.as_deref()).await)
}

/// echo 테스트 잡 트리거 (codex 없이 bound/kill/로그 캡처 검증). engine=codex/kind=echo로 영속.
#[tauri::command]
#[specta::specta]
pub async fn trigger_echo_job(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerEchoInput,
) -> Result<String, AppError> {
    let id = new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: 1,
        cost_cap_usd: 0.0,
    };
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id: None,
            engine: Engine::Codex,
            kind: "echo".into(),
            rail: AgentRail::Suggestion,
            sandbox: Sandbox::ReadOnly,
            repo_id: None,
            workdir: None,
            trigger: None,
            retry_key: None,
            retry_count: 0,
            bounds,
            log_path: jm.log_path(&id).to_string_lossy().into_owned(),
        },
    )
    .await?;

    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        EchoRunner {
            seconds: input.seconds,
            message: input.message,
        },
        false, // 게이트 아님 — echo는 proposal 없이 succeeded.
    );
    Ok(id)
}

/// codex 잡 트리거 (read_only 샌드박스 고정 — 실행 레일=Phase 10). 미설치/미인증이면 Err(graceful degrade).
#[tauri::command]
#[specta::specta]
pub async fn trigger_codex_job(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerCodexInput,
) -> Result<String, AppError> {
    let prompt = input.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::validation(
            "agents.prompt_empty",
            "프롬프트가 비었습니다.",
        ));
    }
    // graceful degrade: codex 미설치/미인증이면 잡을 만들지 않는다.
    let Some(codex_bin) = jm.codex_bin.clone() else {
        return Err(AppError::terminal(
            "agents.codex_not_found",
            "codex CLI를 찾을 수 없습니다 — 설치 후 재시작하세요.",
        ));
    };
    let avail = codex_availability(Some(&codex_bin)).await;
    if !avail.authed {
        return Err(AppError::terminal("agents.codex_unauthed", avail.detail));
    }

    // 코드 잡이면 repo.local_path 해석(worktree 베이스).
    let mut repo_path: Option<std::path::PathBuf> = None;
    if let Some(repo_id) = &input.repo_id {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT local_path FROM repos WHERE id = ? AND enabled = 1")
                .bind(repo_id)
                .fetch_optional(db.inner())
                .await?;
        match row {
            Some((Some(p),)) if !p.trim().is_empty() => {
                repo_path = Some(std::path::PathBuf::from(p))
            }
            _ => {
                return Err(AppError::validation(
                    "agents.repo_no_local_path",
                    "레포의 local_path가 없습니다(코드 잡은 로컬 경로 필요).",
                ))
            }
        }
    }

    let id = new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    // 코드 잡 worktree 경로(예측 가능 — workdir로 기록). 비-레포면 None.
    let workdir = repo_path
        .as_ref()
        .map(|_| jm.worktree_root.join(&id).to_string_lossy().into_owned());
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id: input.project_id.clone(),
            engine: Engine::Codex,
            kind: "codex_exec".into(),
            rail: AgentRail::Suggestion,
            sandbox: Sandbox::ReadOnly,
            repo_id: input.repo_id.clone(),
            workdir,
            trigger: None,
            retry_key: None,
            retry_count: 0,
            bounds,
            log_path: jm.log_path(&id).to_string_lossy().into_owned(),
        },
    )
    .await?;

    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        CodexRunner {
            codex_bin,
            run_id: id.clone(),
            prompt: prompt.to_string(),
            sandbox: Sandbox::ReadOnly,
            rail: AgentRail::Suggestion,
            repo_path,
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: Vec::new(),
            model: crate::commands::nav::get_config(db.inner(), "agent.codex_model")
                .await
                .ok()
                .flatten(),
        },
        false, // 자유형 codex 잡은 게이트 아님 — 산출물 표시는 Phase 8 PR self-check 잡만.
    );
    Ok(id)
}

/// Jobs 뷰 — 최근 잡 목록(영속된 agent_runs에서).
#[tauri::command]
#[specta::specta]
pub async fn list_agent_runs(db: State<'_, Db>) -> Result<Vec<AgentRunView>, AppError> {
    Ok(fetch_agent_runs(db.inner()).await?)
}

/// 잡 kill switch. 실행/대기 중이면 취소(true), 이미 끝났으면 false.
#[tauri::command]
#[specta::specta]
pub async fn kill_agent_run(jm: State<'_, JobManager>, run_id: String) -> Result<bool, AppError> {
    Ok(jm.kill(&run_id))
}

/// 잡 로그 tail(최대 16KB) — Jobs 뷰 로그 패널.
#[tauri::command]
#[specta::specta]
pub async fn read_agent_log(db: State<'_, Db>, run_id: String) -> Result<String, AppError> {
    Ok(fetch_log_tail(db.inner(), &run_id).await?)
}
