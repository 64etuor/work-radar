//! 도메인을 가로지르는 MCP 표면 가드 — 툴 이름 집합 고정 + Hermes 직접 실행 경로.
//!
//! 도메인별 enqueue/dedup/스키마 테스트는 각 `tools/<domain>.rs`가 소유한다. 여기에는
//! **어느 한 도메인에도 속하지 않는** 계약만 둔다.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::commands::projects::insert_project;
use crate::commands::shared::test_support::{fresh_db, project_input};
use crate::error::AppError;
use crate::external_actions::{store, ExecOutcome, ExternalAction};
use crate::mcp::tools::calendar::CalendarCreateEventParams;
use crate::mcp::tools::github::{GithubCommentParams, GithubCreateIssueParams};
use crate::mcp::tools::gmail::GmailSendParams;
use crate::mcp::tools::notion::NotionCreatePageParams;
use crate::mcp::write_routing::HermesMcpExecutor;
use crate::mcp::{McpCaller, WrServer};
use crate::models::{Project, ProjectKind};

struct FakeHermesExecutor {
    calls: AtomicUsize,
}

impl FakeHermesExecutor {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::Relaxed)
    }
}

impl HermesMcpExecutor for FakeHermesExecutor {
    async fn execute(
        &self,
        _project: &Project,
        action: &ExternalAction,
    ) -> Result<ExecOutcome, AppError> {
        let n = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(ExecOutcome {
            external_ref: Some(format!("direct-{n}-{}", action.kind_str())),
            bytes: Some(1),
        })
    }
}

/// Hermes-origin write tools use Hermes' own permission gate and therefore execute directly
/// through the connector seam instead of creating Work Radar approval proposals.
#[tokio::test]
async fn hermes_write_tools_execute_direct_without_work_radar_approval_queue() {
    let db = fresh_db().await;
    let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
        .await
        .unwrap();
    let server = WrServer { db: db.clone() };
    let executor = FakeHermesExecutor::new();

    let github_comment = server
        .github_comment_for_caller_with_executor(
            GithubCommentParams {
                project_id: project.id.clone(),
                repo: "o/r".into(),
                issue_number: 7,
                body: "hi".into(),
            },
            McpCaller::Hermes,
            &executor,
        )
        .await
        .expect("Hermes GitHub comment direct");
    let github_issue = server
        .github_create_issue_for_caller_with_executor(
            GithubCreateIssueParams {
                project_id: project.id.clone(),
                repo: "o/r".into(),
                title: "T".into(),
                body: "B".into(),
            },
            McpCaller::Hermes,
            &executor,
        )
        .await
        .expect("Hermes GitHub issue direct");
    let notion = server
        .notion_create_page_for_caller_with_executor(
            NotionCreatePageParams {
                project_id: project.id.clone(),
                db_id: "1234567890abcdef1234567890abcdef".into(),
                title: "할 일".into(),
            },
            McpCaller::Hermes,
            &executor,
        )
        .await
        .expect("Hermes Notion direct");
    let calendar = server
        .calendar_create_event_for_caller_with_executor(
            CalendarCreateEventParams {
                project_id: project.id.clone(),
                calendar_id: "primary".into(),
                title: "회의".into(),
                start: "2026-06-04T10:00:00+09:00".into(),
                end: "2026-06-04T11:00:00+09:00".into(),
                all_day: false,
                description: None,
            },
            McpCaller::Hermes,
            &executor,
        )
        .await
        .expect("Hermes Calendar direct");
    let gmail = server
        .gmail_send_for_caller_with_executor(
            GmailSendParams {
                project_id: project.id.clone(),
                to: "vip@client.test".into(),
                subject: "주간 보고".into(),
                body: "본문".into(),
            },
            McpCaller::Hermes,
            &executor,
        )
        .await
        .expect("Hermes Gmail direct");

    assert_eq!(github_comment.0.status, "succeeded");
    assert!(github_comment.0.action_id.starts_with("direct-1-"));
    assert_eq!(github_issue.0.status, "succeeded");
    assert!(github_issue.0.action_id.starts_with("direct-2-"));
    assert_eq!(notion.0.status, "succeeded");
    assert!(notion.0.action_id.starts_with("direct-3-"));
    assert_eq!(calendar.0.status, "succeeded");
    assert!(calendar.0.action_id.starts_with("direct-4-"));
    assert_eq!(gmail.0.status, "succeeded");
    assert!(gmail.0.action_id.starts_with("direct-5-"));
    assert_eq!(executor.calls(), 5);
    assert!(
        store::list_pending(&db).await.unwrap().is_empty(),
        "Hermes direct writes must not create Work Radar approval proposals"
    );
}

#[test]
fn registered_tool_set_is_locked() {
    let names: std::collections::BTreeSet<String> = WrServer::tool_router()
        .list_all()
        .into_iter()
        .map(|t| t.name.to_string())
        .collect();
    let expected: std::collections::BTreeSet<String> = [
        "wr_list_pending_actions",
        "wr_list_projects",
        "wr_github_comment",
        "wr_github_create_issue",
        "wr_notion_create_page",
        "wr_calendar_create_event",
        "wr_calendar_list_events",
        "wr_gmail_send",
        "wr_bookkeeping_save_receipt",
        "wr_bookkeeping_list_recent_transactions",
        "wr_bookkeeping_list_review_queue",
        "wr_bookkeeping_monthly_summary",
        "wr_bookkeeping_get_category_rules",
        "wr_bookkeeping_find_duplicate_candidates",
        "wr_bookkeeping_mark_duplicate",
        "wr_bookkeeping_budget_status",
        "wr_bookkeeping_list_recurring_expenses",
        "wr_list_signals",
        "wr_create_signal",
        "wr_okr_get_mission",
        "wr_okr_list_objectives",
        "wr_okr_list_check_ins",
        "wr_okr_upsert_check_in",
        "wr_today_overview",
        "wr_list_today_routines",
        "wr_toggle_routine_check",
        "wr_list_timeline_notes",
        "wr_upsert_timeline_note",
        "wr_propose_noop",
        "wr_action_status",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    assert_eq!(
        names, expected,
        "registered MCP tool set drifted — update intentionally + the CFO contract"
    );
    // No execute/approve/delete/sql/shell/arbitrary-fetch capability ever appears on the surface.
    for forbidden in [
        "approve",
        "execute",
        "delete",
        "raw_sql",
        "run_shell",
        "fetch_url",
        "mutate_db",
    ] {
        assert!(
            !names.iter().any(|n| n.contains(forbidden)),
            "forbidden capability on MCP surface: {forbidden}"
        );
    }
}

/// 결정 레일(INVARIANT #1) 회귀 가드. `registered_tool_set_is_locked`의 allowlist는 "표면이 바뀌었다"만
/// 알려주고, 갱신하는 사람이 그 툴이 **결정 레일인지**는 판단하지 않는다. 여기서 결정 어휘 자체를
/// 못 박아, 스냅샷을 갱신하면서 무심코 `wr_classify_signal`을 들이는 일을 막는다.
///
/// 로컬 write 개방(ADR-0012)의 대가로 이 테스트가 실질 경계다 —
/// 에이전트는 *적어둘* 수 있지만 *정할* 수는 없다.
#[test]
fn decision_rail_writes_never_reach_the_mcp_surface() {
    let names: std::collections::BTreeSet<String> = WrServer::tool_router()
        .list_all()
        .into_iter()
        .map(|t| t.name.to_string())
        .collect();

    // 정확한 이름 — 앱에는 있지만 MCP 표면에는 절대 없어야 하는 커맨드들.
    for forbidden in [
        "wr_classify_signal",
        "wr_set_signal_status",
        "wr_set_signal_kind",
        "wr_set_signal_area_tag_key",
        "wr_snooze_signal",
        "wr_delete_signal",
        "wr_promote_today",
        "wr_unpromote_today",
        "wr_toggle_today_done",
        "wr_create_objective",
        "wr_update_objective",
        "wr_close_objective",
        "wr_delete_objective",
        "wr_create_key_result",
        "wr_update_key_result",
        "wr_delete_key_result",
        "wr_set_key_result_routine",
    ] {
        assert!(
            !names.contains(forbidden),
            "decision-rail tool must not be exposed over MCP: {forbidden}"
        );
    }

    // 부분 문자열 — 어떤 이름 변종으로도 등장할 수 없는 결정 어휘.
    // (`objective`는 `wr_okr_list_objectives`가 정당한 read라 부분 문자열로 금지하지 않는다;
    //  대신 위 정확-이름 목록이 objective CRUD를 잡는다.)
    for forbidden in ["classify", "promote", "snooze", "key_result"] {
        assert!(
            !names.iter().any(|n| n.contains(forbidden)),
            "decision-rail verb on MCP surface: {forbidden}"
        );
    }
}

/// **의도된 결합을 문서화하는 테스트.** 루틴에 연결된 KR은 progress를 `routine_checks`에서
/// 쿼리타임 파생한다(`commands/okr.rs` attach_routine_progress). 따라서 MCP
/// `wr_toggle_routine_check`는 OKR 진행률 배지를 **간접적으로 움직인다**.
///
/// 이것은 결정 레일 위반이 아니다. 에이전트가 준 것은 "했다"는 **사실**이고, 그 사실이 progress로
/// 흘러드는 규칙(어떤 루틴이 어떤 KR을 먹이는지)은 **사람이 만든 링크**다 —
/// `set_key_result_routine`은 MCP 표면에 없다. 반면 `update_key_result`는 그 파생을 우회해
/// 결과값을 직접 덮어쓰므로 차단된다.
///
/// 이 테스트가 깨진다면 결합이 사라졌거나(=이 주석이 거짓) 파생 규칙이 바뀐 것이다. 둘 다
/// 결정-레일 논증을 다시 검토해야 한다는 신호다.
#[tokio::test]
async fn routine_toggle_moves_a_routine_linked_key_result_by_design() {
    use crate::commands::okr as okr_commands;
    use crate::commands::routines::insert_routine;
    use crate::mcp::tools::okr::OkrQuarterParams;
    use crate::mcp::tools::today::ToggleRoutineCheckParams;
    use crate::models::{
        CreateKeyResultInput, CreateObjectiveInput, CreateRoutineInput, KeyResultKind, RoutineFreq,
    };

    // 완전히 지난 분기를 쓴다 — 파생 창은 `min(분기끝, 오늘)`이라 미래 분기는 시간 의존이 된다.
    const PAST_QUARTER: &str = "2024-Q1";
    const DAY_IN_QUARTER: &str = "2024-01-15";

    let db = fresh_db().await;
    let objective = okr_commands::create_objective_inner(
        &db,
        CreateObjectiveInput {
            quarter: PAST_QUARTER.into(),
            title: "습관 만들기".into(),
            description: None,
            sort_rank: 0,
            linked_area_keys: vec![],
            linked_project_ids: vec![],
        },
    )
    .await
    .expect("objective");
    let kr = okr_commands::create_key_result_inner(
        &db,
        CreateKeyResultInput {
            objective_id: objective.id,
            title: "스트레칭 10회".into(),
            kind: KeyResultKind::Metric,
            target_value: Some(10.0),
            current_value: Some(0.0),
            unit: None,
            milestones: vec![],
            sort_rank: 0,
        },
    )
    .await
    .expect("key result");
    let routine = insert_routine(
        &db,
        &CreateRoutineInput {
            title: "스트레칭".into(),
            freq: RoutineFreq::Daily,
            weekdays: vec![],
            anchor_date: None,
            start_date: None,
            end_date: None,
            time_of_day: None,
            reminder_offset_min: None,
            area: None,
            kind: None,
            monthly_pattern: None,
            monthly_nth_week: None,
            duration_min: None,
        },
    )
    .await
    .expect("routine");

    // 링크는 사람의 결정이다 — MCP가 아니라 여기서(앱 경로 대리) 건다.
    sqlx::query("UPDATE key_results SET routine_id = ?2 WHERE id = ?1")
        .bind(&kr.id)
        .bind(&routine.id)
        .execute(&db)
        .await
        .expect("link kr to routine");

    let server = WrServer { db: db.clone() };
    let progress_now = || async {
        server
            .okr_list_objectives_inner(OkrQuarterParams {
                quarter: PAST_QUARTER.into(),
            })
            .await
            .expect("list")
            .0
            .objectives[0]
            .key_results[0]
            .current_value
    };

    assert_eq!(progress_now().await, Some(0.0), "완료 0건 → 파생값 0");

    server
        .toggle_routine_check_for_date(ToggleRoutineCheckParams {
            routine_id: routine.id.clone(),
            date: DAY_IN_QUARTER.into(),
            done: true,
        })
        .await
        .expect("MCP toggle");

    assert_eq!(
        progress_now().await,
        Some(1.0),
        "MCP가 기록한 사실이 KR 파생값을 움직인다 — 의도된 결합"
    );

    // 가역: 사실을 취소하면 파생값도 되돌아온다(파괴적 write 아님).
    server
        .toggle_routine_check_for_date(ToggleRoutineCheckParams {
            routine_id: routine.id,
            date: DAY_IN_QUARTER.into(),
            done: false,
        })
        .await
        .expect("MCP untoggle");
    assert_eq!(progress_now().await, Some(0.0), "가역");
}
