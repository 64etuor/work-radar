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

// ── External Action Gate: Calendar 이벤트 생성 커넥터(Phase 4, AI-origin) ────────────
// 제안은 MCP/사용자가 만들고, 실행은 승인 후 여기서만(Rust·토큰 keychain·단일 시도 write).
// 사람-폼 제출(`commands::calendar::create_calendar_event` + pending_calendar_writes)은 **기존 경로
// 유지** — 이 커넥터는 외부 에이전트 제안(external_actions 큐)만 흘린다(spec §4 이중 경로:
// AI-origin=gate / human=기존 폼). notion.rs::execute_notion_action을 그대로 미러한다 — 단, calendar_id는
// 별도 인자가 아니라 ACTION 변형(CalendarCreateEvent.calendar_id)에서 온다. write는 비멱등이라
// `create_event_once`(단일 시도)로 호출해 중복 이벤트를 막는다(create_event의 bounded retry 아님).

/// 승인된 Calendar 액션을 단일-시도 create로 dispatch한다. 토큰은 호출 측(라우터)이 cref로 resolve해
/// `access_token`으로 넘긴다 — 여기선 입력 검증 + provider 호출 + outcome 매핑만(테스트는 mock provider로
/// 네트워크 없이 라우팅 검증). calendar_id는 액션 변형이 보유한다(별도 인자 아님). 비-Calendar 액션은
/// 호출 측 라우터가 거르지만 방어적으로 거부한다.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(execute_notion_action 등과 동일).
#[allow(clippy::result_large_err)]
pub(crate) async fn execute_calendar_action<P: crate::calendar::CalendarProvider>(
    provider: &P,
    access_token: &str,
    action: &crate::external_actions::ExternalAction,
) -> Result<crate::external_actions::ExecOutcome, crate::error::AppError> {
    use crate::error::AppError;
    use crate::external_actions::{ExecOutcome, ExternalAction};
    match action {
        ExternalAction::CalendarCreateEvent {
            calendar_id,
            title,
            start,
            end,
            all_day,
            description,
        } => {
            // 사람-폼 경로(create_calendar_event)와 같은 코드/문구로 외부 호출 전에 검증한다.
            if title.trim().is_empty() {
                return Err(AppError::validation(
                    "calendar.empty_title",
                    "이벤트 제목이 비었습니다",
                ));
            }
            if calendar_id.trim().is_empty() {
                return Err(AppError::validation(
                    "calendar.no_calendar_selected",
                    "캘린더를 선택하세요",
                ));
            }
            let input = CreateEventInput {
                title: title.clone(),
                start: start.clone(),
                end: end.clone(),
                all_day: *all_day,
                description: description.clone().filter(|d| !d.is_empty()),
                ..Default::default()
            };
            // 비멱등 write → 단일 시도(create_event_once). 중복 이벤트 방지(WRITE_MAX_ATTEMPTS=1).
            let (id, _html_link) = provider
                .create_event_once(access_token, calendar_id, &input)
                .await?;
            // external_ref=event id(콘텐츠-free). htmlLink는 제목 슬러그가 새어 audit `detail`/result에
            // 들어가면 안 된다(INVARIANT #7 — 식별자만, 본문 금지). 그래서 id만 노출하고 htmlLink는 버린다.
            Ok(ExecOutcome {
                external_ref: Some(id),
                bytes: Some(title.len() as i64),
            })
        }
        other => Err(AppError::unexpected(
            "calendar.dispatch.kind",
            format!(
                "Calendar 커넥터가 처리할 수 없는 액션: {}",
                other.kind_str()
            ),
        )),
    }
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

#[cfg(test)]
mod calendar_dispatch_tests {
    use super::*;
    use crate::calendar::{CalendarCreds, CalendarProvider, RawCalendar, RawEvent, TokenResponse};
    use crate::external_actions::ExternalAction;
    use std::sync::Mutex;

    /// 네트워크 없는 mock Calendar provider — create_event_once 호출 인자를 기록해 dispatch 라우팅/검증을
    /// 확인한다. id와 htmlLink를 일부러 다르게 둔다(id는 제목 슬러그가 아닌 콘텐츠-free 식별자).
    #[derive(Default)]
    struct MockCalendarProvider {
        calls: Mutex<Vec<(String, String, CreateEventInput)>>, // (token, calendar_id, input)
    }
    impl CalendarProvider for MockCalendarProvider {
        async fn exchange_code(
            &self,
            _creds: &CalendarCreds,
            _code: &str,
            _verifier: &str,
            _redirect_uri: &str,
        ) -> Result<TokenResponse, CalendarError> {
            unreachable!("dispatch 테스트는 토큰 교환을 호출하지 않음")
        }
        async fn refresh_access(
            &self,
            _creds: &CalendarCreds,
        ) -> Result<TokenResponse, CalendarError> {
            unreachable!("dispatch 테스트는 refresh를 호출하지 않음")
        }
        async fn list_calendars(
            &self,
            _access_token: &str,
        ) -> Result<Vec<RawCalendar>, CalendarError> {
            unreachable!("dispatch 테스트는 list_calendars를 호출하지 않음")
        }
        async fn fetch_events(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _time_min: &str,
            _time_max: &str,
        ) -> Result<Vec<RawEvent>, CalendarError> {
            unreachable!("dispatch 테스트는 fetch_events를 호출하지 않음")
        }
        async fn create_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _input: &CreateEventInput,
        ) -> Result<(String, Option<String>), CalendarError> {
            // gate dispatch는 비멱등이라 create_event(bounded retry)가 아니라 create_event_once를 써야 한다.
            unreachable!("gate dispatch는 create_event_once를 써야 함(중복 write 방지)")
        }
        async fn create_event_once(
            &self,
            access_token: &str,
            calendar_id: &str,
            input: &CreateEventInput,
        ) -> Result<(String, Option<String>), CalendarError> {
            self.calls.lock().unwrap().push((
                access_token.into(),
                calendar_id.into(),
                input.clone(),
            ));
            // id != 어떤 title 슬러그 — external_ref가 (제목이 새는) htmlLink가 아니라 id를 담는지 검증용.
            Ok((
                "evt-id-1".into(),
                Some("https://calendar.google.com/My-Title-evt-id-1".into()),
            ))
        }
        async fn patch_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _event_id: &str,
            _patch: &serde_json::Value,
        ) -> Result<(), CalendarError> {
            unreachable!("dispatch 테스트는 patch_event를 호출하지 않음")
        }
        async fn delete_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _event_id: &str,
        ) -> Result<(), CalendarError> {
            unreachable!("dispatch 테스트는 delete_event를 호출하지 않음")
        }
    }

    fn sample_action() -> ExternalAction {
        ExternalAction::CalendarCreateEvent {
            calendar_id: "primary".into(),
            title: "디자인 리뷰".into(),
            start: "2026-06-04T09:00:00+09:00".into(),
            end: "2026-06-04T10:00:00+09:00".into(),
            all_day: false,
            description: Some("Q2 폴리시".into()),
        }
    }

    /// CalendarCreateEvent → create_event_once로 라우팅되고 CreateEventInput이 올바르게 매핑되며,
    /// outcome.external_ref가 **콘텐츠-free event id**(htmlLink 슬러그 아님)다.
    #[tokio::test]
    async fn dispatch_routes_create_event_with_input() {
        let p = MockCalendarProvider::default();
        let out = execute_calendar_action(&p, "tok", &sample_action())
            .await
            .unwrap();
        // 감사 계약(식별자만, 본문 금지): htmlLink 슬러그가 아니라 event id를 external_ref로 쓴다.
        assert_eq!(out.external_ref.as_deref(), Some("evt-id-1"));
        assert_eq!(out.bytes, Some("디자인 리뷰".len() as i64));
        let calls = p.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "정확히 1회 write(단일 시도)");
        let (token, cal_id, input) = &calls[0];
        assert_eq!(token, "tok");
        assert_eq!(cal_id, "primary");
        assert_eq!(
            input,
            &CreateEventInput {
                title: "디자인 리뷰".into(),
                start: "2026-06-04T09:00:00+09:00".into(),
                end: "2026-06-04T10:00:00+09:00".into(),
                all_day: false,
                description: Some("Q2 폴리시".into()),
                ..Default::default()
            }
        );
    }

    /// 빈 description은 None으로 정규화된다(빌더가 어차피 생략하지만 입력 단계에서도 거른다).
    #[tokio::test]
    async fn dispatch_normalizes_empty_description_to_none() {
        let p = MockCalendarProvider::default();
        let action = ExternalAction::CalendarCreateEvent {
            calendar_id: "primary".into(),
            title: "t".into(),
            start: "2026-06-04".into(),
            end: "2026-06-05".into(),
            all_day: true,
            description: Some("".into()),
        };
        execute_calendar_action(&p, "tok", &action).await.unwrap();
        assert_eq!(p.calls.lock().unwrap()[0].2.description, None);
    }

    /// 빈 calendar_id/title은 외부 호출 전에 validation 에러로 거른다(provider 미호출).
    #[tokio::test]
    async fn dispatch_rejects_empty_calendar_id_or_title_before_write() {
        let p = MockCalendarProvider::default();
        let empty_title = ExternalAction::CalendarCreateEvent {
            calendar_id: "primary".into(),
            title: "  ".into(),
            start: "s".into(),
            end: "e".into(),
            all_day: false,
            description: None,
        };
        assert!(execute_calendar_action(&p, "tok", &empty_title)
            .await
            .is_err());
        let empty_cal = ExternalAction::CalendarCreateEvent {
            calendar_id: "".into(),
            title: "t".into(),
            start: "s".into(),
            end: "e".into(),
            all_day: false,
            description: None,
        };
        assert!(execute_calendar_action(&p, "tok", &empty_cal)
            .await
            .is_err());
        assert!(
            p.calls.lock().unwrap().is_empty(),
            "검증 실패 시 write 0(provider 미호출)"
        );
    }

    /// 비-Calendar 액션은 방어적으로 거부한다(라우터가 먼저 거르지만 이중 방어).
    #[tokio::test]
    async fn dispatch_rejects_non_calendar_action() {
        let p = MockCalendarProvider::default();
        let action = ExternalAction::Noop { note: "x".into() };
        assert!(execute_calendar_action(&p, "tok", &action).await.is_err());
        assert!(p.calls.lock().unwrap().is_empty());
    }
}
