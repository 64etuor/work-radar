use tauri::State;

use crate::commands::agent_run_store::{
    insert_agent_run, new_run_id, record_acceptance, run_proposal_raw, run_status_trigger,
};
use crate::commands::okr::{create_key_result_inner, create_objective_inner};
use crate::commands::signals::current_life_wheel_tags;
use crate::commands::skills::{resolve_agent_prompt_runtime, BINDING_OKR_IMPORT};
use crate::db::Db;
use crate::error::AppError;
use crate::jobs::{JobManager, NewAgentRun};
use crate::models::{
    AgentRail, CreateKeyResultInput, CreateObjectiveInput, Engine, OkrImportDraft,
    OkrImportHorizonDraft, OkrImportObjectiveDraft, OkrMilestone, Sandbox, TriggerOkrImportInput,
};

// ── OKR 받아쓰기 (자유 텍스트 → OKR 초안) — enrich_batch와 동일한 게이트 모양 ──────────────
//
// INVARIANT #1: codex는 **초안**만 낸다 — mission/horizon/objective/KR 생성은 사람이 검토·편집 후
//   "적용"을 클릭할 때만(accept_okr_import). 자동 생성 0.
// INVARIANT #2: Acceptance 게이트(awaiting_approval) 통과 후에만 로컬 반영, 외부 무변경.
// INVARIANT #5: 단일 잡 bound(timeout/max_turns/cost_cap).

/// OKR 받아쓰기 프롬프트(상수 — 사용자 텍스트는 cwd `okr_input.json` 데이터 파일로 전달, 인젝션 없음).
/// pub(crate): 스킬 레지스트리 시드 + 잡 lookup 폴백의 단일 출처.
pub(crate) const OKR_IMPORT_PROMPT: &str = "\
당신은 개인 OKR **초안 작성** 도우미다. 작업 디렉터리의 `okr_input.json`에 사용자가 붙여넣은 자유 \
텍스트(`text`), 대상 분기(`quarter`), 사용 가능한 라이프 도메인 태그(`areaTags`: `[{\"id\",\"label\"}]`), \
기존 Objective 제목(`existingObjectiveTitles`)이 있다. 텍스트를 read-only로 읽고 아래 형식의 JSON 객체 \
**하나만** 마지막 메시지로 출력하라(코드펜스·설명 없이 순수 JSON):\n\
{\"mission\": \"이번 시즌 미션/주제 한 문장 또는 null\", \
\"horizons\": [{\"title\": \"장기 목표 문장\", \"horizonKind\": \"three_year|one_year|someday 중 하나\"}], \
\"objectives\": [{\"title\": \"...\", \"description\": \"부연 또는 null\", \
\"linkedAreaKeys\": [\"areaTags의 id만\"], \
\"keyResults\": [{\"title\": \"...\", \"kind\": \"metric|milestone\", \"targetValue\": 숫자 또는 null, \
\"unit\": \"회/시간/%/개 등 또는 null\", \"milestones\": [\"milestone kind일 때 단계 라벨\"]}]}]}\n\
규칙: 수치 목표(횟수·시간·%·개수)는 kind=metric으로 targetValue+unit을 채운다. '완성/작성/선별 완료' 같은 \
이진·단계 목표는 kind=milestone으로 milestones에 라벨을 넣는다(기간 준수형은 월별 라벨로 쪼갠다). \
linkedAreaKeys는 입력 areaTags의 id 세트 **안에서만** 고른다(맞는 게 없으면 빈 배열). \
existingObjectiveTitles와 사실상 같은 Objective는 다시 만들지 않는다. 텍스트에 없는 목표를 지어내지 마라. \
이것은 **초안 제안**일 뿐이며 실제 생성은 사람이 검토·편집 후 적용한다.";

/// OKR 받아쓰기 잡 트리거. 텍스트를 `okr_input.json`으로 전달해 **한** codex 호출(비-레포·read_only)로
/// OKR 초안을 뽑는다. Proposal은 awaiting_approval로 멈추고(Acceptance 게이트), 생성은
/// accept_okr_import에서 사람 클릭으로만.
#[tauri::command]
#[specta::specta]
pub async fn trigger_okr_import(
    db: State<'_, Db>,
    jm: State<'_, JobManager>,
    input: TriggerOkrImportInput,
) -> Result<String, AppError> {
    use crate::agent::{Bounds, CodexRunner};

    let codex_bin = super::require_codex(&jm)
        .await
        .map_err(|e| AppError::terminal("agents.codex_unavailable", e))?;

    let text = input.text.trim();
    if text.is_empty() {
        return Err(AppError::validation(
            "okr_import.empty_text",
            "텍스트가 비어 있습니다.",
        ));
    }
    let quarter = input.quarter.trim();
    if quarter.is_empty() {
        return Err(AppError::validation(
            "okr_import.empty_quarter",
            "분기가 비어 있습니다.",
        ));
    }

    let tags = current_life_wheel_tags(db.inner()).await?;
    let existing_titles: Vec<String> =
        sqlx::query_scalar("SELECT title FROM objectives WHERE quarter = ?1 ORDER BY sort_rank")
            .fetch_all(db.inner())
            .await?;

    // codex 입력 파일(인젝션 없음 — 사용자 텍스트는 데이터 파일로만 전달).
    let input_json = serde_json::json!({
        "text": text,
        "quarter": quarter,
        "areaTags": tags
            .iter()
            .filter(|t| t.enabled)
            .map(|t| serde_json::json!({ "id": t.id, "label": t.label }))
            .collect::<Vec<_>>(),
        "existingObjectiveTitles": existing_titles,
    })
    .to_string();

    let id = new_run_id(db.inner())
        .await
        .map_err(|e| AppError::unexpected("agents.new_run_id", e))?;
    let bounds = Bounds {
        timeout: std::time::Duration::from_secs(input.timeout_sec.max(1) as u64),
        max_turns: input.max_turns.max(1),
        cost_cap_usd: input.cost_cap_usd.max(0.0),
    };
    let trigger = serde_json::to_string(&super::OkrImportTrigger {
        quarter: quarter.to_string(),
        text_chars: text.chars().count() as u32,
    })
    .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
    insert_agent_run(
        db.inner(),
        &NewAgentRun {
            id: id.clone(),
            project_id: None,
            engine: Engine::Codex,
            kind: "okr_import".into(),
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

    let runtime =
        resolve_agent_prompt_runtime(db.inner(), BINDING_OKR_IMPORT, OKR_IMPORT_PROMPT).await;
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
            repo_path: None,
            worktree_root: jm.worktree_root.clone(),
            scratch_dir: jm.worktree_root.join(format!("scratch-{id}")),
            input_files: vec![("okr_input.json".to_string(), input_json)],
            model,
            reasoning_effort: runtime.reasoning_effort,
        },
        true, // 게이트 잡: 성공+proposal이면 awaiting_approval(Acceptance 게이트).
    );
    Ok(id)
}

/// proposal 원문을 항목 단위 검증으로 OkrImportDraft로 만든다(부분 실패 격리 — 형식/닫힌 세트 밖
/// 항목만 skip + skipped++). raw fallback이면 Err(조용한 빈 초안 금지).
pub(super) fn build_okr_import_draft(raw: &str) -> Result<OkrImportDraft, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("proposal JSON 파싱 실패: {e}"))?;
    if let Some(raw_msg) = v.get("raw").and_then(|x| x.as_str()) {
        return Err(format!(
            "codex가 형식에 맞는 JSON을 내지 않았습니다. 원문:\n{raw_msg}"
        ));
    }

    let mut skipped: u32 = 0;
    let mission = v
        .get("mission")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    let mut horizons: Vec<OkrImportHorizonDraft> = Vec::new();
    for entry in v
        .get("horizons")
        .and_then(|x| x.as_array())
        .unwrap_or(&Vec::new())
    {
        match serde_json::from_value::<OkrImportHorizonDraft>(entry.clone()) {
            Ok(h) if !h.title.trim().is_empty() => horizons.push(h),
            _ => skipped = skipped.saturating_add(1),
        }
    }

    let mut objectives: Vec<OkrImportObjectiveDraft> = Vec::new();
    for entry in v
        .get("objectives")
        .and_then(|x| x.as_array())
        .unwrap_or(&Vec::new())
    {
        match serde_json::from_value::<OkrImportObjectiveDraft>(entry.clone()) {
            Ok(mut o) if !o.title.trim().is_empty() => {
                // KR도 항목 단위 정리: 빈 제목 KR은 skip(부분 실패 격리 유지).
                let before = o.key_results.len();
                o.key_results.retain(|kr| !kr.title.trim().is_empty());
                skipped = skipped.saturating_add((before - o.key_results.len()) as u32);
                objectives.push(o);
            }
            _ => skipped = skipped.saturating_add(1),
        }
    }

    Ok(OkrImportDraft {
        mission,
        horizons,
        objectives,
        skipped,
    })
}

/// OKR 받아쓰기 Proposal(타입 파싱 + 항목 검증). raw/형식 밖이면 Err.
#[tauri::command]
#[specta::specta]
pub async fn okr_import_proposal(
    db: State<'_, Db>,
    run_id: String,
) -> Result<OkrImportDraft, AppError> {
    let raw = run_proposal_raw(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::terminal("agents.proposal_unavailable", e))?;
    build_okr_import_draft(&raw).map_err(|e| AppError::terminal("agents.build_proposal", e))
}

/// OKR 받아쓰기 accept(INVARIANT #1/#2 게이트). 사람이 검토·편집한 초안을 적용하면 mission upsert,
/// horizon(동일 제목+kind 활성 존재 시 skip), objective+KR을 기존 생성 경로(create_*_inner)로 만든다.
/// 만든 Objective 수를 돌려준다. 외부 호출 없음(로컬 기록만).
#[tauri::command]
#[specta::specta]
pub async fn accept_okr_import(
    db: State<'_, Db>,
    run_id: String,
    accepted: OkrImportDraft,
) -> Result<u32, AppError> {
    let (status, trigger) = run_status_trigger(db.inner(), &run_id)
        .await
        .map_err(|e| AppError::terminal("agents.run_status", e))?;
    super::require_awaiting(status, "agents.not_acceptable")?;
    let quarter = trigger
        .as_deref()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.get("quarter").and_then(|q| q.as_str()).map(String::from))
        .ok_or_else(|| {
            AppError::unexpected(
                "okr_import.trigger_quarter",
                "잡 트리거에 quarter가 없습니다.",
            )
        })?;

    if let Some(mission) = accepted
        .mission
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sqlx::query(
            "INSERT INTO missions (id, statement, note) VALUES (1, ?1, NULL) \
             ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, \
             updated_at = datetime('now')",
        )
        .bind(mission)
        .execute(db.inner())
        .await?;
    }

    for horizon in &accepted.horizons {
        let title = horizon.title.trim();
        if title.is_empty() {
            continue;
        }
        // 동일 제목+kind의 활성 horizon이 있으면 skip(재적용/중복 방지).
        sqlx::query(
            "INSERT INTO mission_horizons (id, title, horizon_kind, sort_rank) \
             SELECT lower(hex(randomblob(16))), ?1, ?2, \
                    COALESCE((SELECT MAX(sort_rank) + 1 FROM mission_horizons), 0) \
             WHERE NOT EXISTS (SELECT 1 FROM mission_horizons \
                               WHERE title = ?1 AND horizon_kind = ?2 AND status = 'active')",
        )
        .bind(title)
        .bind(horizon.horizon_kind)
        .execute(db.inner())
        .await?;
    }

    let base_rank: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM objectives WHERE quarter = ?1")
        .bind(&quarter)
        .fetch_one(db.inner())
        .await?;
    let mut created: u32 = 0;
    for (index, objective) in accepted.objectives.iter().enumerate() {
        if objective.title.trim().is_empty() {
            continue;
        }
        let saved = create_objective_inner(
            db.inner(),
            CreateObjectiveInput {
                quarter: quarter.clone(),
                title: objective.title.clone(),
                description: objective.description.clone(),
                sort_rank: (base_rank as i32).saturating_add(index as i32),
                linked_area_keys: objective.linked_area_keys.clone(),
                linked_project_ids: Vec::new(),
            },
        )
        .await?;
        for (kr_index, kr) in objective.key_results.iter().enumerate() {
            create_key_result_inner(
                db.inner(),
                CreateKeyResultInput {
                    objective_id: saved.id.clone(),
                    title: kr.title.clone(),
                    kind: kr.kind,
                    current_value: None,
                    target_value: kr.target_value,
                    unit: kr.unit.clone(),
                    milestones: kr
                        .milestones
                        .iter()
                        .map(|label| OkrMilestone {
                            label: label.clone(),
                            done: false,
                        })
                        .collect(),
                    sort_rank: kr_index as i32,
                },
            )
            .await?;
        }
        created = created.saturating_add(1);
    }

    let accepted_json = serde_json::to_string(&accepted)
        .map_err(|e| AppError::unexpected("agents.serialize", e.to_string()))?;
    record_acceptance(db.inner(), &run_id, "okr_import", &accepted_json).await?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::build_okr_import_draft;

    #[test]
    fn draft_parses_and_isolates_bad_items() {
        let raw = r#"{
            "mission": " 강한 몸 ",
            "horizons": [
                {"title": "1년 목표", "horizonKind": "one_year"},
                {"title": "이상한 kind", "horizonKind": "next_century"}
            ],
            "objectives": [
                {"title": "O1", "linkedAreaKeys": ["health"],
                 "keyResults": [
                    {"title": "KR1", "kind": "metric", "targetValue": 48, "unit": "회"},
                    {"title": "", "kind": "metric"},
                    {"title": "KR2", "kind": "milestone", "milestones": ["a", "b"]}
                 ]},
                {"title": "", "keyResults": []}
            ]
        }"#;
        let draft = build_okr_import_draft(raw).unwrap();
        assert_eq!(draft.mission.as_deref(), Some("강한 몸"));
        assert_eq!(draft.horizons.len(), 1);
        assert_eq!(draft.objectives.len(), 1);
        assert_eq!(draft.objectives[0].key_results.len(), 2);
        assert_eq!(draft.skipped, 3);
    }

    #[test]
    fn draft_rejects_raw_fallback() {
        assert!(build_okr_import_draft(r#"{"raw": "말로 때움"}"#).is_err());
    }
}
