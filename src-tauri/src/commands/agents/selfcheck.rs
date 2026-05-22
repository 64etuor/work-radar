use tauri::State;

use crate::agent::{codex_availability, Bounds, CodexRunner};
use crate::commands::skills::{resolve_prompt, BINDING_PR_SELFCHECK};
use crate::db::Db;
use crate::error::AppError;
use crate::github::{HttpPrProvider, PrProvider};
use crate::jobs::{insert_agent_run, JobManager, NewAgentRun};
use crate::keychain;
use crate::models::{AgentRail, Engine, Sandbox, TokenKind, TriggerPrSelfCheckInput};

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
당신은 코드 리뷰 도우미다. 작업 디렉터리의 `pr.diff` 파일에 GitHub PR의 unified diff가 있다. \
이 diff를 read-only로 분석하라(필요하면 현재 레포 코드도 참고). \
어떤 파일도 수정하지 말고 외부 네트워크/명령도 쓰지 마라(read-only). \
스타일 지적이나 사소한 코드 취향 차이는 배제하라. \
핵심 질문: 이 변경이 **이 레포의 기존 패턴·모듈 경계·설계 규칙에 부합하는가?** \
구체적으로 — 모듈 경계 침범, INVARIANT 위반 위험(결정 레일 침범·토큰 렌더러 노출·무한 retry·migration 없는 스키마 변경 등), \
설계 일관성 문제, 하네스 적합성(Tauri 2/specta/octocrab 패턴 준수)을 중점 확인하라. \
분석 결과를 아래 형식의 JSON 객체 **하나만** 마지막 메시지로 출력하라(코드펜스·설명 없이 순수 JSON):\n\
{\
\"summary\": \"PR 변경 요약(한국어 2~4문장)\", \
\"selfChecks\": [{\"item\": \"구조적·설계적 리뷰 항목\", \"checked\": false, \"note\": \"선택 메모\"}], \
\"screenshotsNeeded\": [\"스크린샷이 필요한 UI 변경 설명\"], \
\"migrationNotes\": [\"DB 마이그레이션/배포 시 주의할 점\"]\
}\n\
확신할 수 없는 항목은 빈 배열로 두라. checked는 항상 false로 두라(사람이 확인한다). \
이건 제안일 뿐이다 — 실제 반영은 사람이 결정한다(INVARIANT #1/#2).";

/// repo_full_name + (선택)project_id로 self-check 잡 대상 레포를 해석한다.
/// worktree 격리(INVARIANT #6)를 위해 local_path가 필수고, diff fetch용 GitHub 토큰(keychain)도 함께 돌려준다.
/// 반환: (repo_id, local_path, project_id, github_token).
pub(super) async fn resolve_selfcheck_repo(
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
) -> Result<String, AppError> {
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

    let (repo_id, local_path, project_id, gh_token) = resolve_selfcheck_repo(
        db.inner(),
        input.project_id.as_deref(),
        &input.repo_full_name,
    )
    .await
    .map_err(|e| AppError::terminal("agents.selfcheck_repo", e))?;

    // PR diff fetch(read 레일, bounded retry). 트리거 시점에 받아 실패를 즉시 노출한다(삼키지 않음).
    let provider = HttpPrProvider::new(&gh_token)?;
    let diff = provider
        .fetch_pr_diff(&input.repo_full_name, input.pr_number as u64)
        .await?;

    let id = super::new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
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
    .await?;

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
) -> Result<crate::models::PrSelfCheckProposal, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT proposal FROM agent_runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_optional(db.inner())
            .await?;
    let raw = row
        .ok_or_else(|| AppError::not_found("agents.job_not_found", "잡을 찾을 수 없음"))?
        .0
        .ok_or_else(|| {
            AppError::not_found(
                "agents.proposal_not_ready",
                "아직 proposal이 없습니다(잡이 끝나지 않았거나 산출물 없음).",
            )
        })?;
    parse_pr_proposal(&raw).map_err(|e| AppError::terminal("agents.proposal_parse", e))
}

/// proposal JSON → 타입. raw fallback(`{"raw":...}`)이면 codex 출력이 형식과 달랐다는 뜻이라 Err로 노출.
pub(super) fn parse_pr_proposal(raw: &str) -> Result<crate::models::PrSelfCheckProposal, String> {
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
pub(super) async fn execute_accept(
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
) -> Result<(), AppError> {
    // 상태 가드: awaiting_approval만 accept 가능(이미 처리/실행 중이면 거부).
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, trigger FROM agent_runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_optional(db.inner())
            .await?;
    let (status, trigger) =
        row.ok_or_else(|| AppError::not_found("agents.job_not_found", "잡을 찾을 수 없음"))?;
    super::require_awaiting(&status, "agents.accept_wrong_status")?;
    let accepted_json = serde_json::to_string(&accepted)
        .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
    execute_accept(db.inner(), &run_id, &accepted_json, trigger.as_deref()).await?;
    Ok(())
}

/// Proposal reject(폐기). awaiting_approval 잡을 cancelled로 마감한다(acceptances 기록 없음, 외부 무변경).
#[tauri::command]
#[specta::specta]
pub async fn reject_proposal(db: State<'_, Db>, run_id: String) -> Result<(), AppError> {
    let res = sqlx::query(
        "UPDATE agent_runs SET status = 'cancelled', \
            result = json_object('error', '사용자가 제안을 폐기(reject)함'), \
            finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(&run_id)
    .execute(db.inner())
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::validation(
            "agents.reject_wrong_status",
            "reject 가능한 상태가 아닙니다(awaiting_approval 아님).",
        ));
    }
    Ok(())
}
