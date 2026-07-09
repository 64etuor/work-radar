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
        "wr_gmail_send",
        "wr_bookkeeping_save_receipt",
        "wr_bookkeeping_list_recent_transactions",
        "wr_bookkeeping_list_review_queue",
        "wr_bookkeeping_monthly_summary",
        "wr_bookkeeping_get_category_rules",
        "wr_bookkeeping_find_duplicate_candidates",
        "wr_bookkeeping_mark_duplicate",
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
    // No execute/approve/delete/sql/shell/network capability ever appears on the surface.
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
