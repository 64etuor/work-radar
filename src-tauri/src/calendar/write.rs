//! 이벤트 생성(write, Phase 19) — 사용자 폼 입력 + Google `events.insert` 페이로드 빌더 + 응답 파싱.
//!
//! write는 사용자 폼 제출 = 사람 결정이라 Acceptance 게이트 불요(게이트는 자동화/Codex의 외부 mutate 차단용).
//! 모든 함수 순수 — 실 HTTP는 http.rs HttpCalendarProvider.

use super::CalendarError;

/// 카드 → 캘린더 이벤트 생성 입력(사용자 폼). title은 카드에서 prefill, start/end는 RFC3339(timed)
/// 또는 YYYY-MM-DD(all-day). description은 선택. 토큰/외부 ID 미포함(write 입력만). 순수 페이로드로 변환된다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateEventInput {
    pub title: String,
    /// timed = RFC3339(`2026-05-22T09:00:00+09:00`), all-day = YYYY-MM-DD.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub description: Option<String>,
}

/// Google Calendar `events.insert` 요청 본문(JSON). all-day는 `start.date`/`end.date`,
/// timed는 `start.dateTime`/`end.dateTime`. description은 비었으면 생략. 순수 — 단위 테스트 대상.
pub fn build_event_payload(input: &CreateEventInput) -> serde_json::Value {
    let key = if input.all_day { "date" } else { "dateTime" };
    let mut body = serde_json::json!({
        "summary": input.title,
        "start": { key: input.start },
        "end": { key: input.end },
    });
    if let Some(desc) = input.description.as_deref() {
        if !desc.is_empty() {
            body["description"] = serde_json::Value::String(desc.to_string());
        }
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
        };
        let body = build_event_payload(&input);
        assert_eq!(body["summary"], "디자인 리뷰");
        assert_eq!(body["start"]["dateTime"], "2026-05-22T14:00:00+09:00");
        assert_eq!(body["end"]["dateTime"], "2026-05-22T15:00:00+09:00");
        assert_eq!(body["description"], "Q2 폴리시");
        // all-day 키는 없어야 한다.
        assert!(body["start"].get("date").is_none());
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
