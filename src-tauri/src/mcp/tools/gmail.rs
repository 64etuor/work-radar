//! Gmail write 툴 — non-Hermes는 proposal, Hermes는 커넥터 직접 실행(`write_routing`).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::external_actions::ExternalAction;
use crate::mcp::tools::queue::ProposeResult;
use crate::mcp::write_routing::{HermesMcpExecutor, LiveHermesMcpExecutor};
use crate::mcp::{mcp_caller_from_env, McpCaller, WrServer};

/// Gmail 발송 파라미터(`wr_gmail_send`). project_id만 받아 서버가 검증한다(#11).
/// to/subject/body는 발송 *내용* — 자격증명 아님(승인 후 keychain 토큰으로 Rust가 실행).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct GmailSendParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// 수신자 이메일 주소.
    pub to: String,
    /// 메일 제목.
    pub subject: String,
    /// 메일 본문(빈 본문도 유효 — 비어있음 검증 없음).
    pub body: String,
}

#[tool_router(router = tool_router_gmail, vis = "pub(crate)")]
impl WrServer {
    /// Gmail 발송. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는 직접 실행한다.
    /// project_id를 검증해 credential_ref를 해석한다(#11).
    /// C1: op_summary에 수신자+제목을 담아 승인 패널 preview가 정확한 대상을 사람에게 노출한다
    /// (chain-of-custody #2/#5). 수신자는 preview 컬럼에만 — audit detail(ref=…,bytes=…)에는 안 담긴다(US-004).
    #[tool(
        name = "wr_gmail_send",
        description = "Send a Gmail message when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated."
    )]
    pub async fn gmail_send(
        &self,
        Parameters(p): Parameters<GmailSendParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.gmail_send_for_caller_with_executor(p, mcp_caller_from_env(), &LiveHermesMcpExecutor)
            .await
    }

    pub(crate) async fn gmail_send_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: GmailSendParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("Gmail 발송 → {}: {}", p.to, p.subject);
        let action = ExternalAction::GmailSendEmail {
            to: p.to,
            subject: p.subject,
            body: p.body,
        };
        self.route_write_for_caller(
            "wr_gmail_send",
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
    use super::GmailSendParams;
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::external_actions::store;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::ProjectKind;
    use rmcp::handler::server::wrapper::Parameters;

    /// Gmail: 알 수 없는 project_id → 거부 + enqueue 0(#11, 다른 write 툴과 동일한 격리 계약).
    #[tokio::test]
    async fn gmail_send_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .gmail_send(Parameters(GmailSendParams {
                project_id: "does-not-exist".into(),
                to: "vip@client.test".into(),
                subject: "안녕하세요".into(),
                body: "본문".into(),
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// Gmail: 유효한 project_id → 그 프로젝트 credential_ref로 GmailSendEmail이 enqueue되고,
    /// 동일 제안은 안정 멱등 키로 dedup(같은 action_id, 큐 1건). C1: preview 컬럼이 수신자+제목을 노출해야 한다.
    #[tokio::test]
    async fn gmail_send_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || GmailSendParams {
            project_id: project.id.clone(),
            to: "vip@client.test".into(),
            subject: "주간 보고".into(),
            body: "본문".into(),
        };
        let first = server.gmail_send(Parameters(params())).await.unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        // project_ref == 프로젝트 credential_ref(proposer가 준 raw 값이 아니라 서버가 해석).
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        // C1(chain-of-custody #2/#5): preview 컬럼은 승인자가 정확한 수신자+제목을 보도록 그 값을 담아야 한다.
        // (수신자는 preview에만 — audit detail에는 ref/bytes만, US-004.)
        let preview: Option<String> =
            sqlx::query_scalar("SELECT preview FROM external_actions WHERE id = ?1")
                .bind(&id1)
                .fetch_one(&db)
                .await
                .unwrap();
        let preview = preview.unwrap();
        assert!(
            preview.contains("vip@client.test"),
            "preview는 수신자를 노출해야 함(C1): {preview}"
        );
        assert!(preview.contains("주간 보고"), "preview는 제목도 노출");
        // 동일 제안 재호출 → 안정 키로 dedup(같은 id, 큐 1건).
        let second = server.gmail_send(Parameters(params())).await.unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    #[test]
    fn gmail_send_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(GmailSendParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "GmailSendParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "to", "subject", "body"])
        );
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "to", "subject", "body"])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }
}
