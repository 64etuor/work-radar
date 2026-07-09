//! Google Calendar 툴 — write는 non-Hermes proposal / Hermes 직접 실행(`write_routing`).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::external_actions::ExternalAction;
use crate::mcp::tools::queue::ProposeResult;
use crate::mcp::write_routing::{HermesMcpExecutor, LiveHermesMcpExecutor};
use crate::mcp::{mcp_caller_from_env, McpCaller, WrServer};

/// Google Calendar 이벤트 생성 파라미터(`wr_calendar_create_event`). project_id만 받아 서버가 검증한다(#11).
/// start/end는 RFC3339(timed) 또는 YYYY-MM-DD(all_day) — *내용*이지 자격증명 아님(커넥터가 해석).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct CalendarCreateEventParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// 대상 캘린더 ID.
    pub calendar_id: String,
    /// 이벤트 제목.
    pub title: String,
    /// 시작 시각: RFC3339(timed) 또는 YYYY-MM-DD(all_day).
    pub start: String,
    /// 종료 시각: RFC3339(timed) 또는 YYYY-MM-DD(all_day).
    pub end: String,
    /// 종일 이벤트 여부.
    pub all_day: bool,
    /// 이벤트 설명(선택).
    pub description: Option<String>,
}

#[tool_router(router = tool_router_calendar, vis = "pub(crate)")]
impl WrServer {
    /// Google Calendar 이벤트 생성을 기본적으로 **제안만** 한다 — 실행 안 함(사용자 승인 후 Rust
    /// 커넥터가 실행). 예외: work-radar Hermes가 ACP permission card로 이미 사용자 확인을 받은
    /// 세션(`WORK_RADAR_MCP_CALLER=hermes`)에서는 즉시 생성한다. project_id를 검증해 credential_ref를
    /// 해석하고(#11), proposal 경로는 안정 멱등 키로 enqueue한다.
    #[tool(
        name = "wr_calendar_create_event",
        description = "Create a Google Calendar event only when called by work-radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated; start/end accept RFC3339 or YYYY-MM-DD for all-day."
    )]
    pub async fn calendar_create_event(
        &self,
        Parameters(p): Parameters<CalendarCreateEventParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.calendar_create_event_for_caller(p, mcp_caller_from_env())
            .await
    }

    pub(crate) async fn calendar_create_event_for_caller(
        &self,
        p: CalendarCreateEventParams,
        caller: McpCaller,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.calendar_create_event_for_caller_with_executor(p, caller, &LiveHermesMcpExecutor)
            .await
    }

    pub(crate) async fn calendar_create_event_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: CalendarCreateEventParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("Calendar 이벤트 생성: {}", p.title);
        let action = ExternalAction::CalendarCreateEvent {
            calendar_id: p.calendar_id,
            title: p.title,
            start: p.start,
            end: p.end,
            all_day: p.all_day,
            description: p.description,
        };
        self.route_write_for_caller(
            "wr_calendar_create_event",
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
    use super::CalendarCreateEventParams;
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::external_actions::store;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::{McpCaller, WrServer};
    use crate::models::ProjectKind;
    use rmcp::handler::server::wrapper::Parameters;

    /// Calendar: 알 수 없는 project_id → 거부 + enqueue 0(#11, GitHub/Notion과 동일한 격리 계약).
    #[tokio::test]
    async fn calendar_create_event_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .calendar_create_event(Parameters(CalendarCreateEventParams {
                project_id: "does-not-exist".into(),
                calendar_id: "primary".into(),
                title: "회의".into(),
                start: "2026-06-04T10:00:00+09:00".into(),
                end: "2026-06-04T11:00:00+09:00".into(),
                all_day: false,
                description: None,
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// Calendar: 유효한 project_id → 그 프로젝트 credential_ref로 CalendarCreateEvent가 enqueue되고,
    /// 동일 제안은 안정 멱등 키로 dedup(같은 action_id, 큐 1건).
    #[tokio::test]
    async fn calendar_create_event_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || CalendarCreateEventParams {
            project_id: project.id.clone(),
            calendar_id: "primary".into(),
            title: "회의".into(),
            start: "2026-06-04T10:00:00+09:00".into(),
            end: "2026-06-04T11:00:00+09:00".into(),
            all_day: false,
            description: Some("주간 동기화".into()),
        };
        let first = server
            .calendar_create_event_for_caller(params(), McpCaller::Other)
            .await
            .unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        // project_ref == 프로젝트 credential_ref(proposer가 준 raw 값이 아니라 서버가 해석).
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        // 동일 제안 재호출 → 안정 키로 dedup(같은 id, 큐 1건).
        let second = server
            .calendar_create_event_for_caller(params(), McpCaller::Other)
            .await
            .unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    /// Hermes-origin Calendar 호출은 승인 큐에 enqueue하지 않는다. 알 수 없는 project_id도 즉시 거부된다.
    #[tokio::test]
    async fn hermes_calendar_create_event_rejects_unknown_project_without_enqueue() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .calendar_create_event_for_caller(
                CalendarCreateEventParams {
                    project_id: "does-not-exist".into(),
                    calendar_id: "primary".into(),
                    title: "회의".into(),
                    start: "2026-06-04T10:00:00+09:00".into(),
                    end: "2026-06-04T11:00:00+09:00".into(),
                    all_day: false,
                    description: None,
                },
                McpCaller::Hermes,
            )
            .await;
        assert!(
            res.is_err(),
            "Hermes direct 경로도 unknown project_id는 거부"
        );
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "Hermes direct 경로는 승인 큐에 enqueue하지 않음"
        );
    }

    #[test]
    fn calendar_create_event_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(CalendarCreateEventParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "CalendarCreateEventParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&[
                "project_id",
                "calendar_id",
                "title",
                "start",
                "end",
                "all_day",
                "description",
            ])
        );
        // description은 Option → required 아님; 나머지는 required.
        assert_eq!(
            required_fields(&v),
            expect(&[
                "project_id",
                "calendar_id",
                "title",
                "start",
                "end",
                "all_day"
            ])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }
}
