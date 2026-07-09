//! GitHub write 툴 — non-Hermes는 proposal, Hermes는 커넥터 직접 실행(`write_routing`).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::external_actions::ExternalAction;
use crate::mcp::tools::queue::ProposeResult;
use crate::mcp::write_routing::{HermesMcpExecutor, LiveHermesMcpExecutor};
use crate::mcp::{mcp_caller_from_env, McpCaller, WrServer};

/// GitHub 코멘트 제안 파라미터(`wr_github_comment`). proposer는 **project_id만** 준다 — 서버가
/// 실재성을 검증해 credential_ref를 해석한다(#11: raw project_ref/credential_ref 신뢰 금지).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct GithubCommentParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// "owner/repo".
    pub repo: String,
    /// 이슈/PR 번호.
    pub issue_number: u64,
    /// 코멘트 본문.
    pub body: String,
}

/// GitHub 이슈 생성 제안 파라미터(`wr_github_create_issue`). project_id만 받아 서버가 검증한다(#11).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct GithubCreateIssueParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회).
    pub project_id: String,
    /// "owner/repo".
    pub repo: String,
    /// 이슈 제목.
    pub title: String,
    /// 이슈 본문.
    pub body: String,
}

#[tool_router(router = tool_router_github, vis = "pub(crate)")]
impl WrServer {
    /// GitHub 이슈/PR 코멘트. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는
    /// Hermes permission card를 사람 게이트로 간주해 기존 Rust connector로 직접 실행한다.
    /// project_id를 검증해 credential_ref를 해석한다(#11).
    #[tool(
        name = "wr_github_comment",
        description = "Create a GitHub issue/PR comment when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated."
    )]
    pub async fn github_comment(
        &self,
        Parameters(p): Parameters<GithubCommentParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.github_comment_for_caller_with_executor(
            p,
            mcp_caller_from_env(),
            &LiveHermesMcpExecutor,
        )
        .await
    }

    pub(crate) async fn github_comment_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: GithubCommentParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("GitHub {}#{} 코멘트", p.repo, p.issue_number);
        let action = ExternalAction::GithubIssueComment {
            repo: p.repo,
            issue_number: p.issue_number,
            body: p.body,
        };
        self.route_write_for_caller(
            "wr_github_comment",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }

    /// GitHub 이슈 생성. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는 직접 실행한다.
    /// project_id를 검증해 credential_ref를 해석한다(#11).
    #[tool(
        name = "wr_github_create_issue",
        description = "Create a GitHub issue when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated."
    )]
    pub async fn github_create_issue(
        &self,
        Parameters(p): Parameters<GithubCreateIssueParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.github_create_issue_for_caller_with_executor(
            p,
            mcp_caller_from_env(),
            &LiveHermesMcpExecutor,
        )
        .await
    }

    pub(crate) async fn github_create_issue_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: GithubCreateIssueParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("GitHub {} 이슈 생성: {}", p.repo, p.title);
        let action = ExternalAction::GithubCreateIssue {
            repo: p.repo,
            title: p.title,
            body: p.body,
        };
        self.route_write_for_caller(
            "wr_github_create_issue",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::{GithubCommentParams, GithubCreateIssueParams};
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::external_actions::store;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::ProjectKind;
    use rmcp::handler::server::wrapper::Parameters;

    /// 알 수 없는 project_id → 툴이 에러를 반환하고 **아무것도 enqueue하지 않는다**(#11).
    #[tokio::test]
    async fn github_comment_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .github_comment(Parameters(GithubCommentParams {
                project_id: "does-not-exist".into(),
                repo: "o/r".into(),
                issue_number: 7,
                body: "hi".into(),
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// 유효한 project_id → enqueue되고 project_ref가 그 프로젝트의 credential_ref로 설정된다.
    /// 동일 제안 반복은 안정 멱등 키로 dedup(같은 action_id, 큐 1건).
    #[tokio::test]
    async fn github_comment_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || GithubCommentParams {
            project_id: project.id.clone(),
            repo: "o/r".into(),
            issue_number: 7,
            body: "hi".into(),
        };
        let first = server.github_comment(Parameters(params())).await.unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        // project_ref == 프로젝트 credential_ref(proposer가 준 raw 값이 아니라 서버가 해석).
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        // 동일 제안 재호출 → 안정 키로 dedup(같은 id, 큐 1건).
        let second = server.github_comment(Parameters(params())).await.unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    /// 내용이 다르면(다른 이슈 번호) 다른 멱등 키 → 별도 행.
    #[tokio::test]
    async fn github_create_issue_distinct_content_distinct_key() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let a = server
            .github_create_issue(Parameters(GithubCreateIssueParams {
                project_id: project.id.clone(),
                repo: "o/r".into(),
                title: "A".into(),
                body: "B".into(),
            }))
            .await
            .unwrap();
        let b = server
            .github_create_issue(Parameters(GithubCreateIssueParams {
                project_id: project.id.clone(),
                repo: "o/r".into(),
                title: "A2".into(),
                body: "B".into(),
            }))
            .await
            .unwrap();
        assert_ne!(a.0.action_id, b.0.action_id);
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 2);
    }

    #[test]
    fn github_comment_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(GithubCommentParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "GithubCommentParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "repo", "issue_number", "body"])
        );
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "repo", "issue_number", "body"])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }

    #[test]
    fn github_create_issue_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(GithubCreateIssueParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "GithubCreateIssueParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "repo", "title", "body"])
        );
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "repo", "title", "body"])
        );
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }
}
