use tauri::State;

use crate::agent::{Bounds, CodexRunner};
use crate::commands::agent_run_store::{
    count_triage_runs, insert_agent_run, new_run_id, record_acceptance, run_proposal_raw,
    run_status_trigger,
};
use crate::commands::signal_store;
use crate::commands::skills::{resolve_agent_prompt_runtime, BINDING_CI_TRIAGE};
use crate::db::Db;
use crate::error::AppError;
use crate::github::{HttpPrProvider, PrProvider};
use crate::jobs::{JobManager, NewAgentRun};
use crate::models::{
    AgentRail, CiTriageProposal, Engine, Sandbox, TriageOutcome, TriggerCiTriageInput,
};

// ── CI triage (#3, 재트리거 캡 + Q1 escalate) ───────────────────────────────────────

/// 같은 PR CI 실패를 재triage할 수 있는 최대 횟수(INVARIANT #5). 초과 시 사람에게 Q1 escalate.
pub(super) const TRIAGE_RETRY_CAP: i64 = 3;

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

/// 재트리거 캡 초과 시 매트릭스로 Q1 escalate(사람 개입). dedup upsert(중복 0) + 항상 unclassified 진입 +
/// suggested q1 힌트만(INVARIANT #1 — 자동 분류 아님). type=agent_alert(시스템 신호).
pub(super) async fn escalate_triage_to_q1(
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
    signal_store::insert_triage_q1_escalation(db, project_id, &title, &body, &dedup, &links).await
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
) -> Result<TriageOutcome, AppError> {
    let codex_bin = super::require_codex(&jm)
        .await
        .map_err(|e| AppError::terminal("agents.codex_unavailable", e))?;

    let retry_key = format!("triage:{}:{}", input.repo_full_name, input.pr_number);
    // 재트리거 캡: 초과면 잡 대신 Q1 escalate(사람).
    let prior = count_triage_runs(db.inner(), &retry_key).await?;
    if prior >= TRIAGE_RETRY_CAP {
        escalate_triage_to_q1(
            db.inner(),
            input.project_id.as_deref(),
            &input.repo_full_name,
            input.pr_number,
            &input.pr_url,
            &retry_key,
        )
        .await?;
        return Ok(TriageOutcome {
            run_id: None,
            escalated: true,
            detail: format!(
                "CI triage가 캡({TRIAGE_RETRY_CAP})에 도달 — 매트릭스 Q1으로 escalate(사람 개입)."
            ),
        });
    }

    let (repo_id, local_path, project_id, gh_token) = super::resolve_selfcheck_repo(
        db.inner(),
        input.project_id.as_deref(),
        &input.repo_full_name,
    )
    .await
    .map_err(|e| AppError::terminal("agents.resolve_repo", e))?;

    // PR diff fetch(read 레일, bounded retry). 트리거 시점에 받아 실패를 즉시 노출한다.
    // GithubError의 transient/terminal 분류는 From<GithubError>로 보존된다.
    let provider = HttpPrProvider::new(&gh_token)?;
    let diff = provider
        .fetch_pr_diff(&input.repo_full_name, input.pr_number as u64)
        .await?;

    let id = new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::to_string(&super::PrJobTrigger {
        pr_url: input.pr_url.clone(),
        repo_full_name: input.repo_full_name.clone(),
        pr_number: input.pr_number,
    })
    .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
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
    .await?;

    let runtime =
        resolve_agent_prompt_runtime(db.inner(), BINDING_CI_TRIAGE, CI_TRIAGE_PROMPT).await;
    let model = crate::commands::agents_config::resolve_codex_model_for_prompt(
        db.inner(),
        runtime.model.clone(),
        runtime.fast_mode,
    )
    .await;
    jm.spawn(
        db.inner().clone(),
        id.clone(),
        bounds,
        CodexRunner {
            codex_bin,
            run_id: id.clone(),
            prompt: runtime.prompt,
            sandbox: Sandbox::ReadOnly,
            rail: AgentRail::Suggestion,
            repo_path: Some(std::path::PathBuf::from(local_path)),
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: vec![("pr.diff".to_string(), diff)],
            model,
            reasoning_effort: runtime.reasoning_effort,
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
) -> Result<CiTriageProposal, AppError> {
    let raw = run_proposal_raw(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::terminal("agents.proposal_unavailable", e))?;
    super::parse_proposal::<CiTriageProposal>(&raw)
        .map_err(|e| AppError::terminal("agents.parse_proposal", e))
}

/// CI triage Proposal accept(INVARIANT #2 게이트). 로컬 기록만(acceptances + 잡 succeeded) — 외부 무변경.
/// 실제 수정은 사람이 수동(또는 실행 레일 Phase 10).
#[tauri::command]
#[specta::specta]
pub async fn accept_triage(
    db: State<'_, Db>,
    run_id: String,
    accepted: CiTriageProposal,
) -> Result<(), AppError> {
    let (status, _trigger) = run_status_trigger(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::terminal("agents.run_status", e))?;
    super::require_awaiting(status, "agents.not_acceptable")?;
    let accepted_json = serde_json::to_string(&accepted)
        .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
    Ok(record_acceptance(db.inner(), &run_id, "triage_ci", &accepted_json).await?)
}
