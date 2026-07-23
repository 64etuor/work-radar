//! 도메인을 가로지르는 MCP 표면 가드 — 툴 이름 집합 고정 + Hermes 직접 실행 경로.
//!
//! 도메인별 enqueue/dedup/스키마 테스트는 각 `tools/<domain>.rs`가 소유한다. 여기에는
//! **어느 한 도메인에도 속하지 않는** 계약만 둔다.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::commands::projects::insert_project;
use crate::commands::shared::test_support::{fresh_db, project_input};
use crate::error::AppError;
use crate::external_actions::{store, ExecOutcome, ExternalAction};
use crate::mcp::tools::bookkeeping_budgets::{
    BookkeepingBudgetIdParams, BookkeepingBudgetScopeParams, BookkeepingSetBudgetParams,
};
use crate::mcp::tools::bookkeeping_transactions::{
    BookkeepingReviewDecisionParams, BookkeepingReviewStatusParam, BookkeepingSetLineItemsParams,
    BookkeepingTransactionIdParams, BookkeepingUpdateTransactionParams,
};
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
        "wr_bookkeeping_flag_duplicate",
        "wr_bookkeeping_budget_status",
        "wr_bookkeeping_list_recurring_expenses",
        "wr_bookkeeping_update_transaction",
        "wr_bookkeeping_set_review_status",
        "wr_bookkeeping_list_trash",
        "wr_bookkeeping_trash_transaction",
        "wr_bookkeeping_restore_transaction",
        "wr_bookkeeping_list_line_items",
        "wr_bookkeeping_set_line_items",
        "wr_bookkeeping_set_budget",
        "wr_bookkeeping_list_budgets",
        "wr_bookkeeping_remove_budget",
        // 고정비는 MoneyManager 미러 전용(2026-07-23 사용자 결정) — 반복 지출
        // 생성/상태변경/occurrence 툴은 제거됐고 read(list_recurring_expenses)만 남는다.
        "wr_diet_daily_nutrition",
        "wr_diet_meals_for_date",
        "wr_diet_pantry_summary",
        "wr_diet_expiring_pantry",
        "wr_diet_shopping_list",
        "wr_diet_search_foods",
        "wr_diet_record_meal",
        // diet 전권 위임(2026-07-17 사용자 결정 — tools/diet_manage.rs 모듈 doc의 레일 논증 참조).
        "wr_diet_list_meal_plans",
        "wr_diet_get_meal_plan",
        "wr_diet_meal_logs",
        "wr_diet_list_recipes",
        "wr_diet_list_orders",
        "wr_diet_set_goal",
        "wr_diet_create_meal_plan",
        "wr_diet_set_meal_plan_status",
        "wr_diet_add_meal",
        "wr_diet_remove_meal",
        "wr_diet_set_meal_status",
        "wr_diet_add_meal_item",
        "wr_diet_remove_meal_item",
        "wr_diet_retract_meal_log",
        "wr_diet_upsert_food",
        "wr_diet_create_recipe",
        "wr_diet_update_recipe",
        "wr_diet_add_pantry_lot",
        "wr_diet_consume_pantry",
        "wr_diet_adjust_pantry_lot",
        "wr_diet_waste_pantry_lot",
        "wr_diet_record_order",
        "wr_diet_set_order_status",
        "wr_diet_link_order_line",
        "wr_diet_receive_order_line",
        // reading 도메인 위임(2026-07-23 사용자 결정 — tools/reading.rs 모듈 doc의 레일 논증 참조).
        // delete류는 표면에 없다(앱 UI confirm 전용). search_catalog만 고정 provider 아웃바운드(ADR-0013).
        "wr_reading_search_catalog",
        "wr_reading_add_book",
        "wr_reading_list_books",
        "wr_reading_get_book",
        "wr_reading_set_status",
        "wr_reading_log_session",
        "wr_reading_add_quote",
        "wr_reading_stats",
        "wr_reading_set_goal",
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

#[tokio::test]
async fn delegated_finance_tools_manage_ledger_and_budget() {
    use crate::mcp::tools::bookkeeping::BookkeepingSaveReceiptParams;

    let db = fresh_db().await;
    let server = WrServer { db };
    let saved = server
        .bookkeeping_save_receipt_inner(BookkeepingSaveReceiptParams {
            project_id: None,
            source_ref: Some("finance-delegation-1".into()),
            merchant: "급여".into(),
            amount_minor: 3_000_000,
            currency: Some("KRW".into()),
            spent_at: "2026-07-22".into(),
            category: Some("수입".into()),
            description: None,
            note: None,
            direction: Some("income".into()),
            account: None,
            subcategory: None,
            category_code: Some("income".into()),
            subcategory_code: None,
            raw_category: None,
            spent_at_time: None,
            confidence: None,
            field_confidence: None,
            review_reasons: None,
            order_no: None,
            payment_no: None,
            line_items: None,
        })
        .await
        .expect("save transaction")
        .0;

    let updated = server
        .bookkeeping_update_transaction_inner(BookkeepingUpdateTransactionParams {
            id: saved.transaction_id.clone(),
            note: Some("7월 급여".into()),
            ..Default::default()
        })
        .await
        .expect("update transaction")
        .0;
    assert_eq!(updated.note.as_deref(), Some("7월 급여"));

    let approved = server
        .bookkeeping_set_review_status_inner(BookkeepingReviewDecisionParams {
            id: saved.transaction_id.clone(),
            status: BookkeepingReviewStatusParam::Approved,
        })
        .await
        .expect("approve transaction")
        .0;
    assert_eq!(approved.review_status, "approved");

    let trashed = server
        .bookkeeping_trash_transaction_inner(BookkeepingTransactionIdParams {
            id: saved.transaction_id.clone(),
        })
        .await
        .expect("trash transaction")
        .0;
    assert!(trashed.trashed);
    let restored = server
        .bookkeeping_restore_transaction_inner(BookkeepingTransactionIdParams {
            id: saved.transaction_id.clone(),
        })
        .await
        .expect("restore transaction")
        .0;
    assert!(!restored.trashed);

    let line_items = server
        .bookkeeping_set_line_items_inner(BookkeepingSetLineItemsParams {
            transaction_id: saved.transaction_id.clone(),
            items: vec![crate::mcp::BookkeepingLineItemParam {
                name: "기본급".into(),
                amount_minor: 3_000_000,
                quantity: Some(1),
                category_code: Some("income_salary".into()),
            }],
        })
        .await
        .expect("set line items")
        .0;
    assert_eq!(line_items.item_count, 1);
    let listed = server
        .bookkeeping_list_line_items_inner(BookkeepingTransactionIdParams {
            id: saved.transaction_id,
        })
        .await
        .expect("list line items")
        .0;
    assert_eq!(listed.items.len(), 1);

    let budget = server
        .bookkeeping_set_budget_inner(BookkeepingSetBudgetParams {
            project_id: None,
            month: "2026-07".into(),
            category_code: "food".into(),
            limit_minor: 500_000,
            currency: Some("KRW".into()),
            rollover: false,
            note: None,
        })
        .await
        .expect("set budget")
        .0;
    assert_eq!(budget.limit_minor, 500_000);
    let listed_budgets = server
        .bookkeeping_list_budgets_inner(BookkeepingBudgetScopeParams {
            project_id: None,
            month: "2026-07".into(),
        })
        .await
        .expect("list budgets")
        .0;
    assert_eq!(listed_budgets.budgets.len(), 1);
    assert_eq!(listed_budgets.budgets[0].id, budget.id);
    let removed = server
        .bookkeeping_remove_budget_inner(BookkeepingBudgetIdParams { id: budget.id })
        .await
        .expect("remove budget")
        .0;
    assert!(removed.removed);
}

#[tokio::test]
async fn finance_management_rejects_oversized_text_before_writing() {
    let server = WrServer {
        db: fresh_db().await,
    };
    let oversized = "x".repeat(501);

    let line_items = server
        .bookkeeping_set_line_items_inner(BookkeepingSetLineItemsParams {
            transaction_id: "missing".into(),
            items: vec![crate::mcp::BookkeepingLineItemParam {
                name: oversized.clone(),
                amount_minor: 1,
                quantity: Some(1),
                category_code: None,
            }],
        })
        .await;
    assert!(line_items.is_err());

    let too_many_items = server
        .bookkeeping_set_line_items_inner(BookkeepingSetLineItemsParams {
            transaction_id: "missing".into(),
            items: (0..201)
                .map(|index| crate::mcp::BookkeepingLineItemParam {
                    name: format!("item-{index}"),
                    amount_minor: 1,
                    quantity: Some(1),
                    category_code: None,
                })
                .collect(),
        })
        .await;
    assert!(too_many_items.is_err());

    let budget = server
        .bookkeeping_set_budget_inner(BookkeepingSetBudgetParams {
            project_id: None,
            month: "2026-07".into(),
            category_code: oversized.clone(),
            limit_minor: 1,
            currency: Some("KRW".into()),
            rollover: false,
            note: None,
        })
        .await;
    assert!(budget.is_err());
}

/// §2 전역 가드: **등록된 모든 툴의 입력 스키마가 닫혀 있어야 한다**(`additionalProperties:false`).
/// 도메인별 스키마 테스트는 그 도메인 struct만 본다 — 새 param struct에 `deny_unknown_fields`를
/// 빠뜨리면 아무도 안 잡는다. 라우터가 광고하는 실제 스키마를 직접 순회해 그 구멍을 막는다.
///
/// 파라미터 없는 툴(`wr_list_projects` 등)은 빈 object 스키마라 대상이 아니다.
/// 문자열 enum(`quadrant`, `confidence` …)은 `additionalProperties`가 애초에 적용되지 않는다.
#[test]
fn every_registered_tool_has_a_closed_input_schema() {
    let mut open: Vec<String> = Vec::new();
    for tool in WrServer::tool_router().list_all() {
        let schema = tool.input_schema.as_ref();
        let has_properties = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .is_some_and(|p| !p.is_empty());
        if !has_properties {
            continue; // 파라미터 없는 툴.
        }
        if schema.get("additionalProperties") != Some(&serde_json::json!(false)) {
            open.push(tool.name.to_string());
        }
    }
    assert!(
        open.is_empty(),
        "these tools accept unknown fields (add #[serde(deny_unknown_fields)]): {open:?}"
    );
}

/// §6 전역 가드: tool description은 **기능 설명만** 담는다. 모델 지시문("always use this",
/// "ignore other tools", "don't ask")은 tool-poisoning 표면이다.
#[test]
fn no_tool_description_contains_model_directives() {
    const DIRECTIVES: [&str; 6] = [
        "always use",
        "ignore other",
        "do not ask",
        "don't ask",
        "whenever possible",
        "you must use",
    ];
    for tool in WrServer::tool_router().list_all() {
        let Some(description) = tool.description.as_ref() else {
            continue;
        };
        let lowered = description.to_lowercase();
        for directive in DIRECTIVES {
            assert!(
                !lowered.contains(directive),
                "tool `{}` description contains a model directive: {directive:?}",
                tool.name
            );
        }
    }
}

/// 결정 레일(INVARIANT #1) 회귀 가드. `registered_tool_set_is_locked`의 allowlist는 "표면이 바뀌었다"만
/// 알려주고, 갱신하는 사람이 그 툴이 **결정 레일인지**는 판단하지 않는다. 여기서 결정 어휘 자체를
/// 못 박아, 스냅샷을 갱신하면서 무심코 `wr_classify_signal`을 들이는 일을 막는다.
///
/// **이 테스트가 보장하는 것의 한계를 정확히 알 것.** 이건 *이름* 가드다 — 결정 레일 커맨드를
/// 그 이름으로 등록하는 것만 막는다. **행동**은 못 막는다: `wr_toggle_routine_check`는 여기 걸리는
/// 이름이 하나도 없지만 루틴 연결 KR의 progress를 실제로 움직인다(의도된 결합 —
/// `routine_toggle_moves_a_routine_linked_key_result_by_design` 참조). 새 write 툴을 추가할 때
/// 이 테스트가 green이라는 사실은 **결정 레일 안전의 증거가 아니다**; 파생 경로를 손으로 따라가라.
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
        "wr_bookkeeping_delete_transaction",
        // Bookkeeping: 2026-07-22 사용자 결정으로 재정 도메인 전권을 에이전트에 위임했다.
        // 사람 게이트는 호스트 승인 UI이며 삭제는 소프트 삭제 후 복원 가능하다.
        // Diet: 2026-07-17 사용자 결정으로 도메인 전권을 에이전트에 위임 — 이 목록에서 diet
        // 항목을 의도적으로 제거했다(사람 게이트 = 호스트 승인 UI, ADR-0012). 레일 논증은
        // `tools/diet_manage.rs` 모듈 doc이 정본이다.
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
