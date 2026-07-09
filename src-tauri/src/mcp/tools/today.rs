//! Today 콕핏 · 루틴 · 타임라인 메모 — 로컬 SQLite 표면.
//!
//! **`wr_today_overview`는 `fetch_today_overview`를 부른다.** 겉보기 read인 `today_overview`
//! 커맨드는 `upsert_debt_snapshot`으로 DB에 쓴다 — read 툴이 그걸 부르면 에이전트 폴링이
//! 부채 스냅샷 히스토리를 오염시킨다.
//!
//! write는 관측 기록 둘뿐이다: 루틴 완료 토글("했다/안 했다")과 타임라인 메모.
//! Today 승격/해제/완료(`promote_today`·`unpromote_today`·`toggle_today_done`)는 결정 레일이라
//! 표면에 **없다**.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use chrono::Datelike;

use crate::commands::routines::{fetch_today_routines, toggle_routine_check_inner};
use crate::commands::timeline_notes;
use crate::commands::today::fetch_today_overview;
use crate::error::AppError;
use crate::mcp::{db_tool_error, enum_wire_string, mcp_tool_error, truncate_preview, WrServer};
use crate::models::{RoutineToday, TimelineNote, TimelineNoteTarget, Weekday};

/// 타임라인 메모 본문 입력 상한(§2).
const NOTE_BODY_MAX_CHARS: usize = 4000;
/// 메모 읽기 preview 상한(§6 — output도 다음 툴의 injection 입력이 될 수 있다).
const NOTE_PREVIEW_CHARS: usize = 1000;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TodayDateParams {
    /// 로컬 날짜 YYYY-MM-DD.
    pub date: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToggleRoutineCheckParams {
    /// 대상 루틴 id(`wr_list_today_routines`로 조회).
    pub routine_id: String,
    /// 로컬 날짜 YYYY-MM-DD.
    pub date: String,
    /// true=완료 표시, false=완료 해제.
    pub done: bool,
}

/// 메모 대상 종류(닫힌 enum — SQL CHECK과 동기).
#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum TimelineNoteTargetParam {
    Signal,
    Routine,
    Event,
}

impl From<TimelineNoteTargetParam> for TimelineNoteTarget {
    fn from(t: TimelineNoteTargetParam) -> Self {
        match t {
            TimelineNoteTargetParam::Signal => TimelineNoteTarget::Signal,
            TimelineNoteTargetParam::Routine => TimelineNoteTarget::Routine,
            TimelineNoteTargetParam::Event => TimelineNoteTarget::Event,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpsertTimelineNoteParams {
    /// 메모를 붙일 대상 종류.
    pub target_kind: TimelineNoteTargetParam,
    /// 대상 id(신호 id / 루틴 id / 캘린더 이벤트 id).
    pub target_id: String,
    /// 로컬 날짜 YYYY-MM-DD.
    pub date: String,
    /// 메모 본문(≤4000자). **공백만 보내면 메모가 삭제된다**(기존 앱 계약과 동일).
    pub body: String,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkDebtDto {
    /// 미분류 활성 카드 수.
    pub unclassified: u32,
    /// q1이면서 하루 넘게 남은 카드 수.
    pub q1_overdue: u32,
    /// 14일 넘게 멈춘 활성 카드 수.
    pub stale_backlog: u32,
    /// 정리 필요(cleanup) 카드 수.
    pub cleanup_needed: u32,
}

/// Today 콕핏이 끌어올릴 후보 신호(메타만 — 본문 없음).
#[derive(Serialize, JsonSchema)]
pub struct SignalRefDto {
    pub id: String,
    pub title: String,
    pub quadrant: String,
}

#[derive(Serialize, JsonSchema)]
pub struct TodayOverviewDto {
    pub date: String,
    pub work_debt: WorkDebtDto,
    /// 사람이 q1으로 분류했고 아직 Today 레일에 없는 활성 신호.
    pub q1_items: Vec<SignalRefDto>,
    /// 매트릭스로 escalate된 PR 신호 수(본문은 PR Radar 뷰에 있다).
    pub pr_attention_count: u32,
}

#[derive(Serialize, JsonSchema)]
pub struct RoutineTodayDto {
    pub id: String,
    pub title: String,
    /// "daily" | "weekly" | "biweekly" | "monthly".
    pub freq: String,
    /// 정의상의 시각 'HH:MM'(없으면 null).
    pub time_of_day: Option<String>,
    /// 오늘만 적용되는 시각 override 'HH:MM'.
    pub time_override: Option<String>,
    pub duration_min: Option<u32>,
    pub area: Option<String>,
    pub kind: Option<String>,
    /// 이 날짜에 완료 체크됐는지.
    pub done: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct RoutineTodayListDto {
    pub routines: Vec<RoutineTodayDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct TimelineNoteDto {
    /// "signal" | "routine" | "event".
    pub target_kind: String,
    pub target_id: String,
    pub date: String,
    /// 본문 앞부분(≤1000자).
    pub body_preview: String,
    /// `body_preview`가 잘렸는지.
    pub body_truncated: bool,
    pub updated_at: String,
}

#[derive(Serialize, JsonSchema)]
pub struct TimelineNoteListDto {
    pub notes: Vec<TimelineNoteDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct UpsertTimelineNoteResult {
    /// 저장됐으면 "saved", 빈 본문이라 삭제됐으면 "cleared".
    pub status: String,
}

#[derive(Serialize, JsonSchema)]
pub struct ToggleRoutineCheckResult {
    pub routine_id: String,
    pub date: String,
    pub done: bool,
}

/// 'YYYY-MM-DD'를 강제하고 파싱한다. 하위 스토어는 대개 문자열 비교라 잘못된 날짜가 조용히
/// 빈 결과가 된다 — caller는 그걸 "그날 아무것도 없다"로 오해한다.
#[allow(clippy::result_large_err)]
fn clean_date(raw: &str) -> Result<chrono::NaiveDate, rmcp::ErrorData> {
    chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").map_err(|_| {
        rmcp::ErrorData::invalid_params(format!("date must be YYYY-MM-DD (got: {raw})"), None)
    })
}

/// 날짜에서 요일을 **서버가 파생**한다. caller가 보낸 weekday와 date가 어긋날 여지를 없앤다.
fn weekday_of(date: chrono::NaiveDate) -> Weekday {
    match date.weekday() {
        chrono::Weekday::Mon => Weekday::Mon,
        chrono::Weekday::Tue => Weekday::Tue,
        chrono::Weekday::Wed => Weekday::Wed,
        chrono::Weekday::Thu => Weekday::Thu,
        chrono::Weekday::Fri => Weekday::Fri,
        chrono::Weekday::Sat => Weekday::Sat,
        chrono::Weekday::Sun => Weekday::Sun,
    }
}

fn to_routine_dto(r: RoutineToday) -> RoutineTodayDto {
    RoutineTodayDto {
        id: r.id,
        title: r.title,
        freq: enum_wire_string(&r.freq),
        time_of_day: r.time_of_day,
        time_override: r.time_override,
        duration_min: r.duration_min,
        area: r.area.map(|a| enum_wire_string(&a)),
        kind: r.kind.map(|k| enum_wire_string(&k)),
        done: r.done,
    }
}

fn to_note_dto(n: TimelineNote) -> TimelineNoteDto {
    let body_truncated = n.body.chars().count() > NOTE_PREVIEW_CHARS;
    TimelineNoteDto {
        target_kind: enum_wire_string(&n.target_kind),
        target_id: n.target_id,
        date: n.date,
        body_preview: truncate_preview(&n.body, NOTE_PREVIEW_CHARS),
        body_truncated,
        updated_at: n.updated_at,
    }
}

#[tool_router(router = tool_router_today, vis = "pub(crate)")]
impl WrServer {
    /// Today 콕핏 집계(순수 read — `fetch_today_overview`).
    #[tool(
        name = "wr_today_overview",
        description = "Work-debt counters for a date plus the q1 cards not yet on the Today rail. Read-only; writes nothing."
    )]
    pub async fn today_overview(
        &self,
        Parameters(p): Parameters<TodayDateParams>,
    ) -> Result<Json<TodayOverviewDto>, rmcp::ErrorData> {
        self.today_overview_inner(p).await
    }

    pub(crate) async fn today_overview_inner(
        &self,
        p: TodayDateParams,
    ) -> Result<Json<TodayOverviewDto>, rmcp::ErrorData> {
        let date = clean_date(&p.date)?;
        let date = date.format("%Y-%m-%d").to_string();
        // `today_overview` 커맨드가 아니라 순수 read 코어를 부른다(모듈 doc 참조).
        let overview = fetch_today_overview(&self.db, &date)
            .await
            .map_err(|e| db_tool_error("wr_today_overview", &AppError::from(e)))?;
        Ok(Json(TodayOverviewDto {
            date,
            work_debt: WorkDebtDto {
                unclassified: overview.work_debt.unclassified,
                q1_overdue: overview.work_debt.q1_overdue,
                stale_backlog: overview.work_debt.stale_backlog,
                cleanup_needed: overview.work_debt.cleanup_needed,
            },
            q1_items: overview
                .q1_items
                .into_iter()
                .map(|s| SignalRefDto {
                    id: s.id,
                    title: s.title,
                    quadrant: enum_wire_string(&s.quadrant),
                })
                .collect(),
            pr_attention_count: overview.pr_attention.len() as u32,
        }))
    }

    #[tool(
        name = "wr_list_today_routines",
        description = "List the routines due on a date with their per-date completion state. The weekday is derived from the date. Read-only."
    )]
    pub async fn list_today_routines(
        &self,
        Parameters(p): Parameters<TodayDateParams>,
    ) -> Result<Json<RoutineTodayListDto>, rmcp::ErrorData> {
        self.list_today_routines_inner(p).await
    }

    pub(crate) async fn list_today_routines_inner(
        &self,
        p: TodayDateParams,
    ) -> Result<Json<RoutineTodayListDto>, rmcp::ErrorData> {
        let parsed = clean_date(&p.date)?;
        let date = parsed.format("%Y-%m-%d").to_string();
        let rows = fetch_today_routines(&self.db, &date, weekday_of(parsed))
            .await
            .map_err(|e| db_tool_error("wr_list_today_routines", &AppError::from(e)))?;
        Ok(Json(RoutineTodayListDto {
            routines: rows.into_iter().map(to_routine_dto).collect(),
        }))
    }

    /// 루틴 완료 토글 — "했다/안 했다"는 관측 사실이고 가역이다(캡처 레인).
    #[tool(
        name = "wr_toggle_routine_check",
        description = "Mark a routine done (or not done) for a date. Reversible; records an observation, not a decision."
    )]
    pub async fn toggle_routine_check(
        &self,
        Parameters(p): Parameters<ToggleRoutineCheckParams>,
    ) -> Result<Json<ToggleRoutineCheckResult>, rmcp::ErrorData> {
        self.toggle_routine_check_for_date(p).await
    }

    pub(crate) async fn toggle_routine_check_for_date(
        &self,
        p: ToggleRoutineCheckParams,
    ) -> Result<Json<ToggleRoutineCheckResult>, rmcp::ErrorData> {
        let date = clean_date(&p.date)?.format("%Y-%m-%d").to_string();
        toggle_routine_check_inner(&self.db, &p.routine_id, &date, p.done)
            .await
            .map_err(|e| mcp_tool_error("wr_toggle_routine_check", &e))?;
        Ok(Json(ToggleRoutineCheckResult {
            routine_id: p.routine_id,
            date,
            done: p.done,
        }))
    }

    #[tool(
        name = "wr_list_timeline_notes",
        description = "List the timeline notes attached to signals/routines/events on a date. Bodies are truncated to a preview. Read-only."
    )]
    pub async fn list_timeline_notes(
        &self,
        Parameters(p): Parameters<TodayDateParams>,
    ) -> Result<Json<TimelineNoteListDto>, rmcp::ErrorData> {
        self.list_timeline_notes_inner(p).await
    }

    pub(crate) async fn list_timeline_notes_inner(
        &self,
        p: TodayDateParams,
    ) -> Result<Json<TimelineNoteListDto>, rmcp::ErrorData> {
        let date = clean_date(&p.date)?.format("%Y-%m-%d").to_string();
        let rows = timeline_notes::list_for_date_inner(&self.db, &date)
            .await
            .map_err(|e| db_tool_error("wr_list_timeline_notes", &AppError::from(e)))?;
        Ok(Json(TimelineNoteListDto {
            notes: rows.into_iter().map(to_note_dto).collect(),
        }))
    }

    /// 타임라인 메모 upsert. 분류·상태를 바꾸지 않는다(자유 메모).
    #[tool(
        name = "wr_upsert_timeline_note",
        description = "Attach (or replace) a free-text note on a signal/routine/event for a date. Sending a blank body deletes the note."
    )]
    pub async fn upsert_timeline_note(
        &self,
        Parameters(p): Parameters<UpsertTimelineNoteParams>,
    ) -> Result<Json<UpsertTimelineNoteResult>, rmcp::ErrorData> {
        self.upsert_timeline_note_inner(p).await
    }

    pub(crate) async fn upsert_timeline_note_inner(
        &self,
        p: UpsertTimelineNoteParams,
    ) -> Result<Json<UpsertTimelineNoteResult>, rmcp::ErrorData> {
        if p.body.chars().count() > NOTE_BODY_MAX_CHARS {
            return Err(rmcp::ErrorData::invalid_params(
                format!("body exceeds {NOTE_BODY_MAX_CHARS} characters"),
                None,
            ));
        }
        let date = clean_date(&p.date)?.format("%Y-%m-%d").to_string();
        let saved = timeline_notes::upsert_inner(
            &self.db,
            p.target_kind.into(),
            &p.target_id,
            &date,
            &p.body,
        )
        .await
        .map_err(|e| db_tool_error("wr_upsert_timeline_note", &AppError::from(e)))?;
        Ok(Json(UpsertTimelineNoteResult {
            status: if saved.is_some() { "saved" } else { "cleared" }.to_string(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TimelineNoteTargetParam, TodayDateParams, ToggleRoutineCheckParams,
        UpsertTimelineNoteParams,
    };
    use crate::commands::routines::insert_routine;
    use crate::commands::shared::test_support::fresh_db;
    use crate::db::Db;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::{CreateRoutineInput, RoutineFreq, Weekday};

    const MONDAY: &str = "2026-07-06";

    async fn seed_daily_routine(db: &Db, title: &str) -> String {
        insert_routine(
            db,
            &CreateRoutineInput {
                title: title.into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                start_date: None,
                end_date: None,
                time_of_day: Some("09:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: Some(30),
            },
        )
        .await
        .expect("routine")
        .id
    }

    /// 순수 read 계약: overview 툴은 debt_snapshots에 행을 만들지 않는다.
    /// (`today_overview` 커맨드는 `upsert_debt_snapshot`으로 쓴다 — 그걸 부르면 안 된다.)
    #[tokio::test]
    async fn today_overview_writes_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let out = server
            .today_overview_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("overview")
            .0;
        assert_eq!(out.date, MONDAY);
        assert_eq!(out.work_debt.unclassified, 0);
        assert_eq!(out.pr_attention_count, 0);

        let snapshots: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM debt_snapshots")
            .fetch_one(&db)
            .await
            .expect("count snapshots");
        assert_eq!(snapshots, 0, "read 툴은 부채 스냅샷을 쓰지 않는다");
    }

    #[tokio::test]
    async fn today_overview_counts_unclassified_capture() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        server
            .create_signal_inner(crate::mcp::tools::signals::CreateSignalParams {
                title: "정리할 것".into(),
                kind: None,
                project_id: None,
            })
            .await
            .expect("capture");

        let out = server
            .today_overview_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("overview")
            .0;
        assert_eq!(out.work_debt.unclassified, 1);
        assert!(out.q1_items.is_empty(), "미분류는 q1이 아니다");
    }

    #[tokio::test]
    async fn routines_list_and_toggle_round_trip() {
        let db = fresh_db().await;
        let routine_id = seed_daily_routine(&db, "스트레칭").await;
        let server = WrServer { db: db.clone() };

        let before = server
            .list_today_routines_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list")
            .0;
        assert_eq!(before.routines.len(), 1);
        assert_eq!(before.routines[0].freq, "daily");
        assert_eq!(before.routines[0].time_of_day.as_deref(), Some("09:00"));
        assert!(!before.routines[0].done);

        server
            .toggle_routine_check_for_date(ToggleRoutineCheckParams {
                routine_id: routine_id.clone(),
                date: MONDAY.into(),
                done: true,
            })
            .await
            .expect("check");

        let after = server
            .list_today_routines_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list after")
            .0;
        assert!(after.routines[0].done, "완료가 반영된다");

        // 가역: 해제하면 다시 미완료.
        server
            .toggle_routine_check_for_date(ToggleRoutineCheckParams {
                routine_id,
                date: MONDAY.into(),
                done: false,
            })
            .await
            .expect("uncheck");
        let reverted = server
            .list_today_routines_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list reverted")
            .0;
        assert!(!reverted.routines[0].done, "완료 토글은 가역이다");
    }

    /// 날짜는 파싱해서 강제한다 — 잘못된 날짜가 조용히 빈 결과가 되면 "그날 아무것도 없다"로 읽힌다.
    #[tokio::test]
    async fn malformed_date_is_rejected_everywhere() {
        let db = fresh_db().await;
        let server = WrServer { db };
        for bad in ["2026/07/06", "06-07-2026", "오늘", ""] {
            assert!(
                server
                    .today_overview_inner(TodayDateParams { date: bad.into() })
                    .await
                    .is_err(),
                "overview rejects {bad:?}"
            );
            assert!(
                server
                    .list_today_routines_inner(TodayDateParams { date: bad.into() })
                    .await
                    .is_err(),
                "routines reject {bad:?}"
            );
            assert!(
                server
                    .list_timeline_notes_inner(TodayDateParams { date: bad.into() })
                    .await
                    .is_err(),
                "notes reject {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn timeline_note_upsert_replaces_then_clears() {
        let db = fresh_db().await;
        let routine_id = seed_daily_routine(&db, "회고").await;
        let server = WrServer { db: db.clone() };

        let note = |body: &str| UpsertTimelineNoteParams {
            target_kind: TimelineNoteTargetParam::Routine,
            target_id: routine_id.clone(),
            date: MONDAY.into(),
            body: body.into(),
        };

        let saved = server
            .upsert_timeline_note_inner(note("첫 메모"))
            .await
            .expect("save")
            .0;
        assert_eq!(saved.status, "saved");

        let listed = server
            .list_timeline_notes_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list")
            .0;
        assert_eq!(listed.notes.len(), 1);
        assert_eq!(listed.notes[0].target_kind, "routine");
        assert_eq!(listed.notes[0].body_preview, "첫 메모");
        assert!(!listed.notes[0].body_truncated);

        // 덮어쓰기.
        server
            .upsert_timeline_note_inner(note("고친 메모"))
            .await
            .expect("replace");
        let listed = server
            .list_timeline_notes_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list")
            .0;
        assert_eq!(listed.notes.len(), 1, "upsert — append 아님");
        assert_eq!(listed.notes[0].body_preview, "고친 메모");

        // 빈 본문 = 삭제(기존 앱 계약). description에 명시돼 있다.
        let cleared = server
            .upsert_timeline_note_inner(note("   "))
            .await
            .expect("clear")
            .0;
        assert_eq!(cleared.status, "cleared");
        let listed = server
            .list_timeline_notes_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list")
            .0;
        assert!(listed.notes.is_empty());
    }

    #[tokio::test]
    async fn timeline_note_truncates_long_body_and_flags_it() {
        let db = fresh_db().await;
        let routine_id = seed_daily_routine(&db, "일지").await;
        let server = WrServer { db };

        let long = "가".repeat(1500);
        server
            .upsert_timeline_note_inner(UpsertTimelineNoteParams {
                target_kind: TimelineNoteTargetParam::Routine,
                target_id: routine_id.clone(),
                date: MONDAY.into(),
                body: long,
            })
            .await
            .expect("save long");

        let listed = server
            .list_timeline_notes_inner(TodayDateParams {
                date: MONDAY.into(),
            })
            .await
            .expect("list")
            .0;
        assert!(listed.notes[0].body_truncated, "잘렸음을 명시 신호");
        assert_eq!(
            listed.notes[0].body_preview.chars().count(),
            1001,
            "1000자 + 말줄임표"
        );

        // 입력 상한 초과는 거부.
        let too_long = server
            .upsert_timeline_note_inner(UpsertTimelineNoteParams {
                target_kind: TimelineNoteTargetParam::Routine,
                target_id: routine_id,
                date: MONDAY.into(),
                body: "나".repeat(4001),
            })
            .await;
        assert!(too_long.is_err());
    }

    #[test]
    fn weekday_is_derived_from_the_date() {
        // 2026-07-06은 월요일. caller가 요일을 보내지 않으므로 date와 어긋날 수 없다.
        let parsed = chrono::NaiveDate::parse_from_str(MONDAY, "%Y-%m-%d").unwrap();
        assert!(matches!(super::weekday_of(parsed), Weekday::Mon));
    }

    #[test]
    fn today_params_schemas_are_closed_and_stable() {
        let date = serde_json::to_value(schemars::schema_for!(TodayDateParams)).unwrap();
        assert_eq!(date["additionalProperties"], serde_json::json!(false));
        assert_eq!(prop_names(&date), expect(&["date"]));
        // 요일은 caller 입력이 아니다 — date에서 파생한다.
        assert!(!prop_names(&date).contains("weekday"));

        let toggle = serde_json::to_value(schemars::schema_for!(ToggleRoutineCheckParams)).unwrap();
        assert_eq!(toggle["additionalProperties"], serde_json::json!(false));
        assert_eq!(prop_names(&toggle), expect(&["routine_id", "date", "done"]));
        assert_eq!(
            required_fields(&toggle),
            expect(&["routine_id", "date", "done"])
        );

        let note = serde_json::to_value(schemars::schema_for!(UpsertTimelineNoteParams)).unwrap();
        assert_eq!(note["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&note),
            expect(&["target_kind", "target_id", "date", "body"])
        );
    }
}
