use std::sync::OnceLock;
use std::time::Duration;

use tauri::State;

use crate::cache::TtlCache;
use crate::calendar::{self, CalendarCreds, CalendarProvider};
use crate::commands::projects::fetch_projects;
use crate::commands::tokens::project_credential_ref;
use crate::db::Db;
use crate::error::AppError;
use crate::keychain;
use crate::models::{
    CalendarEvent, CalendarListItem, CreateCalendarEventInput, CreatedCalendarEvent,
    GoogleCalendarStatus, PingResult, SelectedCalendar, TokenKind,
};

// ── Google Calendar OAuth (Phase 10a, read 레일) ───────────────────────────────────
//
// INVARIANT: client_id/secret/refresh_token은 keychain blob({credential_ref}:google_calendar)에만 —
// 인자로만 들어오고 절대 반환되지 않는다. 외부 호출은 Rust(reqwest). read-only(`calendar.readonly`) →
// 외부 mutate 0 → Acceptance 불요(PR Radar read 선례). 실 OAuth/네트워크는 사용자 관찰(헤드리스 제외).

/// 저장된 creds blob을 읽는다(없으면 None). 토큰 본문은 호출 내부에서만 쓰인다(반환 안 함).
async fn load_calendar_creds(db: &Db, project_id: &str) -> Result<Option<CalendarCreds>, String> {
    let cref = project_credential_ref(db, project_id).await?;
    match keychain::get_token(&cref, TokenKind::GoogleCalendar).map_err(|e| e.to_string())? {
        Some(s) => Ok(Some(
            CalendarCreds::from_blob(&s).map_err(|e| e.to_string())?,
        )),
        None => Ok(None),
    }
}

/// OAuth client(client_id/secret)을 keychain blob에 저장(반환 없음). 같은 client면 refresh_token 보존,
/// client가 바뀌면 refresh_token은 버린다(다른 client엔 무효 — 재연결 필요).
#[tauri::command]
#[specta::specta]
pub async fn set_google_oauth_client(
    db: State<'_, Db>,
    project_id: String,
    client_id: String,
    client_secret: String,
) -> Result<(), AppError> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(AppError::validation(
            "calendar.empty_client",
            "client_id/secret이 비었습니다",
        ));
    }
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.project_not_found", e))?;
    let refresh_token = keychain::get_token(&cref, TokenKind::GoogleCalendar)?
        .and_then(|s| CalendarCreds::from_blob(&s).ok())
        .filter(|c| c.client_id == client_id) // 같은 client일 때만 기존 연결 유지.
        .and_then(|c| c.refresh_token);
    let creds = CalendarCreds {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        refresh_token,
    };
    Ok(keychain::set_token(
        &cref,
        TokenKind::GoogleCalendar,
        &creds.to_blob(),
    )?)
}

/// loopback + PKCE(S256) OAuth 실행 → refresh_token을 keychain blob에 저장. bounded(loopback timeout).
/// client 미입력이면 Err(graceful degrade). 실 네트워크/브라우저라 cargo test 아님(사용자 관찰).
#[tauri::command]
#[specta::specta]
pub async fn start_google_oauth(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.project_not_found", e))?;
    let creds = load_calendar_creds(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.creds_load", e))?
        .filter(|c| !c.client_id.is_empty() && !c.client_secret.is_empty())
        .ok_or_else(|| {
            AppError::validation(
                "calendar.client_missing",
                "먼저 OAuth client(client_id/secret)를 입력하세요",
            )
        })?;

    // PKCE + state + loopback bind(redirect_uri 확정) → 브라우저 열기 → redirect 수신(bounded).
    let verifier = calendar::gen_code_verifier();
    let challenge = calendar::pkce_challenge(&verifier);
    let state = calendar::gen_state();
    let loopback = calendar::Loopback::bind().await?;
    let redirect_uri = loopback.redirect_uri.clone();
    let url = calendar::auth_url(&creds.client_id, &redirect_uri, &challenge, &state);
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| {
        AppError::terminal("calendar.browser_open", format!("브라우저 열기 실패: {e}"))
    })?;

    let (code, recv_state) = loopback
        .wait_for_redirect(calendar::LOOPBACK_TIMEOUT)
        .await?;
    if recv_state != state {
        return Err(AppError::terminal(
            "calendar.oauth_state_mismatch",
            "OAuth state 불일치 (CSRF 의심) — 다시 시도하세요",
        ));
    }

    let provider = calendar::HttpCalendarProvider::new()?;
    let updated = calendar::connect_core(&provider, creds, &code, &verifier, &redirect_uri).await?;
    Ok(keychain::set_token(
        &cref,
        TokenKind::GoogleCalendar,
        &updated.to_blob(),
    )?)
}

/// 연결 상태(client 입력됨 / refresh_token 보유). 토큰 본문 미노출(graceful degrade 판정용).
#[tauri::command]
#[specta::specta]
pub async fn google_calendar_status(
    db: State<'_, Db>,
    project_id: String,
) -> Result<GoogleCalendarStatus, AppError> {
    Ok(
        match load_calendar_creds(db.inner(), &project_id)
            .await
            .map_err(|e| AppError::terminal("calendar.creds_load", e))?
        {
            None => GoogleCalendarStatus {
                has_client: false,
                connected: false,
                detail: "OAuth client 미입력".into(),
            },
            Some(c) => {
                let has_client = !c.client_id.is_empty() && !c.client_secret.is_empty();
                let connected = c.has_refresh();
                let detail = if connected {
                    "연결됨".into()
                } else if has_client {
                    "client 입력됨 — '연결'로 Google 동의 진행".into()
                } else {
                    "OAuth client 미입력".into()
                };
                GoogleCalendarStatus {
                    has_client,
                    connected,
                    detail,
                }
            }
        },
    )
}

/// 연결 해제: keychain blob 전체(client + refresh_token) 삭제.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_google(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.project_not_found", e))?;
    Ok(keychain::delete_token(&cref, TokenKind::GoogleCalendar)?)
}

/// 연결 검증(read-only): refresh_token으로 access token 재발급을 시도해 본다(bounded). 토큰 본문 미노출.
/// done-criteria 10a: access token 만료 시 refresh 자동 재발급 경로의 사용자 실측 진입점(Notion/GitHub
/// "Test ping" 선례). 회전된 refresh_token은 merge로 보존 저장. 실 네트워크라 cargo test 아님(사용자 관찰).
#[tauri::command]
#[specta::specta]
pub async fn ping_google_calendar(
    db: State<'_, Db>,
    project_id: String,
) -> Result<PingResult, AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.project_not_found", e))?;
    let Some(creds) = load_calendar_creds(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.creds_load", e))?
    else {
        return Ok(PingResult {
            ok: false,
            detail: "OAuth client 미입력".into(),
        });
    };
    if !creds.has_refresh() {
        return Ok(PingResult {
            ok: false,
            detail: "미연결 — '연결'을 먼저 진행하세요".into(),
        });
    }
    let provider = calendar::HttpCalendarProvider::new()?;
    match calendar::refresh_core(&provider, creds).await {
        Ok((_access, updated)) => {
            // refresh_token이 회전됐을 수 있으니 갱신 저장(merge_refresh로 기존 보존).
            keychain::set_token(&cref, TokenKind::GoogleCalendar, &updated.to_blob())?;
            Ok(PingResult {
                ok: true,
                detail: "연결 정상 (access token 재발급됨)".into(),
            })
        }
        Err(e) => Ok(PingResult {
            ok: false,
            detail: e.to_string(),
        }),
    }
}

// ── Google Calendar 캘린더 선택 + 이벤트 (Phase 10b, read 레일) ─────────────────────
//
// INVARIANT #7: 선택 목록만 로컬 SQLite SSOT(projects.google_calendar_ids). 이벤트는 ambient —
// 영속 없이 매 호출 fresh fetch(PR Radar 선례). read-only → Acceptance 불요. 토큰은 keychain.

/// 프로젝트의 저장된 선택 캘린더([{id,summary}]). 미설정/빈 문자열은 빈 목록.
async fn load_selected_calendars(
    db: &Db,
    project_id: &str,
) -> Result<Vec<SelectedCalendar>, String> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT google_calendar_ids FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    match row.and_then(|r| r.0) {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| e.to_string()),
        _ => Ok(Vec::new()),
    }
}

/// 프로젝트의 access token 확보(refresh로 재발급, bounded). 미연결/client 미입력이면 None.
/// refresh_token이 회전된 경우에만 keychain을 갱신(고빈도 fetch에서 churn 최소화). 토큰 본문 미반환.
async fn access_token_for(db: &Db, project_id: &str) -> Result<Option<String>, String> {
    let cref = project_credential_ref(db, project_id).await?;
    let Some(creds) = load_calendar_creds(db, project_id).await? else {
        return Ok(None);
    };
    if !creds.has_refresh() {
        return Ok(None);
    }
    let provider = calendar::HttpCalendarProvider::new().map_err(|e| e.to_string())?;
    let before = creds.refresh_token.clone();
    let (access, updated) = calendar::refresh_core(&provider, creds)
        .await
        .map_err(|e| e.to_string())?;
    if updated.refresh_token != before {
        keychain::set_token(&cref, TokenKind::GoogleCalendar, &updated.to_blob())
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(access))
}

/// calendarList 조회 + 저장된 선택 반영(selected 플래그). 미연결이면 Err(graceful degrade).
#[tauri::command]
#[specta::specta]
pub async fn list_google_calendars(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<CalendarListItem>, AppError> {
    let access = access_token_for(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| AppError::not_found("calendar.not_connected", "미연결 — 먼저 연결하세요"))?;
    let provider = calendar::HttpCalendarProvider::new()?;
    let cals = provider.list_calendars(&access).await?;
    let selected: std::collections::HashSet<String> =
        load_selected_calendars(db.inner(), &project_id)
            .await
            .map_err(|e| AppError::terminal("calendar.load_selected", e))?
            .into_iter()
            .map(|c| c.id)
            .collect();
    Ok(cals
        .into_iter()
        .map(|c| CalendarListItem {
            selected: selected.contains(&c.id),
            id: c.id,
            summary: c.summary,
            primary: c.primary,
        })
        .collect())
}

/// 선택 캘린더 목록을 저장(JSON [{id,summary}]). 빈 목록이면 fetch 결과 없음.
#[tauri::command]
#[specta::specta]
pub async fn set_selected_calendars(
    db: State<'_, Db>,
    project_id: String,
    calendars: Vec<SelectedCalendar>,
) -> Result<(), AppError> {
    let json = serde_json::to_string(&calendars)
        .map_err(|e| AppError::terminal("calendar.serialize", format!("직렬화 실패: {e}")))?;
    sqlx::query(
        "UPDATE projects SET google_calendar_ids = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(&project_id)
    .bind(json)
    .execute(db.inner())
    .await?;
    Ok(())
}

/// 캘린더 이벤트 표시 캐시(P6). TTL = 60초(프런트 `useCalendarEvents` staleTime과 정합 — 같은
/// staleTime 윈도 안의 다중 뷰가 Rust 캐시도 적중해 Google fetch 횟수를 줄인다). bounded
/// `max_capacity`로 무한 증가 금지. **표시(ambient) 읽기 가속 전용** — escalation/accept/결정
/// 레일 무침투(INVARIANT #2/#4/#7). 상태 SSOT는 SQLite(이 캐시는 Google API 표시 사본일 뿐,
/// 쓰기/상태 소스 아님).
fn calendar_events_cache() -> &'static TtlCache<String, Vec<CalendarEvent>> {
    static CACHE: OnceLock<TtlCache<String, Vec<CalendarEvent>>> = OnceLock::new();
    CACHE.get_or_init(|| TtlCache::new(Duration::from_secs(60), 256))
}

/// 선택 캘린더의 오늘 이벤트를 시간순 병합 반환(ambient). `project_id=None`이면 모든 프로젝트 병합(Today용).
/// 미연결/refresh 실패/선택 없음 프로젝트는 격리(나머지 정상 — INVARIANT graceful degrade).
/// P6: 외부 Google API 읽기를 TTL 캐시로 가속(표시 전용). escalation/accept/결정 레일 무침투.
#[tauri::command]
#[specta::specta]
pub async fn fetch_calendar_events(
    db: State<'_, Db>,
    project_id: Option<String>,
    date: String,
    force_refresh: bool,
) -> Result<Vec<CalendarEvent>, AppError> {
    let offset = calendar::local_offset();
    let (time_min, time_max) = calendar::today_window(&date, &offset);

    let mut project_ids: Vec<String> = match project_id {
        Some(p) => vec![p],
        None => fetch_projects(db.inner())
            .await?
            .into_iter()
            .map(|p| p.id)
            .collect(),
    };
    // 캐시 키 안정화: 정렬된 project_ids + date(+window). 같은 표시 요청은 같은 키.
    project_ids.sort();
    let cache_key = format!("{date}|{time_min}|{time_max}|{}", project_ids.join(","));

    // force_refresh=true: TTL 내라도 캐시 우회 → fresh Google fetch(P7 캘린더 드로어 수동 새로고침
    // 버튼이 호출). false면 TTL 내 적중 시 underlying Google fetch를 건너뛴다(표시 가속).
    let log_key = cache_key.clone();
    calendar_events_cache()
        .get_or_fetch(cache_key, force_refresh, || async {
            // 캐시 miss → 실제 Google fetch 시점(hit이면 이 클로저 미실행 → 로그 없음). 캐시 도입
            // 후 fetch 횟수 절감을 로그로 관측 가능.
            tracing::debug!(
                code = "calendar.cache_miss",
                key = %log_key,
                force = force_refresh,
                "calendar google fetch (cache miss)"
            );
            let provider = calendar::HttpCalendarProvider::new()?;
            let mut ctxs = Vec::new();
            for pid in project_ids {
                // 프로젝트별 부분 실패 격리: 미연결/refresh 실패/선택 없음은 건너뛴다.
                let Ok(Some(access)) = access_token_for(db.inner(), &pid).await else {
                    continue;
                };
                let calendars = load_selected_calendars(db.inner(), &pid)
                    .await
                    .unwrap_or_default();
                if calendars.is_empty() {
                    continue;
                }
                ctxs.push(calendar::ProjectCalendars {
                    project_id: pid,
                    access_token: access,
                    calendars: calendars.into_iter().map(|c| (c.id, c.summary)).collect(),
                });
            }
            Ok(calendar::fetch_events_core(&provider, ctxs, &time_min, &time_max).await)
        })
        .await
}

// ── Google Calendar 이벤트 생성 (Phase 19, write 레일) ──────────────────────────────
//
// INVARIANT #2: 사용자 폼 제출 = 사람 결정 → 직접 write 정합(Acceptance 게이트는 자동화/Codex의
// 외부 mutate 차단용). 외부 호출은 Rust(reqwest)·bounded retry·graceful terminal failure. 토큰은 keychain.
// scope `calendar.events`(read+write) — 기존 readonly 토큰은 재동의(다시 연결) 필요(403 → graceful 노출).

/// 직접 모달의 캘린더 picker가 쓸 프로젝트의 저장된 선택 캘린더([{id,summary}]). 네트워크 없음(로컬 DB).
/// 모달이 어느 캘린더에 쓸지 고르게 한다(연결된 프로젝트의 선택 목록 = 사용자가 이미 고른 캘린더).
#[tauri::command]
#[specta::specta]
pub async fn list_selected_calendars(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<SelectedCalendar>, AppError> {
    load_selected_calendars(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.load_selected", e))
}

/// 카드 → 직접 모달 → Google Calendar 이벤트 생성(write). 사용자 폼 = 사람 결정이라 Acceptance 게이트
/// 불요(#2). 미연결/스코프 부족(readonly 토큰)/네트워크 실패는 graceful Err로 노출. bounded retry.
/// 실 Google write는 사용자 관찰(헤드리스 불가) — 페이로드 빌드/응답 파싱은 calendar.rs cargo test.
#[tauri::command]
#[specta::specta]
pub async fn create_calendar_event(
    db: State<'_, Db>,
    project_id: String,
    calendar_id: String,
    event: CreateCalendarEventInput,
) -> Result<CreatedCalendarEvent, AppError> {
    let title = event.title.trim();
    if title.is_empty() {
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
    let access = access_token_for(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;

    let input = calendar::CreateEventInput {
        title: title.to_string(),
        start: event.start,
        end: event.end,
        all_day: event.all_day,
        description: event
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
    };
    let provider = calendar::HttpCalendarProvider::new()?;
    let (id, url) = provider.create_event(&access, &calendar_id, &input).await?;
    Ok(CreatedCalendarEvent { id, url })
}
