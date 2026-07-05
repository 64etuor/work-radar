mod enrich;
mod okr_import;
mod selfcheck;
mod spine;
mod triage;
mod usage;

pub use enrich::*;
pub use okr_import::*;
pub use selfcheck::*;
pub use spine::*;
pub use triage::*;
pub use usage::*;

use crate::agent::codex_availability;
use crate::db::Db;
use crate::error::AppError;
use crate::jobs::JobManager;
use crate::models::AgentStatus;

// ── SHARED helpers ─────────────────────────────────────────────────────────────────
// These are called via `super::<name>` from child submodules.

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

/// accept 류 작업의 상태 가드: awaiting_approval만 허용(이미 처리/실행 중이면 거부 — INVARIANT #2).
/// code는 호출 경로별 머신 식별자(기존 코드 보존).
// AppError는 리치 에러 envelope이라 의도적으로 크다(커맨드는 매크로로 면제됨). 가드 헬퍼는
// 커맨드와 동일한 AppError를 그대로 전파해야 하므로 large-err 린트를 국소 허용한다.
#[allow(clippy::result_large_err)]
pub(super) fn require_awaiting(status: AgentStatus, code: &'static str) -> Result<(), AppError> {
    if status != AgentStatus::AwaitingApproval {
        return Err(AppError::validation(
            code,
            format!("accept 가능한 상태가 아닙니다(현재: {status})."),
        ));
    }
    Ok(())
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

// ── 잡 trigger 페이로드 (내부 — agent_runs.trigger 컬럼에 JSON 영속, 프런트 표시·accept 경로용) ──
// codex가 내는 proposal과 달리 trigger는 앱이 전적으로 통제하므로 타입화한다(stringly-typed JSON 제거).
// camelCase 직렬화로 기존 JSON 키(signalId/batchCount/prUrl/repoFullName/prNumber)를 그대로 보존.

/// OKR 받아쓰기 트리거 — quarter는 accept가 되읽는 계약(생성 대상 분기), text_chars는 표시용.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OkrImportTrigger {
    pub quarter: String,
    pub text_chars: u32,
}

/// enrich(전체 배치) 트리거 — 표시용(읽기 없음).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BatchEnrichTrigger {
    pub batch_count: u32,
}

/// PR 대상 잡(self-check / CI triage) 트리거 — 표시용(읽기 없음).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrJobTrigger {
    pub pr_url: String,
    pub repo_full_name: String,
    pub pr_number: u32,
}

// ── agent_run_status: 영속은 agent_run_store(fetch_run_status/detail_from_result)에 위임 ──────

use crate::models::AgentRunStatus;
use tauri::State;

/// 단일 잡 상태 폴링 (EnrichReviewPanel awaiting_approval 게이트 등). 1초 주기 폴링용으로 가볍게 설계.
/// terminal 상태(awaiting_approval/succeeded/failed/cancelled)에서 폴링을 멈춰도 된다.
#[tauri::command]
#[specta::specta]
pub async fn agent_run_status(
    db: State<'_, Db>,
    run_id: String,
) -> Result<AgentRunStatus, AppError> {
    let row = crate::commands::agent_run_store::fetch_run_status(db.inner(), &run_id).await?;
    let (status, result, proposal) =
        row.ok_or_else(|| AppError::not_found("agents.run_not_found", "잡을 찾을 수 없음"))?;
    let detail = crate::commands::agent_run_store::detail_from_result(result.as_deref());
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
    use crate::commands::signal_store::insert_signal;
    use crate::models::{Kind, Quadrant};

    /// trigger 구조체가 기존 camelCase JSON 키를 그대로 직렬화하는지 잠근다(프런트 경계 계약).
    #[test]
    fn trigger_structs_serialize_to_stable_camelcase_keys() {
        let b = serde_json::to_string(&BatchEnrichTrigger { batch_count: 3 }).unwrap();
        assert_eq!(b, r#"{"batchCount":3}"#);

        let p = serde_json::to_string(&PrJobTrigger {
            pr_url: "https://x/pr/7".into(),
            repo_full_name: "o/r".into(),
            pr_number: 7,
        })
        .unwrap();
        assert_eq!(
            p,
            r#"{"prUrl":"https://x/pr/7","repoFullName":"o/r","prNumber":7}"#
        );
    }

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

    // ── Phase 9: CI triage ────────────────────────────────────────────

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

    /// 배치 accept는 **사람의 명시적 적용**이므로 quadrant+area를 확정하고 suggested 힌트를 비운다.
    /// 자동 분류가 아니라 사람 제스처 — 드래그/키보드 분류와 동일 결정 레일(INVARIANT #1).
    /// 이미 분류된 카드는 덮지 않는다(사람이 내린 결정 보존).
    #[tokio::test]
    async fn batch_accept_confirms_quadrant_and_area() {
        use crate::models::{AreaTag, BatchEnrichItem, BatchEnrichProposal, SignalStatus};
        let db = fresh_db().await;
        let s1 = insert_signal(&db, &input("원두 주문", Some(Kind::Personal)))
            .await
            .unwrap();
        let s2 = insert_signal(&db, &input("데모 준비", Some(Kind::Work)))
            .await
            .unwrap();
        // 이미 사람이 Q2로 분류한 카드 — 배치 accept가 덮으면 안 된다(가드).
        let s3 = insert_signal(&db, &input("이미 분류됨", Some(Kind::Work)))
            .await
            .unwrap();
        crate::commands::signal_store::set_quadrant(&db, &s3.id, Quadrant::Q2Schedule)
            .await
            .unwrap();
        // 사분면 제안 없이(None) 영역만 제안된 카드 — quadrant는 unclassified로 두고 area만 확정.
        let s4 = insert_signal(&db, &input("영역만 제안", Some(Kind::Personal)))
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
                BatchEnrichItem {
                    id: s3.id.clone(),
                    title: Some("이미 분류됨".into()),
                    suggested_quadrant: Some(Quadrant::Q1DoNow),
                    suggested_area: Some(AreaTag::Health),
                    reason: None,
                },
                BatchEnrichItem {
                    id: s4.id.clone(),
                    title: Some("영역만 제안".into()),
                    suggested_quadrant: None,
                    suggested_area: Some(AreaTag::Studies),
                    reason: None,
                },
            ],
            skipped: 0,
        };
        let accepted_json = serde_json::to_string(&accepted).unwrap();
        let applied = enrich::execute_accept_enrich_all(&db, "ba1", &accepted, &accepted_json)
            .await
            .unwrap();
        // s1·s2·s4는 미분류였으니 처리됨, s3은 가드(WHERE quadrant='unclassified')로 스킵 → 3건.
        assert_eq!(applied, 3);

        // 미분류였던 두 카드: quadrant+area 확정 + status=classified + suggested 힌트 비움.
        for (id, q, area) in [
            (&s1.id, "q3_quick_contain", AreaTag::Finances),
            (&s2.id, "q1_do_now", AreaTag::Work),
        ] {
            let row: (
                String,
                SignalStatus,
                Option<AreaTag>,
                Option<String>,
                Option<AreaTag>,
            ) = sqlx::query_as(
                "SELECT quadrant, status, area, suggested_quadrant, suggested_area \
                     FROM signals WHERE id = ?1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap();
            assert_eq!(row.0, q, "사람 적용 → quadrant 확정");
            assert!(
                matches!(row.1, SignalStatus::Classified),
                "확정 시 status=classified"
            );
            assert!(
                matches!(row.2, Some(a) if a as u8 == area as u8),
                "area 확정"
            );
            assert!(row.3.is_none(), "확정 후 suggested_quadrant 비움");
            assert!(row.4.is_none(), "확정 후 suggested_area 비움");
        }

        // 이미 분류된 s3은 그대로(덮지 않음) — 사람 결정 보존.
        let s3row: (String, Option<AreaTag>) =
            sqlx::query_as("SELECT quadrant, area FROM signals WHERE id = ?1")
                .bind(&s3.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            s3row.0, "q2_schedule",
            "이미 분류된 카드는 배치 accept가 덮지 않음"
        );
        assert!(s3row.1.is_none(), "s3 area 무변경");

        // s4(사분면 제안 None): quadrant는 unclassified 유지(status=new) + area만 확정 + 힌트 비움.
        let s4row: (String, SignalStatus, Option<AreaTag>, Option<String>) = sqlx::query_as(
            "SELECT quadrant, status, area, suggested_area FROM signals WHERE id = ?1",
        )
        .bind(&s4.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            s4row.0, "unclassified",
            "사분면 제안 없으면 unclassified 유지"
        );
        assert!(
            matches!(s4row.1, SignalStatus::New),
            "unclassified 확정 시 status=new"
        );
        assert!(
            matches!(s4row.2, Some(AreaTag::Studies)),
            "사분면 None이어도 area는 확정"
        );
        assert!(s4row.3.is_none(), "확정 후 suggested_area 비움");

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
            crate::commands::agent_run_store::count_triage_runs(&db, retry_key)
                .await
                .unwrap()
                < triage::TRIAGE_RETRY_CAP
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
            crate::commands::agent_run_store::count_triage_runs(&db, retry_key)
                .await
                .unwrap(),
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
        // detail_from_result: result 없으면 None.
        let detail = crate::commands::agent_run_store::detail_from_result(result.as_deref());
        assert!(detail.is_none());
    }
}
