//! 이벤트 생성(write, Phase 19) — 사용자 폼 입력 + Google `events.insert` 페이로드 빌더 + 응답 파싱.
//!
//! write는 사용자 폼 제출 = 사람 결정이라 Acceptance 게이트 불요(게이트는 자동화/Codex의 외부 mutate 차단용).
//! 모든 함수 순수 — 실 HTTP는 http.rs HttpCalendarProvider.

use super::CalendarError;

/// 카드 → 캘린더 이벤트 생성 입력(사용자 폼). title은 카드에서 prefill, start/end는 RFC3339(timed)
/// 또는 YYYY-MM-DD(all-day). description은 선택. 토큰/외부 ID 미포함(write 입력만). 순수 페이로드로 변환된다.
///
/// 반복 이벤트(루틴 master): `recurrence`에 ["RRULE:...", "EXDATE;TZID=...:..."] 라인 전달 + `time_zone`
/// 세팅 (Google API는 recurring 시 `start.timeZone`/`end.timeZone` 별도 필드를 요구하고 `start.dateTime`은
/// offset 없는 wall-clock 'YYYY-MM-DDTHH:MM:SS'). 비반복(기존)은 `recurrence=vec![]`, `time_zone=None`
/// 유지 — `start/end`는 종전대로 offset 포함 RFC3339.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CreateEventInput {
    pub title: String,
    /// timed = RFC3339(`2026-05-22T09:00:00+09:00`) 또는 wall-clock(`2026-05-22T09:00:00`, recurring), all-day = YYYY-MM-DD.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub description: Option<String>,
    /// 빈 vec = 비반복. 비어있지 않으면 `recurrence` 배열로 직렬화.
    pub recurrence: Vec<String>,
    /// recurring 이벤트의 IANA timezone (e.g. `Asia/Seoul`). None = legacy(non-recurring, offset 포함 start/end).
    pub time_zone: Option<String>,
}

/// Google Calendar `events.insert` 요청 본문(JSON). all-day는 `start.date`/`end.date`,
/// timed는 `start.dateTime`/`end.dateTime`. description은 비었으면 생략.
/// recurrence/time_zone이 주어지면 반복 이벤트로 직렬화. 순수 — 단위 테스트 대상.
pub fn build_event_payload(input: &CreateEventInput) -> serde_json::Value {
    let key = if input.all_day { "date" } else { "dateTime" };
    let mut start = serde_json::json!({ key: input.start });
    let mut end = serde_json::json!({ key: input.end });
    if let Some(tz) = input.time_zone.as_deref() {
        start["timeZone"] = serde_json::Value::String(tz.to_string());
        end["timeZone"] = serde_json::Value::String(tz.to_string());
    }
    let mut body = serde_json::json!({
        "summary": input.title,
        "start": start,
        "end": end,
    });
    if let Some(desc) = input.description.as_deref() {
        if !desc.is_empty() {
            body["description"] = serde_json::Value::String(desc.to_string());
        }
    }
    if !input.recurrence.is_empty() {
        body["recurrence"] = serde_json::Value::Array(
            input
                .recurrence
                .iter()
                .map(|s| serde_json::Value::String(s.clone()))
                .collect(),
        );
    }
    body
}

/// events.insert 응답(JSON) → 생성된 이벤트 id/htmlLink. id 누락은 Terminal(write 검증 실패). 순수.
pub fn parse_created_event(
    body: &serde_json::Value,
) -> Result<(String, Option<String>), CalendarError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        // 응답 본문(이벤트 상세)은 메시지/로그에 넣지 않는다(스펙 §5.5).
        .ok_or_else(|| CalendarError::Terminal("이벤트 생성 응답에 id 없음".into()))?
        .to_string();
    let url = body
        .get("htmlLink")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok((id, url))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// timed 이벤트 페이로드: summary + start/end.dateTime + description(있으면).
    #[test]
    fn build_event_payload_timed_with_description() {
        let input = CreateEventInput {
            title: "디자인 리뷰".into(),
            start: "2026-05-22T14:00:00+09:00".into(),
            end: "2026-05-22T15:00:00+09:00".into(),
            all_day: false,
            description: Some("Q2 폴리시".into()),
            ..Default::default()
        };
        let body = build_event_payload(&input);
        assert_eq!(body["summary"], "디자인 리뷰");
        assert_eq!(body["start"]["dateTime"], "2026-05-22T14:00:00+09:00");
        assert_eq!(body["end"]["dateTime"], "2026-05-22T15:00:00+09:00");
        assert_eq!(body["description"], "Q2 폴리시");
        // all-day 키는 없어야 한다.
        assert!(body["start"].get("date").is_none());
        // 기본은 비반복 — recurrence/timeZone 키 없음.
        assert!(body.get("recurrence").is_none());
        assert!(body["start"].get("timeZone").is_none());
    }

    /// all-day 이벤트: start/end.date(YYYY-MM-DD), description 비었으면 생략.
    #[test]
    fn build_event_payload_all_day_omits_empty_description() {
        let input = CreateEventInput {
            title: "휴가".into(),
            start: "2026-05-22".into(),
            end: "2026-05-23".into(),
            all_day: true,
            description: None,
            ..Default::default()
        };
        let body = build_event_payload(&input);
        assert_eq!(body["start"]["date"], "2026-05-22");
        assert_eq!(body["end"]["date"], "2026-05-23");
        assert!(body["start"].get("dateTime").is_none());
        assert!(
            body.get("description").is_none(),
            "None이면 description 생략"
        );

        // 빈 문자열도 생략.
        let empty_desc = CreateEventInput {
            description: Some("".into()),
            ..input
        };
        assert!(build_event_payload(&empty_desc)
            .get("description")
            .is_none());
    }

    /// 반복 이벤트(루틴 master): recurrence 배열 + start/end.timeZone 직렬화. start/end는 wall-clock.
    #[test]
    fn build_event_payload_recurring_with_timezone_and_exdate() {
        let input = CreateEventInput {
            title: "아침 운동".into(),
            start: "2026-05-29T07:00:00".into(),
            end: "2026-05-29T07:30:00".into(),
            all_day: false,
            description: None,
            recurrence: vec![
                "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR".into(),
                "EXDATE;TZID=Asia/Seoul:20260601T070000".into(),
            ],
            time_zone: Some("Asia/Seoul".into()),
        };
        let body = build_event_payload(&input);
        assert_eq!(body["start"]["dateTime"], "2026-05-29T07:00:00");
        assert_eq!(body["start"]["timeZone"], "Asia/Seoul");
        assert_eq!(body["end"]["timeZone"], "Asia/Seoul");
        let rec = body["recurrence"].as_array().expect("recurrence array");
        assert_eq!(rec.len(), 2);
        assert_eq!(rec[0], "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
        assert_eq!(rec[1], "EXDATE;TZID=Asia/Seoul:20260601T070000");
    }

    /// 생성 응답 파싱: id + htmlLink, htmlLink 누락 관용, id 누락=Terminal.
    #[test]
    fn parse_created_event_cases() {
        let ok = serde_json::json!({ "id": "evt1", "htmlLink": "https://cal/evt1" });
        assert_eq!(
            parse_created_event(&ok).unwrap(),
            ("evt1".into(), Some("https://cal/evt1".into()))
        );
        // htmlLink 누락 관용.
        let no_link = serde_json::json!({ "id": "evt2" });
        assert_eq!(
            parse_created_event(&no_link).unwrap(),
            ("evt2".into(), None)
        );
        // id 누락 → Terminal(write 검증 실패). 응답 본문은 메시지에 노출되지 않는다(스펙 §5.5).
        let bad = serde_json::json!({ "error": "insufficientPermissions", "leak": "SECRET_xyz" });
        let Err(CalendarError::Terminal(m)) = parse_created_event(&bad) else {
            panic!("id 누락 → Terminal");
        };
        assert!(
            !m.contains("SECRET_xyz") && !m.contains("insufficientPermissions"),
            "본문 내용이 메시지에 노출되면 안 됨"
        );
    }
}
