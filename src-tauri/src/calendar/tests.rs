//! 트레잇 seam cross-slice 통합 테스트 (connect_core / refresh_core / fetch_events_core).
//!
//! 단위 테스트는 각 슬라이스 안에 있다. 여기는 트레잇 fake가 여러 슬라이스(oauth / parse / write / mod)를
//! 가로지르기 때문에 한 곳에 모은다. 슬라이스 LOC를 깎기 위해 mod.rs에서 분리.

use std::collections::HashMap;

use super::*;

struct FakeProvider {
    exchange: Result<TokenResponse, CalendarError>,
    refresh: Result<TokenResponse, CalendarError>,
    calendars: Vec<RawCalendar>,
    /// calendar_id → 결과(없으면 빈 목록). Err로 부분 실패 격리 검증.
    events: HashMap<String, Result<Vec<RawEvent>, CalendarError>>,
    /// create_event 결과(write 트레잇 만족용). 기본은 성공 id.
    create: Result<(String, Option<String>), CalendarError>,
}

impl Default for FakeProvider {
    fn default() -> Self {
        FakeProvider {
            exchange: Err(CalendarError::Terminal("unset".into())),
            refresh: Err(CalendarError::Terminal("unset".into())),
            calendars: Vec::new(),
            events: HashMap::new(),
            create: Ok(("evt_new".into(), Some("https://cal/evt_new".into()))),
        }
    }
}

impl CalendarProvider for FakeProvider {
    async fn exchange_code(
        &self,
        _creds: &CalendarCreds,
        _code: &str,
        _verifier: &str,
        _redirect_uri: &str,
    ) -> Result<TokenResponse, CalendarError> {
        self.exchange.clone()
    }
    async fn refresh_access(&self, _creds: &CalendarCreds) -> Result<TokenResponse, CalendarError> {
        self.refresh.clone()
    }
    async fn list_calendars(&self, _access_token: &str) -> Result<Vec<RawCalendar>, CalendarError> {
        Ok(self.calendars.clone())
    }
    async fn fetch_events(
        &self,
        _access_token: &str,
        calendar_id: &str,
        _time_min: &str,
        _time_max: &str,
    ) -> Result<Vec<RawEvent>, CalendarError> {
        self.events
            .get(calendar_id)
            .cloned()
            .unwrap_or_else(|| Ok(Vec::new()))
    }
    async fn create_event(
        &self,
        _access_token: &str,
        _calendar_id: &str,
        _input: &CreateEventInput,
    ) -> Result<(String, Option<String>), CalendarError> {
        self.create.clone()
    }
}

fn client_only() -> CalendarCreds {
    CalendarCreds {
        client_id: "cid".into(),
        client_secret: "sec".into(),
        refresh_token: None,
    }
}

/// connect_core: 교환이 refresh_token을 주면 creds에 박혀 연결 완료.
#[tokio::test]
async fn connect_core_stores_refresh_token() {
    let provider = FakeProvider {
        exchange: Ok(TokenResponse {
            access_token: "at".into(),
            refresh_token: Some("RT".into()),
            expires_in: 3600,
        }),
        ..Default::default()
    };
    let out = connect_core(
        &provider,
        client_only(),
        "code",
        "ver",
        "http://127.0.0.1:1",
    )
    .await
    .unwrap();
    assert_eq!(out.refresh_token.as_deref(), Some("RT"));
    assert_eq!(out.client_id, "cid", "client는 보존");
}

/// connect_core: refresh_token 없는 교환 응답(이미 승인된 client)은 Terminal로 막힌다.
#[tokio::test]
async fn connect_core_errors_without_refresh_token() {
    let provider = FakeProvider {
        exchange: Ok(TokenResponse {
            access_token: "at".into(),
            refresh_token: None,
            expires_in: 3600,
        }),
        ..Default::default()
    };
    let r = connect_core(
        &provider,
        client_only(),
        "code",
        "ver",
        "http://127.0.0.1:1",
    )
    .await;
    assert!(matches!(r, Err(CalendarError::Terminal(_))));
}

/// refresh_core: 새 access 발급 + refresh 응답 누락 시 기존 refresh_token 보존.
#[tokio::test]
async fn refresh_core_preserves_refresh_when_absent() {
    let connected = CalendarCreds {
        client_id: "cid".into(),
        client_secret: "sec".into(),
        refresh_token: Some("OLD".into()),
    };
    let provider = FakeProvider {
        refresh: Ok(TokenResponse {
            access_token: "fresh".into(),
            refresh_token: None,
            expires_in: 3600,
        }),
        ..Default::default()
    };
    let (access, updated) = refresh_core(&provider, connected).await.unwrap();
    assert_eq!(access, "fresh");
    assert_eq!(
        updated.refresh_token.as_deref(),
        Some("OLD"),
        "refresh 보존"
    );
}

/// refresh_core: refresh_token 없으면(미연결) Terminal — provider 호출 없이 막힌다.
#[tokio::test]
async fn refresh_core_errors_when_not_connected() {
    let provider = FakeProvider::default();
    let r = refresh_core(&provider, client_only()).await;
    assert!(matches!(r, Err(CalendarError::Terminal(_))));
}

fn ev(id: &str, start: &str, all_day: bool) -> RawEvent {
    RawEvent {
        id: id.into(),
        title: id.into(),
        start: start.into(),
        end: start.into(),
        all_day,
        location: None,
        url: None,
    }
}

/// fetch_events_core: 다중 캘린더 병합·시간순 정렬(all-day 먼저)·캘린더별 실패 격리.
#[tokio::test]
async fn fetch_events_core_merges_sorts_isolates() {
    let mut events = HashMap::new();
    events.insert(
        "calA".into(),
        Ok(vec![
            ev("noon", "2026-05-21T12:00:00+09:00", false),
            ev("morning", "2026-05-21T09:00:00+09:00", false),
        ]),
    );
    events.insert("calAllDay".into(), Ok(vec![ev("vac", "2026-05-21", true)]));
    events.insert(
        "calBoom".into(),
        Err(CalendarError::Terminal("boom".into())),
    );
    let provider = FakeProvider {
        events,
        ..Default::default()
    };
    let projects = vec![
        ProjectCalendars {
            project_id: "pA".into(),
            access_token: "a".into(),
            calendars: vec![
                ("calA".into(), "업무".into()),
                ("calAllDay".into(), "개인".into()),
            ],
        },
        ProjectCalendars {
            project_id: "pB".into(),
            access_token: "b".into(),
            calendars: vec![("calBoom".into(), "깨짐".into())], // 실패 → 격리
        },
    ];
    let out = fetch_events_core(&provider, projects, "min", "max").await;
    // calBoom은 격리, 나머지 3건. all-day 먼저 → 09:00 → 12:00.
    let ids: Vec<&str> = out.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["vac", "morning", "noon"]);
    assert_eq!(out[0].calendar_summary, "개인");
    assert_eq!(out[0].project_id, "pA");
    assert!(out[0].all_day);
}

/// fetch_events_core: 빈 선택은 빈 결과(미연결/선택 없음 graceful).
#[tokio::test]
async fn fetch_events_core_empty_selection_is_empty() {
    let provider = FakeProvider::default();
    let out = fetch_events_core(
        &provider,
        vec![ProjectCalendars {
            project_id: "p".into(),
            access_token: "a".into(),
            calendars: vec![],
        }],
        "min",
        "max",
    )
    .await;
    assert!(out.is_empty());
}
