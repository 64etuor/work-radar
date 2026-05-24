use tauri::State;

use crate::commands::agent_run_store::{
    fetch_run_project_id, insert_agent_run, new_run_id, record_acceptance, run_proposal_raw,
    run_status_trigger,
};
use crate::commands::signal_store;
use crate::commands::skills::{resolve_prompt, BINDING_BATCH_ENRICH, BINDING_ENRICH};
use crate::db::Db;
use crate::error::AppError;
use crate::jobs::{JobManager, NewAgentRun};
use crate::models::{
    AgentRail, AreaTag, BatchEnrichItem, BatchEnrichProposal, Engine, EnrichProposal, Quadrant,
    Sandbox, TriggerEnrichAllInput, TriggerEnrichInput, WorkSignal,
};

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
) -> Result<String, AppError> {
    use crate::agent::{Bounds, CodexRunner};

    let codex_bin = super::require_codex(&jm)
        .await
        .map_err(|e| AppError::terminal("agents.codex_unavailable", e))?;

    // 카드 본문 로드(제목+본문). codex 입력 파일로 넘긴다(인젝션 없음).
    let row = signal_store::fetch_card_text(db.inner(), &input.signal_id).await?;
    let (title, body, project_id) =
        row.ok_or_else(|| AppError::not_found("agents.signal_not_found", "신호를 찾을 수 없음"))?;
    let card_text = match body.filter(|b| !b.trim().is_empty()) {
        Some(b) => format!("{title}\n\n{b}"),
        None => title,
    };

    let id = new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::to_string(&super::EnrichTrigger {
        signal_id: input.signal_id.clone(),
    })
    .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
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
    .await?;

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
pub async fn enrich_proposal(
    db: State<'_, Db>,
    run_id: String,
) -> Result<EnrichProposal, AppError> {
    let raw = run_proposal_raw(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::not_found("agents.proposal_not_ready", e))?;
    super::parse_proposal::<EnrichProposal>(&raw)
        .map_err(|e| AppError::terminal("agents.proposal_parse", e))
}

/// enrich accept 코어(테스트 가능). 사람이 검토·편집 후 accept하면 신호의 quadrant+area를 **확정**하고
/// suggested 힌트를 비운다 — 단, 제안에 quadrant가 없으면(None) 기존 분류를 덮지 않는다(단일 enrich는
/// 이미 분류된 카드에도 열릴 수 있어 COALESCE로 보존). 자동 분류가 아니라 사람의 명시적 accept 클릭 =
/// 드래그/키보드 분류와 동일 결정 레일(INVARIANT #1).
pub(super) async fn execute_accept_enrich(
    db: &Db,
    run_id: &str,
    signal_id: &str,
    accepted: &EnrichProposal,
    accepted_json: &str,
) -> Result<WorkSignal, sqlx::Error> {
    let sig = signal_store::confirm_enrich_single(
        db,
        signal_id,
        accepted.suggested_quadrant,
        accepted.suggested_area,
    )
    .await?;
    record_acceptance(db, run_id, "enrich_braindump", accepted_json).await?;
    Ok(sig)
}

/// enrich Proposal accept(INVARIANT #1/#2 게이트). 사람이 검토·편집한 제안을 accept하면 신호의 quadrant+area를
/// **확정**(제안에 quadrant 없으면 기존 보존)하고 suggested 힌트를 비운 뒤 잡을 succeeded로 마감한다.
/// codex가 아니라 사람의 명시적 accept 클릭으로만 확정 — 드래그/키보드 분류와 동일 결정 레일(INVARIANT #1).
#[tauri::command]
#[specta::specta]
pub async fn accept_enrich(
    db: State<'_, Db>,
    run_id: String,
    accepted: EnrichProposal,
) -> Result<WorkSignal, AppError> {
    let (status, trigger) = run_status_trigger(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::not_found("agents.job_not_found", e))?;
    super::require_awaiting(status, "agents.accept_wrong_status")?;
    let signal_id = trigger
        .as_deref()
        .and_then(|t| serde_json::from_str::<super::EnrichTrigger>(t).ok())
        .map(|t| t.signal_id)
        .ok_or_else(|| {
            AppError::terminal(
                "agents.trigger_missing_signal_id",
                "잡 트리거에 signalId가 없음",
            )
        })?;
    let accepted_json = serde_json::to_string(&accepted)
        .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
    Ok(execute_accept_enrich(db.inner(), &run_id, &signal_id, &accepted, &accepted_json).await?)
}

/// 라이프 도메인 area 확정/수정(사람 결정 — 별개 축, quadrant 결정 레일과 무관). enrich 제안을 사람이
/// 확정하거나 직접 고른다. None이면 미설정으로 되돌린다.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_area(
    db: State<'_, Db>,
    id: String,
    area: Option<AreaTag>,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::set_signal_area(db.inner(), &id, area).await?)
}

// ── 배치 enrich (#4, 미분류 전체 일괄 제안 — 단일 codex 잡, 부분 실패 격리) ──────────────
//
// INVARIANT #1: codex는 suggested_*만 제안 — 자동 확정 0. 확정은 사람이 검토·편집 후 "적용"을 클릭할 때만
//   (드래그/키보드 분류와 동일한 사람 결정 레일). 자동화는 결정 레일에 침투하지 않는다.
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
pub(super) async fn fetch_unclassified_for_enrich(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    signal_store::fetch_unclassified_for_enrich(db, project_id).await
}

/// 미분류 전체 배치 enrich 잡 트리거(미분류 영역 "전체 제안 실행"). 모든 미분류 카드를 `cards.json`
/// 배열로 모아 **한** codex 호출(비-레포·read_only)로 카드별 suggested 힌트를 제안한다. 산출 Proposal은
/// awaiting_approval로 멈추고(Acceptance 게이트) — codex는 절대 확정하지 않는다. 확정은 사람이 검토 후
/// "적용"을 클릭할 때만(accept_enrich_all에서 quadrant+area 확정, INVARIANT #1).
/// 대상이 없으면 잡을 만들지 않고 Err. 미설치/미인증이면 Err(graceful degrade).
#[tauri::command]
#[specta::specta]
pub async fn trigger_enrich_all(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerEnrichAllInput,
) -> Result<String, AppError> {
    use crate::agent::{Bounds, CodexRunner};

    let codex_bin = super::require_codex(&jm)
        .await
        .map_err(|e| AppError::terminal("agents.codex_unavailable", e))?;

    let cards = fetch_unclassified_for_enrich(db.inner(), input.project_id.as_deref()).await?;
    if cards.is_empty() {
        return Err(AppError::not_found(
            "agents.no_unclassified_cards",
            "미분류 카드가 없습니다.",
        ));
    }

    // codex 입력 파일(인젝션 없음 — 카드는 데이터 파일로만 전달).
    let cards_json = serde_json::Value::Array(
        cards
            .iter()
            .map(|(id, title)| serde_json::json!({ "id": id, "title": title }))
            .collect(),
    )
    .to_string();

    let id = new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::to_string(&super::BatchEnrichTrigger {
        batch_count: cards.len() as u32,
    })
    .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
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
    .await?;

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
pub(super) fn build_batch_proposal(
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
) -> Result<BatchEnrichProposal, AppError> {
    let raw = run_proposal_raw(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::terminal("agents.proposal_unavailable", e))?;
    // 잡의 project_id 한정으로 현재 미분류 신호를 다시 모아 검증 기준으로 쓴다(잡 이후 변화 반영).
    let project_id = fetch_run_project_id(db.inner(), &run_id).await?;
    let valid: std::collections::HashMap<String, String> =
        fetch_unclassified_for_enrich(db.inner(), project_id.as_deref())
            .await?
            .into_iter()
            .collect();
    build_batch_proposal(&raw, &valid).map_err(|e| AppError::terminal("agents.build_proposal", e))
}

/// 배치 enrich accept 코어(테스트 가능). 사람이 검토·편집 후 "적용"하면 items의 카드마다 quadrant+area를
/// **한 번에 확정**하고 suggested_* 힌트를 비운다(미분류 카드에만 — 이미 분류된 카드는 사람 결정 보존,
/// 덮지 않음). 자동 분류가 아니라 사람의 명시적 적용 클릭 = 드래그/키보드 분류와 동일 결정 레일(INVARIANT #1).
/// 확정한 카드 수를 돌려준다. 외부 호출 없음(로컬 기록만).
pub(super) async fn execute_accept_enrich_all(
    db: &Db,
    run_id: &str,
    accepted: &BatchEnrichProposal,
    accepted_json: &str,
) -> Result<u32, sqlx::Error> {
    let mut applied: u32 = 0;
    for item in &accepted.items {
        // 사람 확정: quadrant(없으면 unclassified)+area를 한 번에 반영하고 suggested 힌트는 비운다.
        let quadrant = item.suggested_quadrant.unwrap_or(Quadrant::Unclassified);
        let rows =
            signal_store::confirm_enrich_batch_one(db, &item.id, quadrant, item.suggested_area)
                .await?;
        applied = applied.saturating_add(rows as u32);
    }
    record_acceptance(db, run_id, "enrich_batch", accepted_json).await?;
    Ok(applied)
}

/// 배치 enrich Proposal accept(INVARIANT #1/#2 게이트). 사람이 검토·편집한 카드별 제안을 accept(적용)하면
/// 각 신호의 quadrant+area를 **확정**하고(미분류 카드에 한함) suggested 힌트를 비운 뒤 잡을 succeeded로 마감한다.
/// codex가 아니라 사람의 명시적 적용 클릭으로만 확정 — 드래그/키보드 분류와 동일 결정 레일(INVARIANT #1).
#[tauri::command]
#[specta::specta]
pub async fn accept_enrich_all(
    db: State<'_, Db>,
    run_id: String,
    accepted: BatchEnrichProposal,
) -> Result<u32, AppError> {
    let (status, _trigger) = run_status_trigger(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::terminal("agents.run_status", e))?;
    super::require_awaiting(status, "agents.not_acceptable")?;
    let accepted_json = serde_json::to_string(&accepted)
        .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
    Ok(execute_accept_enrich_all(db.inner(), &run_id, &accepted, &accepted_json).await?)
}
