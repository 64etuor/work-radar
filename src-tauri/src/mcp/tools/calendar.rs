//! Google Calendar 툴 — write는 non-Hermes proposal / Hermes 직접 실행(`write_routing`).
//!
//! **`wr_calendar_list_events`는 MCP 표면의 유일한 read-only outbound다**(ADR-0012 §3).
//! 캘린더 이벤트는 로컬 DB에 없다 — `calendar_events_cache()`는 프로세스 내 60초 TTL 캐시라
//! MCP 프로세스의 첫 조회는 항상 Google 라운드트립이다. 목적지는 코드 상수이고 caller 입력은
//! URL에 닿지 않는다(스키마에 host/path/url 필드 없음). 토큰은 project_id → credential_ref →
//! keychain으로만 해석된다.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::calendar::fetch_calendar_events_range_inner;
use crate::external_actions::ExternalAction;
use crate::mcp::tools::queue::ProposeResult;
use crate::mcp::write_routing::{HermesMcpExecutor, LiveHermesMcpExecutor};
use crate::mcp::{mcp_caller_from_env, mcp_tool_error, McpCaller, WrServer};

/// 조회 윈도우 상한(일). 무제한 히스토리 덤프를 막는다(§7 최소권한).
const MAX_WINDOW_DAYS: i64 = 62;

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

/// 조회 파라미터(`wr_calendar_list_events`). URL/host/path 필드는 **존재하지 않는다** — caller가
/// 네트워크 목적지를 정할 수 없다는 것이 §7 개정의 핵심이다.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CalendarListEventsParams {
    /// 대상 프로젝트 id. 생략하면 모든 프로젝트의 선택 캘린더를 병합한다.
    pub project_id: Option<String>,
    /// 조회 시작일 YYYY-MM-DD(로컬).
    pub start_date: String,
    /// 조회 종료일 YYYY-MM-DD(로컬, inclusive). start_date로부터 최대 62일.
    pub end_date: String,
}

/// 표시 전용 필드(색·위치·딥링크)를 뺀 최소 이벤트(§7 — 다른 MCP 서버로의 유출 표면 최소화).
#[derive(Serialize, JsonSchema)]
pub struct CalendarEventDto {
    pub id: String,
    pub calendar_id: String,
    /// 캘린더 표시 이름(이벤트 제목과 별개).
    pub calendar_summary: String,
    pub title: String,
    /// timed = RFC3339, all-day = YYYY-MM-DD.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub project_id: String,
}

#[derive(Serialize, JsonSchema)]
pub struct CalendarEventListDto {
    pub events: Vec<CalendarEventDto>,
}

/// 윈도우를 파싱·검증한다. 잘못된 날짜가 조용히 빈 목록이 되면 caller는 "일정 없음"으로 오해한다.
#[allow(clippy::result_large_err)]
fn clean_window(start: &str, end: &str) -> Result<(String, String), rmcp::ErrorData> {
    let parse = |raw: &str| {
        chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").map_err(|_| {
            rmcp::ErrorData::invalid_params(format!("date must be YYYY-MM-DD (got: {raw})"), None)
        })
    };
    let s = parse(start)?;
    let e = parse(end)?;
    if e < s {
        return Err(rmcp::ErrorData::invalid_params(
            "end_date must not precede start_date",
            None,
        ));
    }
    if (e - s).num_days() > MAX_WINDOW_DAYS {
        return Err(rmcp::ErrorData::invalid_params(
            format!("window exceeds {MAX_WINDOW_DAYS} days"),
            None,
        ));
    }
    Ok((
        s.format("%Y-%m-%d").to_string(),
        e.format("%Y-%m-%d").to_string(),
    ))
}

#[tool_router(router = tool_router_calendar, vis = "pub(crate)")]
impl WrServer {
    /// 연결된 Google Calendar를 **읽기 전용**으로 조회한다(ADR-0012 §3). 목적지는 코드 상수.
    #[tool(
        name = "wr_calendar_list_events",
        description = "List Google Calendar events in a date window (max 62 days) across the selected calendars. Projects with no Google connection or no selected calendars are skipped, so an empty list can mean 'not connected' as well as 'nothing scheduled'. Read-only; returns title/time/calendar only."
    )]
    pub async fn calendar_list_events(
        &self,
        Parameters(p): Parameters<CalendarListEventsParams>,
    ) -> Result<Json<CalendarEventListDto>, rmcp::ErrorData> {
        self.calendar_list_events_inner(p).await
    }

    pub(crate) async fn calendar_list_events_inner(
        &self,
        p: CalendarListEventsParams,
    ) -> Result<Json<CalendarEventListDto>, rmcp::ErrorData> {
        let (start_date, end_date) = clean_window(&p.start_date, &p.end_date)?;
        // force_refresh=false — 같은 프로세스 안 반복 호출은 60초 TTL 캐시가 흡수한다(rate limit 방어).
        let events = fetch_calendar_events_range_inner(
            &self.db,
            p.project_id,
            &start_date,
            &end_date,
            false,
        )
        .await
        .map_err(|e| mcp_tool_error("wr_calendar_list_events", &e))?;
        Ok(Json(CalendarEventListDto {
            events: events
                .into_iter()
                .map(|e| CalendarEventDto {
                    id: e.id,
                    calendar_id: e.calendar_id,
                    calendar_summary: e.calendar_summary,
                    title: e.title,
                    start: e.start,
                    end: e.end,
                    all_day: e.all_day,
                    project_id: e.project_id,
                })
                .collect(),
        }))
    }

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
    use super::{CalendarCreateEventParams, CalendarEventDto, CalendarListEventsParams};
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::external_actions::store;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::{McpCaller, WrServer};
    use crate::models::ProjectKind;
    use rmcp::handler::server::wrapper::Parameters;

    /// 윈도우 검증은 **네트워크에 닿기 전에** 끝난다 — 아래 케이스는 Google을 호출하지 않는다.
    #[tokio::test]
    async fn calendar_list_events_validates_window_before_any_fetch() {
        let db = fresh_db().await;
        let server = WrServer { db };
        let window = |start: &str, end: &str| CalendarListEventsParams {
            project_id: None,
            start_date: start.into(),
            end_date: end.into(),
        };

        for (start, end, why) in [
            ("2026/07/06", "2026-07-07", "형식 강제"),
            ("2026-07-06", "07-07-2026", "형식 강제"),
            ("2026-07-08", "2026-07-06", "end < start"),
            ("2026-01-01", "2026-03-15", "62일 초과"),
        ] {
            assert!(
                server
                    .calendar_list_events_inner(window(start, end))
                    .await
                    .is_err(),
                "{why}: {start}..{end}"
            );
        }

        // 경계값(정확히 62일)은 통과한다. 연결된 프로젝트가 없으므로 빈 목록 — 네트워크 호출 0.
        let ok = server
            .calendar_list_events_inner(window("2026-01-01", "2026-03-04"))
            .await
            .expect("62-day window accepted");
        assert!(
            ok.0.events.is_empty(),
            "미연결 프로젝트는 건너뛴다(graceful degrade)"
        );
    }

    /// §7 최소권한: 표시 전용/유출 가치 있는 필드는 read DTO 표면에 없다.
    #[test]
    fn calendar_event_dto_is_minimal() {
        let v = serde_json::to_value(schemars::schema_for!(CalendarEventDto)).unwrap();
        assert_eq!(
            prop_names(&v),
            expect(&[
                "id",
                "calendar_id",
                "calendar_summary",
                "title",
                "start",
                "end",
                "all_day",
                "project_id",
            ])
        );
        for forbidden in [
            "location",
            "url",
            "project_color",
            "project_text_color",
            "recurring_event_id",
        ] {
            assert!(
                !prop_names(&v).contains(forbidden),
                "minimal read DTO must not expose `{forbidden}`"
            );
        }
    }

    /// caller는 네트워크 목적지를 정할 수 없다 — §7 개정의 핵심 명제를 스키마로 고정한다.
    #[test]
    fn calendar_list_events_params_carry_no_destination_fields() {
        let v = serde_json::to_value(schemars::schema_for!(CalendarListEventsParams)).unwrap();
        assert_eq!(v["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "start_date", "end_date"])
        );
        assert_eq!(required_fields(&v), expect(&["start_date", "end_date"]));
        for forbidden in [
            "url",
            "host",
            "path",
            "query",
            "endpoint",
            "calendar_url",
            "token",
        ] {
            assert!(
                !prop_names(&v).contains(forbidden),
                "caller must not be able to steer the network destination: `{forbidden}`"
            );
        }
    }

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
