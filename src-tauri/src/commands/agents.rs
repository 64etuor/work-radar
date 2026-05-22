use tauri::State;

use crate::agent::{codex_availability, Bounds, CodexRunner, EchoRunner};
use crate::commands::shared::SIGNAL_COLS;
use crate::commands::skills::{
    resolve_prompt, BINDING_BATCH_ENRICH, BINDING_CI_TRIAGE, BINDING_ENRICH, BINDING_PR_SELFCHECK,
};
use crate::db::Db;
use crate::github::{HttpPrProvider, PrProvider};
use crate::jobs::{fetch_agent_runs, fetch_log_tail, insert_agent_run, JobManager, NewAgentRun};
use crate::keychain;
use crate::models::{
    AgentRail, AgentRunView, AreaTag, BatchEnrichItem, BatchEnrichProposal, CiTriageProposal,
    CodexAvailability, Engine, EnrichProposal, Sandbox, TokenKind, TriageOutcome,
    TriggerCiTriageInput, TriggerCodexInput, TriggerEchoInput, TriggerEnrichAllInput,
    TriggerEnrichInput, TriggerPrSelfCheckInput, WorkSignal,
};

// ── Agent 스파인 (Phase 7, 잡 큐 + bounds + kill) ──────────────────────────────────
//
// INVARIANT #5: 모든 잡 bound(timeout+max_turns+cost_cap+kill). #6: 코드 잡 worktree·기본 read_only.
// #2: codex 출력은 proposal(draft)일 뿐 — 외부 직접 mutate 없음(Acceptance 게이트는 Phase 8+).

/// 새 잡 id (기존 엔티티와 동일한 hex 형식). agent_runs는 id를 미리 알아야 한다
/// (log_path/worktree 경로 산정 + kill 레지스트리 등록 + 반환).
async fn new_run_id(db: &Db) -> Result<String, String> {
    let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id.0)
}

/// codex 설치/인증 상태 (graceful degrade — 프런트가 자동화 UI 활성/비활성 결정).
#[tauri::command]
#[specta::specta]
pub async fn codex_status(jm: State<'_, JobManager>) -> Result<CodexAvailability, String> {
    Ok(codex_availability(jm.codex_bin.as_deref()).await)
}

/// echo 테스트 잡 트리거 (codex 없이 bound/kill/로그 캡처 검증). engine=codex/kind=echo로 영속.
#[tauri::command]
#[specta::specta]
pub async fn trigger_echo_job(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerEchoInput,
) -> Result<String, String> {
    let id = new_run_id(db.inner()).await?;
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
    .await
    .map_err(|e| e.to_string())?;

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
) -> Result<String, String> {
    let prompt = input.prompt.trim();
    if prompt.is_empty() {
        return Err("프롬프트가 비었습니다.".into());
    }
    // graceful degrade: codex 미설치/미인증이면 잡을 만들지 않는다.
    let Some(codex_bin) = jm.codex_bin.clone() else {
        return Err("codex CLI를 찾을 수 없습니다 — 설치 후 재시작하세요.".into());
    };
    let avail = codex_availability(Some(&codex_bin)).await;
    if !avail.authed {
        return Err(avail.detail);
    }

    // 코드 잡이면 repo.local_path 해석(worktree 베이스).
    let mut repo_path: Option<std::path::PathBuf> = None;
    if let Some(repo_id) = &input.repo_id {
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT local_path FROM repos WHERE id = ? AND enabled = 1")
                .bind(repo_id)
                .fetch_optional(db.inner())
                .await
                .map_err(|e| e.to_string())?;
        match row {
            Some((Some(p),)) if !p.trim().is_empty() => {
                repo_path = Some(std::path::PathBuf::from(p))
            }
            _ => return Err("레포의 local_path가 없습니다(코드 잡은 로컬 경로 필요).".into()),
        }
    }

    let id = new_run_id(db.inner()).await?;
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
    .await
    .map_err(|e| e.to_string())?;

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
pub async fn list_agent_runs(db: State<'_, Db>) -> Result<Vec<AgentRunView>, String> {
    fetch_agent_runs(db.inner())
        .await
        .map_err(|e| e.to_string())
}

/// 잡 kill switch. 실행/대기 중이면 취소(true), 이미 끝났으면 false.
#[tauri::command]
#[specta::specta]
pub async fn kill_agent_run(jm: State<'_, JobManager>, run_id: String) -> Result<bool, String> {
    Ok(jm.kill(&run_id))
}

/// 잡 로그 tail(최대 16KB) — Jobs 뷰 로그 패널.
#[tauri::command]
#[specta::specta]
pub async fn read_agent_log(db: State<'_, Db>, run_id: String) -> Result<String, String> {
    fetch_log_tail(db.inner(), &run_id)
        .await
        .map_err(|e| e.to_string())
}

// ── PR self-check 자동 초안 (Phase 8, 제안 레일 첫 자동화) ──────────────────────────
//
// INVARIANT #1: 결정 레일 무침범 — self-check 초안은 제안일 뿐, 매트릭스 분류/승격을 자동 확정하지 않는다.
// INVARIANT #2: codex 출력은 Proposal(draft) → 사람 accept해야 (로컬) 반영. accept 전 GitHub 절대 무변경.
//   accept도 GitHub를 mutate하지 않는다(로컬 self-check 표시 + acceptances 기록만; 제출은 사람 수동).
// INVARIANT #5: bounds 강제(JobManager timeout/kill + codex max_turns/cost_cap). #6: read_only + worktree 격리.

/// codex에 넘기는 self-check 초안 프롬프트(상수 — diff는 cwd의 `pr.diff` 파일로 전달, 인젝션 없음).
/// 엄격 JSON 하나만 마지막 메시지로 요구한다(프롬프트 지시 JSON — 사용자 결정).
/// pub(crate): 스킬 레지스트리(skills.rs) 시드 + 잡 lookup 폴백의 단일 출처(SSOT).
pub(crate) const PR_SELFCHECK_PROMPT: &str = "\
당신은 PR self-check 초안 도우미다. 작업 디렉터리의 `pr.diff` 파일에 GitHub PR의 unified diff가 있다. \
이 diff를 read-only로 분석하라(필요하면 현재 레포 코드도 참고). \
어떤 파일도 수정하지 말고 외부 네트워크/명령도 쓰지 마라(read-only). \
분석 결과를 아래 형식의 JSON 객체 **하나만** 마지막 메시지로 출력하라(코드펜스·설명 없이 순수 JSON):\n\
{\
\"summary\": \"PR 변경 요약/설명 초안(한국어 2~4문장)\", \
\"selfChecks\": [{\"item\": \"리뷰어가 확인할 self-check 항목\", \"checked\": false, \"note\": \"선택 메모\"}], \
\"screenshotsNeeded\": [\"스크린샷이 필요한 UI 변경 설명\"], \
\"migrationNotes\": [\"DB 마이그레이션/배포 시 주의할 점\"]\
}\n\
확신할 수 없는 항목은 빈 배열로 두라. checked는 항상 false로 두라(사람이 확인한다).";

/// repo_full_name + (선택)project_id로 self-check 잡 대상 레포를 해석한다.
/// worktree 격리(INVARIANT #6)를 위해 local_path가 필수고, diff fetch용 GitHub 토큰(keychain)도 함께 돌려준다.
/// 반환: (repo_id, local_path, project_id, github_token).
async fn resolve_selfcheck_repo(
    db: &Db,
    project_id: Option<&str>,
    repo_full_name: &str,
) -> Result<(String, String, String, String), String> {
    // (repo_id, remote_url, local_path, project_id, credential_ref)
    type RepoRow = (String, Option<String>, Option<String>, String, String);
    let rows: Vec<RepoRow> = if let Some(pid) = project_id {
        sqlx::query_as(
            "SELECT r.id, r.remote_url, r.local_path, r.project_id, p.credential_ref \
                 FROM repos r JOIN projects p ON p.id = r.project_id \
                 WHERE r.provider = 'github' AND r.enabled = 1 AND r.project_id = ?1 \
                 ORDER BY r.created_at",
        )
        .bind(pid)
        .fetch_all(db)
        .await
    } else {
        sqlx::query_as(
            "SELECT r.id, r.remote_url, r.local_path, r.project_id, p.credential_ref \
                 FROM repos r JOIN projects p ON p.id = r.project_id \
                 WHERE r.provider = 'github' AND r.enabled = 1 ORDER BY r.created_at",
        )
        .fetch_all(db)
        .await
    }
    .map_err(|e| e.to_string())?;

    for (repo_id, remote_url, local_path, pid, cref) in rows {
        let Some(url) = remote_url else { continue };
        let Some((owner, repo)) = crate::github::parse_owner_repo(&url) else {
            continue;
        };
        if !format!("{owner}/{repo}").eq_ignore_ascii_case(repo_full_name) {
            continue;
        }
        // worktree 격리(INVARIANT #6)에 local_path 필수.
        let local_path = local_path.filter(|p| !p.trim().is_empty()).ok_or(
            "self-check 초안은 local_path가 설정된 레포에서만 가능합니다(설정에서 로컬 경로 추가).",
        )?;
        let token = keychain::get_token(&cref, TokenKind::Github)
            .map_err(|e| e.to_string())?
            .ok_or("GitHub 토큰이 없음(설정에서 토큰 저장 필요)")?;
        return Ok((repo_id, local_path, pid, token));
    }
    Err(format!(
        "{repo_full_name} 에 매칭되는 enabled GitHub 레포를 찾을 수 없습니다."
    ))
}

/// PR self-check 초안 잡 트리거(PR Radar 카드에서). diff를 GitHub에서 받아(read) worktree 격리 codex
/// 잡(read_only)을 띄운다. 산출 Proposal은 awaiting_approval로 멈추고 사람 accept 전엔 외부 무변경(INVARIANT #2).
#[tauri::command]
#[specta::specta]
pub async fn trigger_pr_selfcheck(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerPrSelfCheckInput,
) -> Result<String, String> {
    // graceful degrade: codex 미설치/미인증이면 잡을 만들지 않는다.
    let Some(codex_bin) = jm.codex_bin.clone() else {
        return Err("codex CLI를 찾을 수 없습니다 — 설치 후 재시작하세요.".into());
    };
    let avail = codex_availability(Some(&codex_bin)).await;
    if !avail.authed {
        return Err(avail.detail);
    }

    let (repo_id, local_path, project_id, gh_token) = resolve_selfcheck_repo(
        db.inner(),
        input.project_id.as_deref(),
        &input.repo_full_name,
    )
    .await?;

    // PR diff fetch(read 레일, bounded retry). 트리거 시점에 받아 실패를 즉시 노출한다(삼키지 않음).
    let provider = HttpPrProvider::new(&gh_token).map_err(|e| e.to_string())?;
    let diff = provider
        .fetch_pr_diff(&input.repo_full_name, input.pr_number as u64)
        .await
        .map_err(|e| format!("PR diff 가져오기 실패: {e}"))?;

    let id = new_run_id(db.inner()).await?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::json!({
        "prUrl": input.pr_url,
        "repoFullName": input.repo_full_name,
        "prNumber": input.pr_number,
    })
    .to_string();
    let workdir = jm.worktree_root.join(&id).to_string_lossy().into_owned();
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id: Some(project_id),
            engine: Engine::Codex,
            kind: "draft_pr_selfcheck".into(),
            rail: AgentRail::Suggestion,
            sandbox: Sandbox::ReadOnly,
            repo_id: Some(repo_id),
            workdir: Some(workdir),
            trigger: Some(trigger),
            retry_key: None,
            retry_count: 0,
            bounds,
            log_path: jm.log_path(&id).to_string_lossy().into_owned(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // 스킬 레지스트리 lookup(편집된 프롬프트) + 코드 상수 폴백(#21). *제안 내용*만 바뀐다 —
    // 잡은 여전히 gated(awaiting_approval)이고 accept는 로컬 기록만(#1/#2 구조적 불변).
    let prompt = resolve_prompt(db.inner(), BINDING_PR_SELFCHECK, PR_SELFCHECK_PROMPT).await;
    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        CodexRunner {
            codex_bin,
            run_id: id.clone(),
            prompt,
            sandbox: Sandbox::ReadOnly,
            rail: AgentRail::Suggestion,
            repo_path: Some(std::path::PathBuf::from(local_path)),
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: vec![("pr.diff".to_string(), diff)],
            model: crate::commands::nav::get_config(db.inner(), "agent.codex_model")
                .await
                .ok()
                .flatten(),
        },
        true, // 게이트 잡: 성공+proposal이면 awaiting_approval로 멈춘다(Acceptance 게이트).
    );
    Ok(id)
}

/// 잡의 proposal(JSON)을 타입 구조로 파싱해 돌려준다. codex 출력이 형식과 다르면(raw fallback) Err로
/// 노출(조용한 빈 proposal 금지). awaiting_approval 잡의 Proposal 패널이 소비한다.
#[tauri::command]
#[specta::specta]
pub async fn pr_proposal(
    db: State<'_, Db>,
    run_id: String,
) -> Result<crate::models::PrSelfCheckProposal, String> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT proposal FROM agent_runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_optional(db.inner())
            .await
            .map_err(|e| e.to_string())?;
    let raw = row
        .ok_or("잡을 찾을 수 없음")?
        .0
        .ok_or("아직 proposal이 없습니다(잡이 끝나지 않았거나 산출물 없음).")?;
    parse_pr_proposal(&raw)
}

/// proposal JSON → 타입. raw fallback(`{"raw":...}`)이면 codex 출력이 형식과 달랐다는 뜻이라 Err로 노출.
fn parse_pr_proposal(raw: &str) -> Result<crate::models::PrSelfCheckProposal, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("proposal JSON 파싱 실패: {e}"))?;
    if let Some(raw_msg) = v.get("raw").and_then(|x| x.as_str()) {
        return Err(format!(
            "codex가 형식에 맞는 JSON을 내지 않았습니다. 원문:\n{raw_msg}"
        ));
    }
    serde_json::from_value(v).map_err(|e| format!("proposal 구조 불일치: {e}"))
}

/// accept 코어(테스트 가능). awaiting_approval 잡을 accept → acceptances 기록 + 로컬 self-check 표시 +
/// status=succeeded. **GitHub 등 외부는 절대 mutate하지 않는다**(제출은 사람 수동 — INVARIANT #2).
async fn execute_accept(
    db: &Db,
    run_id: &str,
    accepted_json: &str,
    trigger: Option<&str>,
) -> Result<(), sqlx::Error> {
    // append-only acceptances 행(외부 변경의 유일한 관문 — 이번 단계는 로컬 기록일 뿐).
    sqlx::query(
        "INSERT INTO acceptances (id, agent_run_id, accepted_fields, target) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, 'pr_self_check')",
    )
    .bind(run_id)
    .bind(accepted_json)
    .execute(db)
    .await?;

    // 로컬 효과: 해당 PR을 self-checked로 표시(로컬 상태 — pr_self_checks, Phase 4 재사용).
    if let Some(t) = trigger {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
            if let (Some(repo), Some(num)) = (
                v.get("repoFullName").and_then(|x| x.as_str()),
                v.get("prNumber").and_then(|x| x.as_u64()),
            ) {
                sqlx::query(
                    "INSERT OR IGNORE INTO pr_self_checks (id, repo_full_name, pr_number) \
                     VALUES (lower(hex(randomblob(16))), ?1, ?2)",
                )
                .bind(repo)
                .bind(num as i64)
                .execute(db)
                .await?;
            }
        }
    }

    // 잡을 succeeded로 마감(게이트 통과). awaiting_approval에서만 전이.
    sqlx::query(
        "UPDATE agent_runs SET status = 'succeeded', finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(run_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Proposal accept(INVARIANT #2 게이트). 사람이 (편집한) self-check/설명 초안을 accept하면 로컬에 반영하고
/// 잡을 succeeded로 마감한다. 외부 제출(GitHub)은 사람이 수동으로 — 여기서 mutate하지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn accept_proposal(
    db: State<'_, Db>,
    run_id: String,
    accepted: crate::models::PrSelfCheckProposal,
) -> Result<(), String> {
    // 상태 가드: awaiting_approval만 accept 가능(이미 처리/실행 중이면 거부).
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, trigger FROM agent_runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_optional(db.inner())
            .await
            .map_err(|e| e.to_string())?;
    let (status, trigger) = row.ok_or("잡을 찾을 수 없음")?;
    if status != "awaiting_approval" {
        return Err(format!("accept 가능한 상태가 아닙니다(현재: {status})."));
    }
    let accepted_json = serde_json::to_string(&accepted).map_err(|e| e.to_string())?;
    execute_accept(db.inner(), &run_id, &accepted_json, trigger.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Proposal reject(폐기). awaiting_approval 잡을 cancelled로 마감한다(acceptances 기록 없음, 외부 무변경).
#[tauri::command]
#[specta::specta]
pub async fn reject_proposal(db: State<'_, Db>, run_id: String) -> Result<(), String> {
    let res = sqlx::query(
        "UPDATE agent_runs SET status = 'cancelled', \
            result = json_object('error', '사용자가 제안을 폐기(reject)함'), \
            finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(&run_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;
    if res.rows_affected() == 0 {
        return Err("reject 가능한 상태가 아닙니다(awaiting_approval 아님).".into());
    }
    Ok(())
}

// ── Phase 9: 추가 suggestion 자동화 (enrich / CI triage) ──────────────
//
// 모두 제안 레일 + Acceptance 게이트(Phase 8 PR self-check 패턴 재사용). codex 출력은 Proposal(draft)일
// 뿐이고 사람이 accept해야 (로컬) 반영된다 — 외부(Notion/GitHub) 직접 mutate 없음(INVARIANT #2).
// INVARIANT #1: enrich는 quadrant를 자동 확정하지 않는다(suggested_*는 힌트, accept해도 카드는 unclassified).
// INVARIANT #5: CI triage 재트리거는 retry_key 체인 수를 캡하고 초과 시 Q1 escalate(사람).

/// codex 미설치/미인증이면 Err(graceful degrade 게이트). Phase 9 트리거들이 공유한다.
async fn require_codex(jm: &JobManager) -> Result<std::path::PathBuf, String> {
    let Some(codex_bin) = jm.codex_bin.clone() else {
        return Err("codex CLI를 찾을 수 없습니다 — 설치 후 재시작하세요.".into());
    };
    let avail = codex_availability(Some(&codex_bin)).await;
    if !avail.authed {
        return Err(avail.detail);
    }
    Ok(codex_bin)
}

/// awaiting_approval 잡의 (status, trigger). accept 상태 가드 공유.
async fn run_status_trigger(db: &Db, run_id: &str) -> Result<(String, Option<String>), String> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, trigger FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.ok_or_else(|| "잡을 찾을 수 없음".to_string())
}

/// 잡의 proposal JSON 원문. 없으면 Err(아직 산출물 없음).
async fn run_proposal_raw(db: &Db, run_id: &str) -> Result<String, String> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT proposal FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.ok_or("잡을 찾을 수 없음")?
        .0
        .ok_or_else(|| "아직 proposal이 없습니다(잡이 끝나지 않았거나 산출물 없음).".to_string())
}

/// raw fallback(`{"raw":...}`) 가드 후 타입 파싱(Phase 8 parse_pr_proposal 일반화). codex가 형식 밖
/// 출력(또는 닫힌 세트 밖 값)을 내면 Err로 노출한다(조용한 빈 proposal 금지 — INVARIANT #2 정신).
fn parse_proposal<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("proposal JSON 파싱 실패: {e}"))?;
    if let Some(raw_msg) = v.get("raw").and_then(|x| x.as_str()) {
        return Err(format!(
            "codex가 형식에 맞는 JSON을 내지 않았습니다. 원문:\n{raw_msg}"
        ));
    }
    serde_json::from_value(v).map_err(|e| format!("proposal 구조 불일치: {e}"))
}

/// 공통 accept 마감: append-only acceptances 행 + 잡 succeeded(awaiting_approval에서만 전이).
/// **외부(Notion/GitHub)는 어떤 호출도 없다** — 로컬 기록일 뿐(INVARIANT #2). 특수 로컬 효과는 호출자가.
async fn record_acceptance(
    db: &Db,
    run_id: &str,
    target: &str,
    accepted_json: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO acceptances (id, agent_run_id, accepted_fields, target) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3)",
    )
    .bind(run_id)
    .bind(accepted_json)
    .bind(target)
    .execute(db)
    .await?;
    sqlx::query(
        "UPDATE agent_runs SET status = 'succeeded', finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(run_id)
    .execute(db)
    .await?;
    Ok(())
}

/// trigger JSON에서 문자열 필드 추출(없으면 None).
fn trigger_field(trigger: Option<&str>, key: &str) -> Option<String> {
    let t = trigger?;
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

// ── enrich (braindump suggestedQuadrant + suggestedArea, #2) ──────────────────────

/// enrich 프롬프트(상수 — 카드 텍스트는 cwd `card.txt`로 전달, 인젝션 없음). 닫힌 세트만 허용을 명시한다.
/// pub(crate): 스킬 레지스트리 시드 + 잡 lookup 폴백의 단일 출처.
pub(crate) const ENRICH_PROMPT: &str = "\
당신은 개인 업무 카드 분류 **제안** 도우미다. 작업 디렉터리의 `card.txt`에 한 줄짜리 업무 메모(브레인덤프)가 있다. \
이 메모를 read-only로 읽고, 아래 형식의 JSON 객체 **하나만** 마지막 메시지로 출력하라(코드펜스·설명 없이 순수 JSON):\n\
{\
\"suggestedQuadrant\": \"q1_do_now|q2_schedule|q3_quick_contain|q4_drop|unclassified 중 하나\", \
\"suggestedArea\": \"health|work|studies|environment|recreation|romance|family|friends|finances|other 중 하나\", \
\"reason\": \"한국어 한 문장 근거\"\
}\n\
규칙: suggestedArea는 위 10개 라이프 도메인 **세트 안에서만** 고른다(세트 밖 카테고리 생성 금지). \
이건 **제안(힌트)일 뿐**이고 실제 분류/확정은 사람이 한다 — 너는 절대 단정하지 마라. \
애매하면 suggestedQuadrant는 \"unclassified\"로 둔다.";

/// braindump enrich 잡 트리거(미분류 카드 ⋯ 메뉴). 카드 텍스트를 읽어 suggestedQuadrant/suggestedArea를
/// **제안**한다(비-레포 잡·read_only). 산출 Proposal은 awaiting_approval로 멈추고, accept해도 quadrant는
/// 자동 확정되지 않는다(INVARIANT #1). 미설치/미인증이면 Err(graceful degrade).
#[tauri::command]
#[specta::specta]
pub async fn trigger_enrich(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerEnrichInput,
) -> Result<String, String> {
    let codex_bin = require_codex(&jm).await?;

    // 카드 본문 로드(제목+본문). codex 입력 파일로 넘긴다(인젝션 없음).
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT title, body, project_id FROM signals WHERE id = ?1")
            .bind(&input.signal_id)
            .fetch_optional(db.inner())
            .await
            .map_err(|e| e.to_string())?;
    let (title, body, project_id) = row.ok_or("신호를 찾을 수 없음")?;
    let card_text = match body.filter(|b| !b.trim().is_empty()) {
        Some(b) => format!("{title}\n\n{b}"),
        None => title,
    };

    let id = new_run_id(db.inner()).await?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::json!({ "signalId": input.signal_id }).to_string();
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id,
            engine: Engine::Codex,
            kind: "enrich_braindump".into(),
            rail: AgentRail::Suggestion,
            sandbox: Sandbox::ReadOnly,
            repo_id: None,
            workdir: None,
            trigger: Some(trigger),
            retry_key: None,
            retry_count: 0,
            bounds,
            log_path: jm.log_path(&id).to_string_lossy().into_owned(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // 스킬 레지스트리 lookup + 코드 상수 폴백(#21). 제안 내용만 바뀐다(잡 게이트/accept 불변 — #1/#2).
    let prompt = resolve_prompt(db.inner(), BINDING_ENRICH, ENRICH_PROMPT).await;
    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        CodexRunner {
            codex_bin,
            run_id: id.clone(),
            prompt,
            sandbox: Sandbox::ReadOnly,
            rail: AgentRail::Suggestion,
            repo_path: None,
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: vec![("card.txt".to_string(), card_text)],
            model: crate::commands::nav::get_config(db.inner(), "agent.codex_model")
                .await
                .ok()
                .flatten(),
        },
        true, // 게이트 잡: 성공+proposal이면 awaiting_approval(Acceptance 게이트).
    );
    Ok(id)
}

/// enrich Proposal(타입 파싱). raw/세트 밖 값이면 Err(조용한 빈 proposal 금지 + 닫힌 세트 강제).
#[tauri::command]
#[specta::specta]
pub async fn enrich_proposal(db: State<'_, Db>, run_id: String) -> Result<EnrichProposal, String> {
    let raw = run_proposal_raw(db.inner(), &run_id).await?;
    parse_proposal::<EnrichProposal>(&raw)
}

/// enrich accept 코어(테스트 가능). 신호에 suggested_quadrant/suggested_area/suggestion_reason을
/// **힌트로만** 쓴다 — quadrant/area(확정값)는 절대 건드리지 않는다(INVARIANT #1). 사분면 확정은
/// classify_signal, area 확정은 set_signal_area로만(사람 결정).
async fn execute_accept_enrich(
    db: &Db,
    run_id: &str,
    signal_id: &str,
    accepted: &EnrichProposal,
    accepted_json: &str,
) -> Result<WorkSignal, sqlx::Error> {
    let sig = sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET suggested_quadrant = ?2, suggested_area = ?3, suggestion_reason = ?4, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(signal_id)
    .bind(accepted.suggested_quadrant)
    .bind(accepted.suggested_area)
    .bind(&accepted.reason)
    .fetch_one(db)
    .await?;
    record_acceptance(db, run_id, "enrich_braindump", accepted_json).await?;
    Ok(sig)
}

/// enrich Proposal accept(INVARIANT #1/#2 게이트). 사람이 (편집한) 제안을 accept하면 신호에 힌트로 반영하고
/// 잡을 succeeded로 마감한다. **quadrant는 자동 확정되지 않는다**(카드는 unclassified 유지).
#[tauri::command]
#[specta::specta]
pub async fn accept_enrich(
    db: State<'_, Db>,
    run_id: String,
    accepted: EnrichProposal,
) -> Result<WorkSignal, String> {
    let (status, trigger) = run_status_trigger(db.inner(), &run_id).await?;
    if status != "awaiting_approval" {
        return Err(format!("accept 가능한 상태가 아닙니다(현재: {status})."));
    }
    let signal_id =
        trigger_field(trigger.as_deref(), "signalId").ok_or("잡 트리거에 signalId가 없음")?;
    let accepted_json = serde_json::to_string(&accepted).map_err(|e| e.to_string())?;
    execute_accept_enrich(db.inner(), &run_id, &signal_id, &accepted, &accepted_json)
        .await
        .map_err(|e| e.to_string())
}

/// 라이프 도메인 area 확정/수정(사람 결정 — 별개 축, quadrant 결정 레일과 무관). enrich 제안을 사람이
/// 확정하거나 직접 고른다. None이면 미설정으로 되돌린다.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_area(
    db: State<'_, Db>,
    id: String,
    area: Option<AreaTag>,
) -> Result<WorkSignal, String> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET area = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(area)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())
}

// ── 배치 enrich (#4, 미분류 전체 일괄 제안 — 단일 codex 잡, 부분 실패 격리) ──────────────
//
// INVARIANT #1: 배치 enrich도 suggested_*만 — quadrant 자동 확정 0(accept해도 카드는 unclassified).
// INVARIANT #2: Acceptance 게이트(awaiting_approval) 통과 후에만 (로컬) 반영, 외부 무변경.
// INVARIANT #5: 단일 잡 bound(timeout/max_turns/cost_cap). 카드 N개를 한 호출로 묶어 잡 폭주 방지.

/// 배치 enrich 프롬프트(상수 — 카드 목록은 cwd `cards.json`으로 전달, 인젝션 없음). 닫힌 세트만 허용 +
/// **JSON 배열이 아니라 객체**로 감싸 출력하게 한다(러너의 proposal_from_message는 객체만 보존).
/// pub(crate): 스킬 레지스트리 시드 + 잡 lookup 폴백의 단일 출처.
pub(crate) const BATCH_ENRICH_PROMPT: &str = "\
당신은 개인 업무 카드 분류 **제안** 도우미다. 작업 디렉터리의 `cards.json`에 미분류 업무 카드 배열이 \
있다(각 항목 `{\"id\": \"...\", \"title\": \"...\"}`). 각 카드를 read-only로 읽고, 아래 형식의 JSON 객체 \
**하나만** 마지막 메시지로 출력하라(코드펜스·설명 없이 순수 JSON):\n\
{\"items\": [{\
\"id\": \"입력의 카드 id 그대로\", \
\"suggestedQuadrant\": \"q1_do_now|q2_schedule|q3_quick_contain|q4_drop|unclassified 중 하나\", \
\"suggestedArea\": \"health|work|studies|environment|recreation|romance|family|friends|finances|other 중 하나\", \
\"reason\": \"한국어 한 문장 근거\"\
}]}\n\
규칙: items의 id는 입력 cards.json의 id를 **정확히 그대로** 쓴다(새로 만들지 마라). suggestedArea는 위 \
10개 라이프 도메인 **세트 안에서만** 고른다(세트 밖 카테고리 생성 금지). 이건 **제안(힌트)일 뿐**이고 \
실제 분류/확정은 사람이 한다 — 너는 절대 단정하지 마라. 애매하면 suggestedQuadrant는 \"unclassified\"로 둔다. \
모든 카드를 빠짐없이 items에 포함하라.";

/// project_id로 한정(또는 전체)된 미분류 active 신호 (배치 enrich 대상). today 레일·done/archived/snoozed 제외.
async fn fetch_unclassified_for_enrich(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    if let Some(pid) = project_id {
        sqlx::query_as(
            "SELECT id, title FROM signals \
             WHERE quadrant = 'unclassified' AND today_for_date IS NULL \
               AND status NOT IN ('done','archived','snoozed') AND project_id = ?1 \
             ORDER BY created_at",
        )
        .bind(pid)
        .fetch_all(db)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, title FROM signals \
             WHERE quadrant = 'unclassified' AND today_for_date IS NULL \
               AND status NOT IN ('done','archived','snoozed') \
             ORDER BY created_at",
        )
        .fetch_all(db)
        .await
    }
}

/// 미분류 전체 배치 enrich 잡 트리거(미분류 영역 "전체 제안 실행"). 모든 미분류 카드를 `cards.json`
/// 배열로 모아 **한** codex 호출(비-레포·read_only)로 카드별 suggested 힌트를 제안한다. 산출 Proposal은
/// awaiting_approval로 멈추고(Acceptance 게이트), accept해도 quadrant는 자동 확정되지 않는다(INVARIANT #1).
/// 대상이 없으면 잡을 만들지 않고 Err. 미설치/미인증이면 Err(graceful degrade).
#[tauri::command]
#[specta::specta]
pub async fn trigger_enrich_all(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerEnrichAllInput,
) -> Result<String, String> {
    let codex_bin = require_codex(&jm).await?;

    let cards = fetch_unclassified_for_enrich(db.inner(), input.project_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    if cards.is_empty() {
        return Err("미분류 카드가 없습니다.".into());
    }

    // codex 입력 파일(인젝션 없음 — 카드는 데이터 파일로만 전달).
    let cards_json = serde_json::Value::Array(
        cards
            .iter()
            .map(|(id, title)| serde_json::json!({ "id": id, "title": title }))
            .collect(),
    )
    .to_string();

    let id = new_run_id(db.inner()).await?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::json!({ "batchCount": cards.len() as u32 }).to_string();
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id: input.project_id.clone(),
            engine: Engine::Codex,
            kind: "enrich_batch".into(),
            rail: AgentRail::Suggestion,
            sandbox: Sandbox::ReadOnly,
            repo_id: None,
            workdir: None,
            trigger: Some(trigger),
            retry_key: None,
            retry_count: 0,
            bounds,
            log_path: jm.log_path(&id).to_string_lossy().into_owned(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // 스킬 레지스트리 lookup + 코드 상수 폴백(#21). 제안 내용만 바뀐다(잡 게이트/accept 불변 — #1/#2).
    let prompt = resolve_prompt(db.inner(), BINDING_BATCH_ENRICH, BATCH_ENRICH_PROMPT).await;
    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        CodexRunner {
            codex_bin,
            run_id: id.clone(),
            prompt,
            sandbox: Sandbox::ReadOnly,
            rail: AgentRail::Suggestion,
            repo_path: None,
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: vec![("cards.json".to_string(), cards_json)],
            model: crate::commands::nav::get_config(db.inner(), "agent.codex_model")
                .await
                .ok()
                .flatten(),
        },
        true, // 게이트 잡: 성공+proposal이면 awaiting_approval(Acceptance 게이트).
    );
    Ok(id)
}

/// 배치 proposal 원문(JSON 객체 `{"items":[...]}`)을 카드별로 검증해 BatchEnrichProposal로 만든다.
/// 부분 실패 격리: id 비거나 현재 미분류 active 신호에 없거나 닫힌 세트 밖이면 그 항목만 skip + skipped++.
/// (제목은 현재 신호에서 채운다 — codex 출력의 제목은 신뢰하지 않는다.) raw fallback이면 Err(조용한 빈 X).
fn build_batch_proposal(
    raw: &str,
    valid: &std::collections::HashMap<String, String>,
) -> Result<BatchEnrichProposal, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("proposal JSON 파싱 실패: {e}"))?;
    if let Some(raw_msg) = v.get("raw").and_then(|x| x.as_str()) {
        return Err(format!(
            "codex가 형식에 맞는 JSON을 내지 않았습니다. 원문:\n{raw_msg}"
        ));
    }
    let arr = v
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "proposal에 items 배열이 없습니다.".to_string())?;

    let mut items: Vec<BatchEnrichItem> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped: u32 = 0;
    for entry in arr {
        // 닫힌 세트(Quadrant/AreaTag) 밖이거나 형식 밖이면 카드 단위로 skip(부분 실패 격리).
        let Ok(item) = serde_json::from_value::<BatchEnrichItem>(entry.clone()) else {
            skipped = skipped.saturating_add(1);
            continue;
        };
        // 미존재/중복 id는 skip(현재 미분류 active 신호에만 적용).
        match valid.get(&item.id) {
            Some(title) if seen.insert(item.id.clone()) => {
                items.push(BatchEnrichItem {
                    id: item.id,
                    title: Some(title.clone()),
                    suggested_quadrant: item.suggested_quadrant,
                    suggested_area: item.suggested_area,
                    reason: item.reason,
                });
            }
            _ => skipped = skipped.saturating_add(1),
        }
    }
    Ok(BatchEnrichProposal { items, skipped })
}

/// 배치 enrich Proposal(타입 파싱 + 카드별 검증). 현재 미분류 active 신호와 교차검증해 유효 항목만 남기고
/// 나머지는 skipped로 격리한다(부분 실패 격리). raw/형식 밖이면 Err.
#[tauri::command]
#[specta::specta]
pub async fn batch_enrich_proposal(
    db: State<'_, Db>,
    run_id: String,
) -> Result<BatchEnrichProposal, String> {
    let raw = run_proposal_raw(db.inner(), &run_id).await?;
    // 잡의 project_id 한정으로 현재 미분류 신호를 다시 모아 검증 기준으로 쓴다(잡 이후 변화 반영).
    let pid: Option<(Option<String>,)> =
        sqlx::query_as("SELECT project_id FROM agent_runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_optional(db.inner())
            .await
            .map_err(|e| e.to_string())?;
    let project_id = pid.and_then(|r| r.0);
    let valid: std::collections::HashMap<String, String> =
        fetch_unclassified_for_enrich(db.inner(), project_id.as_deref())
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
    build_batch_proposal(&raw, &valid)
}

/// 배치 enrich accept 코어(테스트 가능). items의 카드마다 suggested_* 힌트만 쓴다 — quadrant/area(확정값)는
/// 절대 건드리지 않는다(INVARIANT #1). 적용한 카드 수를 돌려준다. 외부 호출 없음(로컬 기록만).
async fn execute_accept_enrich_all(
    db: &Db,
    run_id: &str,
    accepted: &BatchEnrichProposal,
    accepted_json: &str,
) -> Result<u32, sqlx::Error> {
    let mut applied: u32 = 0;
    for item in &accepted.items {
        // 힌트만 반영. quadrant/area 확정값은 건드리지 않는다(set_quadrant/set_signal_area = 사람 결정).
        let res = sqlx::query(
            "UPDATE signals SET suggested_quadrant = ?2, suggested_area = ?3, suggestion_reason = ?4, \
                updated_at = datetime('now') \
             WHERE id = ?1 AND quadrant = 'unclassified'",
        )
        .bind(&item.id)
        .bind(item.suggested_quadrant)
        .bind(item.suggested_area)
        .bind(&item.reason)
        .execute(db)
        .await?;
        applied = applied.saturating_add(res.rows_affected() as u32);
    }
    record_acceptance(db, run_id, "enrich_batch", accepted_json).await?;
    Ok(applied)
}

/// 배치 enrich Proposal accept(INVARIANT #1/#2 게이트). 사람이 (편집한) 카드별 제안을 accept하면 각 신호에
/// 힌트로만 반영하고 잡을 succeeded로 마감한다. **quadrant는 자동 확정되지 않는다**(카드는 unclassified 유지).
#[tauri::command]
#[specta::specta]
pub async fn accept_enrich_all(
    db: State<'_, Db>,
    run_id: String,
    accepted: BatchEnrichProposal,
) -> Result<u32, String> {
    let (status, _trigger) = run_status_trigger(db.inner(), &run_id).await?;
    if status != "awaiting_approval" {
        return Err(format!("accept 가능한 상태가 아닙니다(현재: {status})."));
    }
    let accepted_json = serde_json::to_string(&accepted).map_err(|e| e.to_string())?;
    execute_accept_enrich_all(db.inner(), &run_id, &accepted, &accepted_json)
        .await
        .map_err(|e| e.to_string())
}

// ── CI triage (#3, 재트리거 캡 + Q1 escalate) ───────────────────────────────────────

/// 같은 PR CI 실패를 재triage할 수 있는 최대 횟수(INVARIANT #5). 초과 시 사람에게 Q1 escalate.
const TRIAGE_RETRY_CAP: i64 = 3;

/// CI triage 프롬프트(상수 — PR diff는 cwd `pr.diff`로 전달, 인젝션 없음).
/// pub(crate): 스킬 레지스트리 시드 + 잡 lookup 폴백의 단일 출처.
pub(crate) const CI_TRIAGE_PROMPT: &str = "\
당신은 CI 실패 triage **제안** 도우미다. 작업 디렉터리의 `pr.diff`에 CI가 실패한 PR의 unified diff가 있다. \
이 diff를 read-only로 분석하라(필요하면 현재 레포 코드도 참고). 어떤 파일도 수정하지 말고 외부 명령도 쓰지 마라. \
실패 원인 가설과 수정안을 아래 형식의 JSON 객체 **하나만** 마지막 메시지로 출력하라(순수 JSON):\n\
{\
\"cause\": \"CI 실패의 가장 그럴듯한 원인 가설(한국어)\", \
\"suggestedFixes\": [\"구체적 수정안 항목\"], \
\"summary\": \"한국어 2~3문장 요약\"\
}\n\
이건 제안일 뿐이다 — 실제 수정/적용은 사람이 결정한다.";

/// retry_key 체인의 기존 triage 잡 수(캡 판정 입력).
async fn count_triage_runs(db: &Db, retry_key: &str) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM agent_runs WHERE retry_key = ?1 AND kind = 'triage_ci'",
    )
    .bind(retry_key)
    .fetch_one(db)
    .await?;
    Ok(row.0)
}

/// 재트리거 캡 초과 시 매트릭스로 Q1 escalate(사람 개입). dedup upsert(중복 0) + 항상 unclassified 진입 +
/// suggested q1 힌트만(INVARIANT #1 — 자동 분류 아님). type=agent_alert(시스템 신호).
async fn escalate_triage_to_q1(
    db: &Db,
    project_id: Option<&str>,
    repo_full_name: &str,
    pr_number: u32,
    pr_url: &str,
    retry_key: &str,
) -> Result<(), sqlx::Error> {
    let title = format!(
        "[{repo_full_name}] PR #{pr_number} CI triage {TRIAGE_RETRY_CAP}회 초과 — 사람 개입 필요"
    );
    let body = format!(
        "{pr_url} · 자동 CI triage가 캡({TRIAGE_RETRY_CAP})에 도달했습니다. 직접 확인하세요."
    );
    let dedup = format!("{retry_key}:escalated");
    let links = serde_json::json!({ "githubPrUrl": pr_url }).to_string();
    sqlx::query(
        "INSERT INTO signals \
            (id, project_id, title, body, source, type, quadrant, suggested_quadrant, dedup_key, status, links) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'system', 'agent_alert', \
                 'unclassified', 'q1_do_now', ?4, 'new', ?5) \
         ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET \
            title = excluded.title, body = excluded.body, links = excluded.links, \
            suggested_quadrant = excluded.suggested_quadrant, updated_at = datetime('now')",
    )
    .bind(project_id)
    .bind(&title)
    .bind(&body)
    .bind(&dedup)
    .bind(&links)
    .execute(db)
    .await?;
    Ok(())
}

/// CI triage 잡 트리거(PR Radar CI Blocked 카드). diff를 GitHub에서 받아 worktree 격리 codex 잡(read_only).
/// **재트리거 캡**(INVARIANT #5): 같은 PR(retry_key=triage:{repo}:{pr})의 기존 triage가 캡 이상이면 잡을
/// 만들지 않고 매트릭스 Q1으로 escalate한다. 산출 Proposal은 awaiting_approval(Acceptance 게이트).
#[tauri::command]
#[specta::specta]
pub async fn trigger_ci_triage(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerCiTriageInput,
) -> Result<TriageOutcome, String> {
    let codex_bin = require_codex(&jm).await?;

    let retry_key = format!("triage:{}:{}", input.repo_full_name, input.pr_number);
    // 재트리거 캡: 초과면 잡 대신 Q1 escalate(사람).
    let prior = count_triage_runs(db.inner(), &retry_key)
        .await
        .map_err(|e| e.to_string())?;
    if prior >= TRIAGE_RETRY_CAP {
        escalate_triage_to_q1(
            db.inner(),
            input.project_id.as_deref(),
            &input.repo_full_name,
            input.pr_number,
            &input.pr_url,
            &retry_key,
        )
        .await
        .map_err(|e| e.to_string())?;
        return Ok(TriageOutcome {
            run_id: None,
            escalated: true,
            detail: format!(
                "CI triage가 캡({TRIAGE_RETRY_CAP})에 도달 — 매트릭스 Q1으로 escalate(사람 개입)."
            ),
        });
    }

    let (repo_id, local_path, project_id, gh_token) = resolve_selfcheck_repo(
        db.inner(),
        input.project_id.as_deref(),
        &input.repo_full_name,
    )
    .await?;

    // PR diff fetch(read 레일, bounded retry). 트리거 시점에 받아 실패를 즉시 노출한다.
    let provider = HttpPrProvider::new(&gh_token).map_err(|e| e.to_string())?;
    let diff = provider
        .fetch_pr_diff(&input.repo_full_name, input.pr_number as u64)
        .await
        .map_err(|e| format!("PR diff 가져오기 실패: {e}"))?;

    let id = new_run_id(db.inner()).await?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::json!({
        "prUrl": input.pr_url,
        "repoFullName": input.repo_full_name,
        "prNumber": input.pr_number,
    })
    .to_string();
    let workdir = jm.worktree_root.join(&id).to_string_lossy().into_owned();
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id: Some(project_id),
            engine: Engine::Codex,
            kind: "triage_ci".into(),
            rail: AgentRail::Suggestion,
            sandbox: Sandbox::ReadOnly,
            repo_id: Some(repo_id),
            workdir: Some(workdir),
            trigger: Some(trigger),
            retry_key: Some(retry_key),
            retry_count: prior as u32,
            bounds,
            log_path: jm.log_path(&id).to_string_lossy().into_owned(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // 스킬 레지스트리 lookup + 코드 상수 폴백(#21). 제안 내용만 바뀐다(잡 게이트/accept 불변 — #1/#2).
    let prompt = resolve_prompt(db.inner(), BINDING_CI_TRIAGE, CI_TRIAGE_PROMPT).await;
    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        CodexRunner {
            codex_bin,
            run_id: id.clone(),
            prompt,
            sandbox: Sandbox::ReadOnly,
            rail: AgentRail::Suggestion,
            repo_path: Some(std::path::PathBuf::from(local_path)),
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: vec![("pr.diff".to_string(), diff)],
            model: crate::commands::nav::get_config(db.inner(), "agent.codex_model")
                .await
                .ok()
                .flatten(),
        },
        true,
    );
    Ok(TriageOutcome {
        run_id: Some(id),
        escalated: false,
        detail: format!("CI triage 잡 시작({}/{TRIAGE_RETRY_CAP}회).", prior + 1),
    })
}

/// CI triage Proposal(타입 파싱). raw면 Err.
#[tauri::command]
#[specta::specta]
pub async fn triage_proposal(
    db: State<'_, Db>,
    run_id: String,
) -> Result<CiTriageProposal, String> {
    let raw = run_proposal_raw(db.inner(), &run_id).await?;
    parse_proposal::<CiTriageProposal>(&raw)
}

/// CI triage Proposal accept(INVARIANT #2 게이트). 로컬 기록만(acceptances + 잡 succeeded) — 외부 무변경.
/// 실제 수정은 사람이 수동(또는 실행 레일 Phase 10).
#[tauri::command]
#[specta::specta]
pub async fn accept_triage(
    db: State<'_, Db>,
    run_id: String,
    accepted: CiTriageProposal,
) -> Result<(), String> {
    let (status, _trigger) = run_status_trigger(db.inner(), &run_id).await?;
    if status != "awaiting_approval" {
        return Err(format!("accept 가능한 상태가 아닙니다(현재: {status})."));
    }
    let accepted_json = serde_json::to_string(&accepted).map_err(|e| e.to_string())?;
    record_acceptance(db.inner(), &run_id, "triage_ci", &accepted_json)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signals::insert_signal;
    use crate::models::{Kind, Quadrant};

    /// awaiting_approval 잡 한 행을 직접 INSERT(테스트 픽스처). proposal/trigger 포함.
    async fn insert_awaiting_run(db: &Db, id: &str, proposal: &str, trigger: &str) {
        sqlx::query(
            "INSERT INTO agent_runs \
                (id, engine, kind, rail, trigger, sandbox, status, timeout_sec, max_turns, \
                 cost_cap_usd, proposal) \
             VALUES (?1, 'codex', 'draft_pr_selfcheck', 'suggestion', ?2, 'read_only', \
                     'awaiting_approval', 60, 8, 1.0, ?3)",
        )
        .bind(id)
        .bind(trigger)
        .bind(proposal)
        .execute(db)
        .await
        .unwrap();
    }

    /// raw fallback(`{"raw":...}`)은 Err로 노출(조용한 빈 proposal 금지), 정상 JSON은 파싱.
    #[test]
    fn parse_pr_proposal_rejects_raw_and_parses_object() {
        let ok =
            parse_pr_proposal(r#"{"summary":"바뀐 점","selfChecks":[{"item":"테스트"}]}"#).unwrap();
        assert_eq!(ok.summary, "바뀐 점");
        assert_eq!(ok.self_checks.len(), 1);
        assert!(!ok.self_checks[0].checked);
        // raw fallback → Err.
        let err = parse_pr_proposal(r#"{"raw":"엉뚱한 출력"}"#);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("엉뚱한 출력"));
    }

    /// accept = acceptances 1행 + 로컬 self-check 표시 + status=succeeded. 외부 변경 없음(구조적).
    #[tokio::test]
    async fn accept_records_acceptance_and_marks_self_check() {
        let db = fresh_db().await;
        let trigger =
            r#"{"prUrl":"https://github.com/o/r/pull/9","repoFullName":"o/r","prNumber":9}"#;
        insert_awaiting_run(&db, "a1", r#"{"summary":"x"}"#, trigger).await;

        // accept 전: acceptances 0건, self-check 0건(게이트 미통과).
        let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM acceptances")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(before.0, 0);

        let accepted = r#"{"summary":"확정된 설명","selfChecks":[{"item":"빌드","checked":true}]}"#;
        execute_accept(&db, "a1", accepted, Some(trigger))
            .await
            .unwrap();

        // acceptances 1행 + accepted_fields 보존.
        let row: (i64, String, String) =
            sqlx::query_as("SELECT COUNT(*), MAX(accepted_fields), MAX(target) FROM acceptances")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row.0, 1);
        assert!(row.1.contains("확정된 설명"));
        assert_eq!(row.2, "pr_self_check");
        // 로컬 self-check 표시(pr_self_checks).
        let sc: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM pr_self_checks WHERE repo_full_name='o/r' AND pr_number=9",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(sc.0, 1);
        // 잡은 succeeded로 마감.
        let st: (String,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='a1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, "succeeded");
    }

    /// reject = cancelled + acceptances 기록 없음(폐기).
    #[tokio::test]
    async fn reject_cancels_without_acceptance() {
        let db = fresh_db().await;
        insert_awaiting_run(&db, "r1", r#"{"summary":"x"}"#, "{}").await;
        // reject_proposal은 State를 받으므로 코어 SQL을 직접 검증(전이 + acceptances 0).
        sqlx::query(
            "UPDATE agent_runs SET status='cancelled' WHERE id='r1' AND status='awaiting_approval'",
        )
        .execute(&db)
        .await
        .unwrap();
        let st: (String,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, "cancelled");
        let acc: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM acceptances")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(acc.0, 0);
    }

    // ── Phase 9: enrich / CI triage ──────────────────────────────────

    /// enrich proposal: raw fallback과 닫힌 세트 밖 area는 Err(INVARIANT #1 구조적 강제), 누락은 관용.
    #[test]
    fn enrich_proposal_rejects_raw_and_out_of_set_area() {
        // codex가 형식 밖 출력 → raw fallback → Err.
        assert!(parse_proposal::<EnrichProposal>(r#"{"raw":"엉뚱한 출력"}"#).is_err());
        // 닫힌 세트 밖 area → Err (AI는 세트 밖 카테고리를 만들 수 없다).
        assert!(parse_proposal::<EnrichProposal>(r#"{"suggestedArea":"productivity"}"#).is_err());
        // 세트 안 + 일부 누락 관용.
        let ok = parse_proposal::<EnrichProposal>(r#"{"suggestedArea":"health"}"#).unwrap();
        assert!(matches!(ok.suggested_area, Some(AreaTag::Health)));
        assert!(ok.suggested_quadrant.is_none());
    }

    /// CI triage proposal: raw fallback은 Err, 정상 JSON은 파싱.
    #[test]
    fn triage_proposal_parses() {
        assert!(parse_proposal::<CiTriageProposal>(r#"{"raw":"x"}"#).is_err());
        let t = parse_proposal::<CiTriageProposal>(
            r#"{"cause":"타입 오류","suggestedFixes":["고치기"]}"#,
        )
        .unwrap();
        assert_eq!(t.cause, "타입 오류");
        assert_eq!(t.suggested_fixes.len(), 1);
    }

    /// INVARIANT #1: enrich accept는 suggested_* 힌트만 쓰고 quadrant(결정 레일)/area(확정값)는 안 건드린다.
    #[tokio::test]
    async fn enrich_accept_sets_hints_not_quadrant() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("히어로 카피 다시", Some(Kind::Work)))
            .await
            .unwrap();
        assert!(matches!(sig.quadrant, Quadrant::Unclassified));
        let trigger = serde_json::json!({ "signalId": sig.id }).to_string();
        let proposal =
            r#"{"suggestedQuadrant":"q1_do_now","suggestedArea":"work","reason":"마감 임박"}"#;
        insert_awaiting_run(&db, "e1", proposal, &trigger).await;

        let parsed = parse_proposal::<EnrichProposal>(proposal).unwrap();
        let accepted_json = serde_json::to_string(&parsed).unwrap();
        let updated = execute_accept_enrich(&db, "e1", &sig.id, &parsed, &accepted_json)
            .await
            .unwrap();

        // 힌트는 들어가고 quadrant는 unclassified로 남는다(자동 분류 0).
        assert!(
            matches!(updated.quadrant, Quadrant::Unclassified),
            "INVARIANT #1: quadrant 자동 확정 0"
        );
        assert_eq!(updated.suggested_quadrant.as_deref(), Some("q1_do_now"));
        assert!(matches!(updated.suggested_area, Some(AreaTag::Work)));
        // area(확정값)는 accept로 바뀌지 않는다(사람 set_signal_area로만).
        assert!(updated.area.is_none());

        // 잡 succeeded + acceptances 1행.
        let st: (String,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='e1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, "succeeded");
        let cnt: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM acceptances WHERE agent_run_id='e1' AND target='enrich_braindump'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(cnt.0, 1);
    }

    /// 배치 proposal: items 객체 파싱 + 카드별 검증(미존재/세트 밖/중복 skip), 제목은 신호에서 채움.
    #[test]
    fn batch_proposal_validates_and_isolates_partial_failure() {
        let mut valid = std::collections::HashMap::new();
        valid.insert("a".to_string(), "원두 주문".to_string());
        valid.insert("b".to_string(), "데모 준비".to_string());

        let raw = r#"{"items":[
            {"id":"a","suggestedQuadrant":"q1_do_now","suggestedArea":"work","reason":"마감"},
            {"id":"b","suggestedArea":"productivity"},
            {"id":"zzz","suggestedQuadrant":"q2_schedule"},
            {"id":"a","suggestedQuadrant":"q3_quick_contain"}
        ]}"#;
        let p = build_batch_proposal(raw, &valid).unwrap();
        // a만 유효: b=세트 밖 area, zzz=미존재, 둘째 a=중복 → 3건 skip.
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.skipped, 3);
        assert_eq!(p.items[0].id, "a");
        assert_eq!(p.items[0].title.as_deref(), Some("원두 주문")); // 제목은 신호에서.
        assert!(matches!(
            p.items[0].suggested_quadrant,
            Some(Quadrant::Q1DoNow)
        ));
        assert!(matches!(p.items[0].suggested_area, Some(AreaTag::Work)));

        // raw fallback / items 누락은 Err(조용한 빈 proposal 금지).
        assert!(build_batch_proposal(r#"{"raw":"엉뚱"}"#, &valid).is_err());
        assert!(build_batch_proposal(r#"{"foo":1}"#, &valid).is_err());
    }

    /// INVARIANT #1: 배치 accept는 카드별 suggested_* 힌트만 쓰고 quadrant(결정 레일)는 안 건드린다.
    #[tokio::test]
    async fn batch_accept_sets_hints_not_quadrant() {
        let db = fresh_db().await;
        let s1 = insert_signal(&db, &input("원두 주문", Some(Kind::Personal)))
            .await
            .unwrap();
        let s2 = insert_signal(&db, &input("데모 준비", Some(Kind::Work)))
            .await
            .unwrap();
        insert_awaiting_run(&db, "ba1", r#"{"items":[]}"#, "{}").await;

        let accepted = BatchEnrichProposal {
            items: vec![
                BatchEnrichItem {
                    id: s1.id.clone(),
                    title: Some("원두 주문".into()),
                    suggested_quadrant: Some(Quadrant::Q3QuickContain),
                    suggested_area: Some(AreaTag::Finances),
                    reason: Some("간단".into()),
                },
                BatchEnrichItem {
                    id: s2.id.clone(),
                    title: Some("데모 준비".into()),
                    suggested_quadrant: Some(Quadrant::Q1DoNow),
                    suggested_area: Some(AreaTag::Work),
                    reason: None,
                },
            ],
            skipped: 0,
        };
        let accepted_json = serde_json::to_string(&accepted).unwrap();
        let applied = execute_accept_enrich_all(&db, "ba1", &accepted, &accepted_json)
            .await
            .unwrap();
        assert_eq!(applied, 2);

        // 두 카드 모두 힌트만 들어가고 quadrant는 unclassified로 남는다(자동 분류 0).
        for (id, q, area) in [
            (&s1.id, "q3_quick_contain", AreaTag::Finances),
            (&s2.id, "q1_do_now", AreaTag::Work),
        ] {
            let row: (String, Option<String>, Option<AreaTag>) = sqlx::query_as(
                "SELECT quadrant, suggested_quadrant, suggested_area FROM signals WHERE id = ?1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
            assert_eq!(row.0, "unclassified", "INVARIANT #1: quadrant 자동 확정 0");
            assert_eq!(row.1.as_deref(), Some(q));
            assert!(matches!(row.2, Some(a) if a as u8 == area as u8));
        }

        // 잡 succeeded + acceptances 1행(target=enrich_batch).
        let st: (String,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='ba1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, "succeeded");
        let cnt: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM acceptances WHERE agent_run_id='ba1' AND target='enrich_batch'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(cnt.0, 1);
    }

    /// INVARIANT #5: 같은 PR CI triage가 캡(3)에 도달하면 멈추고 Q1으로 escalate(unclassified + 힌트, dedup).
    #[tokio::test]
    async fn triage_cap_escalates_to_q1_unclassified() {
        let db = fresh_db().await;
        let retry_key = "triage:owner/repo:42";
        // 캡-1까지는 escalate 아님.
        sqlx::query(
            "INSERT INTO agent_runs (id, engine, kind, rail, sandbox, status, timeout_sec, max_turns, cost_cap_usd, retry_key, retry_count) \
             VALUES ('t0', 'codex', 'triage_ci', 'suggestion', 'read_only', 'succeeded', 60, 8, 1.0, ?1, 0)",
        )
        .bind(retry_key)
        .execute(&db)
        .await
        .unwrap();
        assert!(count_triage_runs(&db, retry_key).await.unwrap() < TRIAGE_RETRY_CAP);

        // 캡만큼 채운다.
        for i in 1..TRIAGE_RETRY_CAP {
            sqlx::query(
                "INSERT INTO agent_runs (id, engine, kind, rail, sandbox, status, timeout_sec, max_turns, cost_cap_usd, retry_key, retry_count) \
                 VALUES (?1, 'codex', 'triage_ci', 'suggestion', 'read_only', 'succeeded', 60, 8, 1.0, ?2, ?3)",
            )
            .bind(format!("t{i}"))
            .bind(retry_key)
            .bind(i)
            .execute(&db)
            .await
            .unwrap();
        }
        assert_eq!(
            count_triage_runs(&db, retry_key).await.unwrap(),
            TRIAGE_RETRY_CAP
        );

        // 캡 도달 → escalate. unclassified 진입 + suggested q1 힌트(자동 분류 0).
        escalate_triage_to_q1(
            &db,
            None,
            "owner/repo",
            42,
            "https://github.com/owner/repo/pull/42",
            retry_key,
        )
        .await
        .unwrap();
        let dedup = format!("{retry_key}:escalated");
        let row: (String, Option<String>, String) = sqlx::query_as(
            "SELECT quadrant, suggested_quadrant, type FROM signals WHERE dedup_key = ?1",
        )
        .bind(&dedup)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row.0, "unclassified", "INVARIANT #1: 자동 분류 0");
        assert_eq!(row.1.as_deref(), Some("q1_do_now"), "Q1 힌트만");
        assert_eq!(row.2, "agent_alert");

        // 재escalate(중복 트리거)는 dedup으로 1행 유지(INVARIANT #3).
        escalate_triage_to_q1(
            &db,
            None,
            "owner/repo",
            42,
            "https://github.com/owner/repo/pull/42",
            retry_key,
        )
        .await
        .unwrap();
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM signals WHERE dedup_key = ?1")
            .bind(&dedup)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n.0, 1, "dedup — 중복 0");
    }
}
