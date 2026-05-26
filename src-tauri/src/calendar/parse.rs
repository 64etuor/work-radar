//! 캘린더/이벤트 응답 파싱 + Raw 타입 + CalendarEvent 정렬(병합 시 사용).
//!
//! 모든 함수는 순수(JSON 입력만). singleEvents 전개·시작순 정렬 등 메타 규약은 호출자(http.rs)가 책임.

use crate::models::CalendarEvent;

/// provider가 반환하는 raw 캘린더(선택 플래그는 commands가 입힌다 — github.rs RawPr 선례).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawCalendar {
    pub id: String,
    pub summary: String,
    pub primary: bool,
}

/// provider가 반환하는 raw 이벤트(project_id/calendar_summary는 fetch_events_core가 입힌다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEvent {
    pub id: String,
    pub title: String,
    /// timed = RFC3339(`start.dateTime`), all-day = YYYY-MM-DD(`start.date`).
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    pub url: Option<String>,
}

/// calendarList 응답(JSON) → RawCalendar 목록. id 없는 항목은 건너뛴다(관용). 순수.
pub fn parse_calendar_list(body: &serde_json::Value) -> Vec<RawCalendar> {
    let mut out = Vec::new();
    if let Some(items) = body.get("items").and_then(|i| i.as_array()) {
        for it in items {
            let Some(id) = it.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            // summary 없으면 id로 폴백.
            let summary = it
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string();
            let primary = it.get("primary").and_then(|v| v.as_bool()).unwrap_or(false);
            out.push(RawCalendar {
                id: id.to_string(),
                summary,
                primary,
            });
        }
    }
    out
}

/// events 응답의 한 item(JSON) → RawEvent. id/start 없으면 None(관용). 순수.
/// timed = `start.dateTime`(RFC3339), all-day = `start.date`(YYYY-MM-DD).
pub fn parse_calendar_event(item: &serde_json::Value) -> Option<RawEvent> {
    let id = item.get("id").and_then(|v| v.as_str())?.to_string();
    let start_obj = item.get("start")?;
    let (start, all_day) = match start_obj.get("dateTime").and_then(|v| v.as_str()) {
        Some(dt) => (dt.to_string(), false),
        None => (
            start_obj.get("date").and_then(|v| v.as_str())?.to_string(),
            true,
        ),
    };
    // end는 누락 관용(없으면 start로). all-day는 end.date(exclusive)일 수 있으나 표시용이라 그대로.
    let end = item
        .get("end")
        .and_then(|e| {
            e.get("dateTime")
                .or_else(|| e.get("date"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or(&start)
        .to_string();
    let title = item
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("(제목 없음)")
        .to_string();
    let location = item
        .get("location")
        .and_then(|v| v.as_str())
        .map(String::from);
    let url = item
        .get("htmlLink")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(RawEvent {
        id,
        title,
        start,
        end,
        all_day,
        location,
        url,
    })
}

/// 다중 캘린더 이벤트를 시작시각 순으로 정렬(병합). all-day(date-only)는 앞. 순수.
pub fn merge_sort_events(mut events: Vec<CalendarEvent>) -> Vec<CalendarEvent> {
    events.sort_by_key(event_sort_key);
    events
}

/// 정렬 키: timed는 instant(초), all-day(date-only=파싱 실패)는 맨 앞. 보조키=start 문자열.
/// (오늘 윈도우라 같은 날짜 — 오프셋이 섞여도 instant 비교로 안정 정렬.)
fn event_sort_key(e: &CalendarEvent) -> (i64, String) {
    let ts = chrono::DateTime::parse_from_rfc3339(&e.start)
        .map(|dt| dt.timestamp())
        .unwrap_or(i64::MIN);
    (ts, e.start.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// calendarList 파싱: id/summary/primary, summary 누락은 id 폴백, id 없는 항목 스킵.
    #[test]
    fn parse_calendar_list_extracts_items() {
        let body = serde_json::json!({
            "items": [
                { "id": "primary", "summary": "내 캘린더", "primary": true },
                { "id": "team@group.calendar.google.com", "summary": "팀" },
                { "summary": "id 없음 — 스킵" }
            ]
        });
        let cals = parse_calendar_list(&body);
        assert_eq!(cals.len(), 2);
        assert_eq!(cals[0].id, "primary");
        assert!(cals[0].primary);
        assert_eq!(cals[1].id, "team@group.calendar.google.com");
        assert!(!cals[1].primary);
        // summary 폴백.
        let no_summary = serde_json::json!({ "items": [ { "id": "x" } ] });
        assert_eq!(parse_calendar_list(&no_summary)[0].summary, "x");
    }

    /// 이벤트 파싱: timed(dateTime) vs all-day(date), end 누락 관용, id/start 없으면 None.
    #[test]
    fn parse_calendar_event_timed_and_all_day() {
        let timed = serde_json::json!({
            "id": "e1", "summary": "스탠드업",
            "start": { "dateTime": "2026-05-21T09:00:00+09:00" },
            "end": { "dateTime": "2026-05-21T09:30:00+09:00" },
            "location": "Zoom", "htmlLink": "https://cal/e1"
        });
        let r = parse_calendar_event(&timed).unwrap();
        assert!(!r.all_day);
        assert_eq!(r.start, "2026-05-21T09:00:00+09:00");
        assert_eq!(r.location.as_deref(), Some("Zoom"));
        assert_eq!(r.url.as_deref(), Some("https://cal/e1"));

        let all_day = serde_json::json!({
            "id": "e2", "summary": "휴가", "start": { "date": "2026-05-21" }
        });
        let r2 = parse_calendar_event(&all_day).unwrap();
        assert!(r2.all_day);
        assert_eq!(r2.start, "2026-05-21");
        assert_eq!(r2.end, "2026-05-21", "end 누락 시 start 폴백");

        // 제목 누락 관용.
        let no_title = serde_json::json!({ "id": "e3", "start": { "date": "2026-05-21" } });
        assert_eq!(
            parse_calendar_event(&no_title).unwrap().title,
            "(제목 없음)"
        );
        // id/start 없으면 None.
        assert!(parse_calendar_event(&serde_json::json!({ "summary": "x" })).is_none());
        assert!(parse_calendar_event(&serde_json::json!({ "id": "x" })).is_none());
    }
}
