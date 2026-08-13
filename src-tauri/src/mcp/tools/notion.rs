//! Notion write 툴 — 모든 caller가 승인 proposal을 생성한다(`write_routing`).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::external_actions::ExternalAction;
use crate::mcp::tools::queue::ProposeResult;
use crate::mcp::WrServer;

/// Notion 페이지 생성 제안 파라미터(`wr_notion_create_page`). project_id만 받아 서버가 검증한다(#11).
/// db_id는 원시 ID/URL을 허용한다 — 커넥터가 정규화한다(repo와 동일하게 *내용*이지 자격증명 아님).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct NotionCreatePageParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// 대상 Notion 데이터베이스 ID 또는 공유 URL(커넥터가 dashed UUID로 정규화).
    pub db_id: String,
    /// 페이지 제목.
    pub title: String,
}

#[tool_router(router = tool_router_notion, vis = "pub(crate)")]
impl WrServer {
    /// Notion DB 페이지 생성 제안을 만든다. project_id를 검증해 credential_ref를 해석한다(#11). 사람-origin 카드 승격(앱 내부)과는
    /// 별개 경로다(spec §4 이중 경로 — 이건 외부 에이전트 제안용).
    #[tool(
        name = "wr_notion_create_page",
        description = "Propose a Notion page for Work Radar approval. This tool never executes the external write directly; project_id is validated and db_id accepts a raw ID or share URL."
    )]
    pub async fn notion_create_page(
        &self,
        Parameters(p): Parameters<NotionCreatePageParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("Notion 페이지 생성: {}", p.title);
        let action = ExternalAction::NotionCreatePage {
            db_id: p.db_id,
            title: p.title,
        };
        self.enqueue_external_write_proposal(&p.project_id, action, &summary)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::NotionCreatePageParams;
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::external_actions::store;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::ProjectKind;
    use rmcp::handler::server::wrapper::Parameters;

    /// Notion: 알 수 없는 project_id → 거부 + enqueue 0(#11, GitHub와 동일한 격리 계약).
    #[tokio::test]
    async fn notion_create_page_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .notion_create_page(Parameters(NotionCreatePageParams {
                project_id: "does-not-exist".into(),
                db_id: "1234567890abcdef1234567890abcdef".into(),
                title: "할 일".into(),
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// Notion: 유효한 project_id → 그 프로젝트 credential_ref로 enqueue되고, 동일 제안은 dedup(큐 1건).
    #[tokio::test]
    async fn notion_create_page_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || NotionCreatePageParams {
            project_id: project.id.clone(),
            db_id: "1234567890abcdef1234567890abcdef".into(),
            title: "할 일".into(),
        };
        let first = server
            .notion_create_page(Parameters(params()))
            .await
            .unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        let second = server
            .notion_create_page(Parameters(params()))
            .await
            .unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    #[test]
    fn notion_create_page_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(NotionCreatePageParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "NotionCreatePageParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(prop_names(&v), expect(&["project_id", "db_id", "title"]));
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "db_id", "title"])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }
}
