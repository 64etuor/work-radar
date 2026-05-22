mod enrich;
mod selfcheck;
mod spine;
mod triage;

pub use enrich::*;
pub use selfcheck::*;
pub use spine::*;
pub use triage::*;

use crate::agent::codex_availability;
use crate::db::Db;
use crate::error::AppError;
use crate::jobs::JobManager;

// ── SHARED helpers ─────────────────────────────────────────────────────────────────
// These are called via `super::<name>` from child submodules.

/// 새 잡 id (기존 엔티티와 동일한 hex 형식). agent_runs는 id를 미리 알아야 한다
/// (log_path/worktree 경로 산정 + kill 레지스트리 등록 + 반환).
pub(super) async fn new_run_id(db: &Db) -> Result<String, String> {
    let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id.0)
}

/// codex 미설치/미인증이면 Err(graceful degrade 게이트). Phase 9 트리거들이 공유한다.
pub(super) async fn require_codex(jm: &JobManager) -> Result<std::path::PathBuf, String> {
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
pub(super) async fn run_status_trigger(
    db: &Db,
    run_id: &str,
) -> Result<(String, Option<String>), String> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, trigger FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.ok_or_else(|| "잡을 찾을 수 없음".to_string())
}

/// accept 류 작업의 상태 가드: awaiting_approval만 허용(이미 처리/실행 중이면 거부 — INVARIANT #2).
/// code는 호출 경로별 머신 식별자(기존 코드 보존).
// AppError는 리치 에러 envelope이라 의도적으로 크다(커맨드는 매크로로 면제됨). 가드 헬퍼는
// 커맨드와 동일한 AppError를 그대로 전파해야 하므로 large-err 린트를 국소 허용한다.
#[allow(clippy::result_large_err)]
pub(super) fn require_awaiting(status: &str, code: &'static str) -> Result<(), AppError> {
    if status != "awaiting_approval" {
        return Err(AppError::validation(
            code,
            format!("accept 가능한 상태가 아닙니다(현재: {status})."),
        ));
    }
    Ok(())
}

/// 잡의 proposal JSON 원문. 없으면 Err(아직 산출물 없음).
pub(super) async fn run_proposal_raw(db: &Db, run_id: &str) -> Result<String, String> {
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
pub(super) fn parse_proposal<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
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
pub(super) async fn record_acceptance(
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
pub(super) fn trigger_field(trigger: Option<&str>, key: &str) -> Option<String> {
    let t = trigger?;
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

/// result JSON({detail|error})에서 사람이 읽을 상세를 뽑는다(jobs.rs detail_from_result 동일 로직).
pub(super) fn detail_from_result_json(result: Option<&str>) -> Option<String> {
    let raw = result?;
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("detail")
        .or_else(|| v.get("error"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

// ── agent_run_status lives here (uses detail_from_result_json shared helper) ──────

use crate::models::AgentRunStatus;
use tauri::State;

/// 단일 잡 상태 폴링 (B3: EnrichModal 인플레이스 폴링). 1초 주기 폴링용으로 가볍게 설계.
/// terminal 상태(awaiting_approval/succeeded/failed/cancelled)에서 폴링을 멈춰도 된다.
#[tauri::command]
#[specta::specta]
pub async fn agent_run_status(
    db: State<'_, Db>,
    run_id: String,
) -> Result<AgentRunStatus, AppError> {
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT status, result, proposal FROM agent_runs WHERE id = ?1")
            .bind(&run_id)
            .fetch_optional(db.inner())
            .await?;

    let (status, result, proposal) =
        row.ok_or_else(|| AppError::not_found("agents.run_not_found", "잡을 찾을 수 없음"))?;
    let detail = detail_from_result_json(result.as_deref());
    Ok(AgentRunStatus {
        status,
        has_proposal: proposal.is_some(),
        detail,
    })
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
        let ok = selfcheck::parse_pr_proposal(
            r#"{"summary":"바뀐 점","selfChecks":[{"item":"테스트"}]}"#,
        )
        .unwrap();
        assert_eq!(ok.summary, "바뀐 점");
        assert_eq!(ok.self_checks.len(), 1);
        assert!(!ok.self_checks[0].checked);
        // raw fallback → Err.
        let err = selfcheck::parse_pr_proposal(r#"{"raw":"엉뚱한 출력"}"#);
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
        selfcheck::execute_accept(&db, "a1", accepted, Some(trigger))
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
        use crate::models::EnrichProposal;
        // codex가 형식 밖 출력 → raw fallback → Err.
        assert!(parse_proposal::<EnrichProposal>(r#"{"raw":"엉뚱한 출력"}"#).is_err());
        // 닫힌 세트 밖 area → Err (AI는 세트 밖 카테고리를 만들 수 없다).
        assert!(parse_proposal::<EnrichProposal>(r#"{"suggestedArea":"productivity"}"#).is_err());
        // 세트 안 + 일부 누락 관용.
        let ok = parse_proposal::<EnrichProposal>(r#"{"suggestedArea":"health"}"#).unwrap();
        assert!(matches!(
            ok.suggested_area,
            Some(crate::models::AreaTag::Health)
        ));
        assert!(ok.suggested_quadrant.is_none());
    }

    /// CI triage proposal: raw fallback은 Err, 정상 JSON은 파싱.
    #[test]
    fn triage_proposal_parses() {
        use crate::models::CiTriageProposal;
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

        let parsed = parse_proposal::<crate::models::EnrichProposal>(proposal).unwrap();
        let accepted_json = serde_json::to_string(&parsed).unwrap();
        let updated = enrich::execute_accept_enrich(&db, "e1", &sig.id, &parsed, &accepted_json)
            .await
            .unwrap();

        // 힌트는 들어가고 quadrant는 unclassified로 남는다(자동 분류 0).
        assert!(
            matches!(updated.quadrant, Quadrant::Unclassified),
            "INVARIANT #1: quadrant 자동 확정 0"
        );
        assert_eq!(updated.suggested_quadrant.as_deref(), Some("q1_do_now"));
        assert!(matches!(
            updated.suggested_area,
            Some(crate::models::AreaTag::Work)
        ));
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
        let p = enrich::build_batch_proposal(raw, &valid).unwrap();
        // a만 유효: b=세트 밖 area, zzz=미존재, 둘째 a=중복 → 3건 skip.
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.skipped, 3);
        assert_eq!(p.items[0].id, "a");
        assert_eq!(p.items[0].title.as_deref(), Some("원두 주문")); // 제목은 신호에서.
        assert!(matches!(
            p.items[0].suggested_quadrant,
            Some(Quadrant::Q1DoNow)
        ));
        assert!(matches!(
            p.items[0].suggested_area,
            Some(crate::models::AreaTag::Work)
        ));

        // raw fallback / items 누락은 Err(조용한 빈 proposal 금지).
        assert!(enrich::build_batch_proposal(r#"{"raw":"엉뚱"}"#, &valid).is_err());
        assert!(enrich::build_batch_proposal(r#"{"foo":1}"#, &valid).is_err());
    }

    /// INVARIANT #1: 배치 accept는 카드별 suggested_* 힌트만 쓰고 quadrant(결정 레일)는 안 건드린다.
    #[tokio::test]
    async fn batch_accept_sets_hints_not_quadrant() {
        use crate::models::{AreaTag, BatchEnrichItem, BatchEnrichProposal};
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
        let applied = enrich::execute_accept_enrich_all(&db, "ba1", &accepted, &accepted_json)
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
        assert!(
            triage::count_triage_runs(&db, retry_key).await.unwrap() < triage::TRIAGE_RETRY_CAP
        );

        // 캡만큼 채운다.
        for i in 1..triage::TRIAGE_RETRY_CAP {
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
            triage::count_triage_runs(&db, retry_key).await.unwrap(),
            triage::TRIAGE_RETRY_CAP
        );

        // 캡 도달 → escalate. unclassified 진입 + suggested q1 힌트(자동 분류 0).
        triage::escalate_triage_to_q1(
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
        triage::escalate_triage_to_q1(
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

    /// agent_run_status: awaiting_approval + proposal 있으면 has_proposal=true.
    #[tokio::test]
    async fn agent_run_status_returns_has_proposal_when_present() {
        let db = fresh_db().await;
        let proposal =
            r#"{"suggestedQuadrant":"q1_do_now","suggestedArea":"work","reason":"테스트"}"#;
        insert_awaiting_run(&db, "ars1", proposal, "{}").await;

        // status, result, proposal 컬럼으로 검증 (detail은 result JSON에서 추출).
        let row: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT status, result, proposal FROM agent_runs WHERE id='ars1'")
                .fetch_one(&db)
                .await
                .unwrap();
        let status = row.0.clone();
        let result = row.1.clone();
        let has_proposal = row.2.is_some();

        assert_eq!(status, "awaiting_approval");
        assert!(
            has_proposal,
            "awaiting_approval 잡 + proposal → has_proposal=true"
        );
        // detail_from_result_json: result 없으면 None.
        let detail = detail_from_result_json(result.as_deref());
        assert!(detail.is_none());
    }
}
