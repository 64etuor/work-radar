use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::cache::TtlCache;
use crate::calendar::{self, CalendarCreds, CalendarProvider};
use crate::commands::projects::{
    effective_project_calendar_color, fetch_projects, readable_text_color,
};
use crate::commands::tokens::project_credential_ref;
use crate::db::Db;
use crate::error::AppError;
use crate::keychain;
use crate::models::{
    CalendarEvent, CalendarListItem, CreateCalendarEventInput, CreatedCalendarEvent,
    GoogleCalendarStatus, PingResult, SelectedCalendar, TokenKind,
};

#[derive(Clone)]
struct GoogleOauthAttempt {
    id: u64,
    cancel: CancellationToken,
}

fn oauth_attempts() -> &'static Mutex<HashMap<String, GoogleOauthAttempt>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, GoogleOauthAttempt>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_oauth_attempts() -> MutexGuard<'static, HashMap<String, GoogleOauthAttempt>> {
    match oauth_attempts().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn begin_google_oauth_attempt(project_id: &str) -> GoogleOauthAttempt {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let attempt = GoogleOauthAttempt {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        cancel: CancellationToken::new(),
    };
    let previous = lock_oauth_attempts().insert(project_id.to_string(), attempt.clone());
    if let Some(previous) = previous {
        previous.cancel.cancel();
    }
    attempt
}

fn finish_google_oauth_attempt(project_id: &str, attempt_id: u64) {
    let mut attempts = lock_oauth_attempts();
    if attempts
        .get(project_id)
        .is_some_and(|attempt| attempt.id == attempt_id)
    {
        attempts.remove(project_id);
    }
}

fn cancel_google_oauth_attempt(project_id: &str) -> bool {
    let attempt = lock_oauth_attempts().remove(project_id);
    if let Some(attempt) = attempt {
        attempt.cancel.cancel();
        true
    } else {
        false
    }
}

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

    let attempt = begin_google_oauth_attempt(&project_id);
    let result = async {
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

        let (code, recv_state) = tokio::select! {
            result = loopback.wait_for_redirect(calendar::LOOPBACK_TIMEOUT) => result?,
            _ = attempt.cancel.cancelled() => {
                return Err(AppError::cancelled(
                    "calendar.oauth_cancelled",
                    "Google Calendar 연결 대기를 취소했습니다",
                ));
            }
        };
        if recv_state != state {
            return Err(AppError::terminal(
                "calendar.oauth_state_mismatch",
                "OAuth state 불일치 (CSRF 의심) — 다시 시도하세요",
            ));
        }

        let provider = calendar::HttpCalendarProvider::new()?;
        let updated =
            calendar::connect_core(&provider, creds, &code, &verifier, &redirect_uri).await?;
        Ok(keychain::set_token(
            &cref,
            TokenKind::GoogleCalendar,
            &updated.to_blob(),
        )?)
    }
    .await;
    finish_google_oauth_attempt(&project_id, attempt.id);
    result
}

/// 진행 중인 loopback OAuth 대기를 취소한다. 브라우저 창을 닫았거나 잘못 열었을 때 UI가 180초
/// timeout을 기다리지 않고 재시도할 수 있게 한다.
#[tauri::command]
#[specta::specta]
pub async fn cancel_google_oauth(project_id: String) -> Result<bool, AppError> {
    Ok(cancel_google_oauth_attempt(&project_id))
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

/// 캐시 키([time_min,time_max] 윈도우)로 선택 캘린더 이벤트를 단일 Google range 호출로 병합 반환.
/// `fetch_calendar_events`(하루)와 `fetch_calendar_events_range`(임의 범위)가 공유하는 본체. 한 윈도우
/// = 한 [time_min,time_max] 쌍 → 캘린더당 **단일 range 호출**(N일×1콜 아님 — 주/월도 단발). 프로젝트별
/// 부분 실패 격리(미연결/refresh 실패/선택 없음 건너뜀 — graceful degrade). P6 TTL 캐시(표시 가속, 결정
/// 레일 무침투). force_refresh=true면 TTL 내라도 캐시 우회 → fresh Google fetch(드로어 수동 새로고침).
async fn fetch_events_windowed(
    db: &Db,
    mut project_ids: Vec<String>,
    time_min: String,
    time_max: String,
    force_refresh: bool,
) -> Result<Vec<CalendarEvent>, AppError> {
    // 캐시 키 안정화: 정렬된 project_ids + 윈도우. 같은 표시 요청은 같은 키.
    project_ids.sort();
    let cache_key = format!("{time_min}|{time_max}|{}", project_ids.join(","));

    let log_key = cache_key.clone();
    calendar_events_cache()
        .get_or_fetch(cache_key, force_refresh, || async {
            // 캐시 miss → 실제 Google fetch 시점(hit이면 이 클로저 미실행 → 로그 없음).
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
                let Ok(Some(access)) = access_token_for(db, &pid).await else {
                    continue;
                };
                let calendars = load_selected_calendars(db, &pid).await.unwrap_or_default();
                if calendars.is_empty() {
                    continue;
                }
                let configured_color: Option<String> =
                    sqlx::query_scalar("SELECT calendar_color FROM projects WHERE id = ?1")
                        .bind(&pid)
                        .fetch_optional(db)
                        .await?
                        .flatten();
                let project_color =
                    effective_project_calendar_color(&pid, configured_color.as_deref());
                let project_text_color = readable_text_color(&project_color);
                ctxs.push(calendar::ProjectCalendars {
                    project_id: pid.clone(),
                    project_color,
                    project_text_color,
                    access_token: access,
                    calendars: calendars.into_iter().map(|c| (c.id, c.summary)).collect(),
                });
            }
            Ok(calendar::fetch_events_core(&provider, ctxs, &time_min, &time_max).await)
        })
        .await
}

/// 단일 프로젝트(또는 전체)의 project_id 목록을 해석한다(None=모든 프로젝트 병합, Today/Drawer 공용).
async fn resolve_project_ids(db: &Db, project_id: Option<String>) -> Result<Vec<String>, AppError> {
    Ok(match project_id {
        Some(p) => vec![p],
        None => fetch_projects(db)
            .await?
            .into_iter()
            .map(|p| p.id)
            .collect(),
    })
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
    let project_ids = resolve_project_ids(db.inner(), project_id).await?;
    fetch_events_windowed(db.inner(), project_ids, time_min, time_max, force_refresh).await
}

/// 임의 [start_date, end_date] 범위 이벤트를 시간순 병합 반환(P7 드로어 일/주/월 뷰). 경계 산출(주 시작
/// 요일·월 경계)은 프런트가 정하고, Rust는 그 [start,end]를 단일 RFC3339 윈도우로 감싸 **캘린더당 단일
/// range 호출**한다(주/월도 N일×1콜 금지). `project_id=None`이면 모든 프로젝트 병합. P6 TTL 캐시는 윈도우
/// (time_min/time_max)별 키 → 일/주/월 각 범위가 독립 캐시. force_refresh=true는 드로어 수동 새로고침이
/// 캐시를 우회해 fresh Google fetch(표시 가속 전용, escalation/accept/결정 레일 무침투 — INVARIANT #2/#4).
#[tauri::command]
#[specta::specta]
pub async fn fetch_calendar_events_range(
    db: State<'_, Db>,
    project_id: Option<String>,
    start_date: String,
    end_date: String,
    force_refresh: bool,
) -> Result<Vec<CalendarEvent>, AppError> {
    let offset = calendar::local_offset();
    let (time_min, time_max) = calendar::range_window(&start_date, &end_date, &offset);
    let project_ids = resolve_project_ids(db.inner(), project_id).await?;
    fetch_events_windowed(db.inner(), project_ids, time_min, time_max, force_refresh).await
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

// ── 캘린더 긴급도 가중 (Phase 8 #3, 표시 힌트 전용) ──────────────────────────────────
//
// ⚠️ INVARIANT #1: 카드 title/keywords를 (이미 표시 중인 ambient) 캘린더 이벤트 title과 퍼지 매칭해,
//    연관 이벤트가 임박하면 그 카드의 **suggested_quadrant 힌트만** 위로 가중한다. 확정 `quadrant`(사람
//    결정 위치)는 절대 미접근 — 자동 이동/자동 분류 0. 가중 결과는 unclassified 카드의 suggested_quadrant
//    에만 쓰인다(set_suggested_quadrant_only이 WHERE quadrant='unclassified'로 구조적 강제). 점수 계산은
//    순수 함수 urgency::calendar_urgency_score(cargo test)이고, 이 커맨드는 그 결과를 힌트로 영속할 뿐이다.

/// 미분류 카드 1개에 캘린더 긴급도 가중을 적용한다(표시 힌트 — suggested_quadrant만). 호출부(보드)가
/// 이미 가진 ambient 캘린더 이벤트를 그대로 넘긴다(추가 네트워크/토큰 없음 — 표시 사본 재사용). 반환은
/// 갱신된 신호(확정 quadrant는 unclassified 유지). 매칭 이벤트가 없거나 임계치 미만이면 힌트 무변경.
#[tauri::command]
#[specta::specta]
pub async fn apply_calendar_urgency(
    db: State<'_, Db>,
    signal_id: String,
    keywords: Vec<String>,
    events: Vec<CalendarEvent>,
) -> Result<crate::models::WorkSignal, AppError> {
    use crate::commands::signal_store;
    use crate::urgency::{calendar_urgency_score, urgency_escalated_quadrant};

    // 카드(title + 현재 suggested_quadrant base) 조회. 미존재면 not_found.
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT title, quadrant, suggested_quadrant FROM signals WHERE id = ?1")
            .bind(&signal_id)
            .fetch_optional(db.inner())
            .await?;
    let (title, quadrant, suggested) =
        row.ok_or_else(|| AppError::not_found("calendar.signal_not_found", "신호를 찾을 수 없음"))?;

    // 확정 분류된 카드는 가중 대상 아님(suggested 힌트는 미분류 카드의 표시용). 확정 quadrant 무접근.
    if quadrant != "unclassified" {
        return Err(AppError::validation(
            "calendar.signal_already_classified",
            "이미 분류된 카드에는 긴급도 힌트를 쓰지 않습니다(확정 위치 무변경).",
        ));
    }

    // base = 현재 suggested_quadrant(enrich 제안 등). 닫힌 세트 밖/None이면 None으로 본다.
    let base = suggested.as_deref().and_then(parse_quadrant_hint);
    let now = chrono::Utc::now().timestamp();
    let score = calendar_urgency_score(&title, &keywords, &events, now);
    let next = urgency_escalated_quadrant(base, score);

    // 표시 힌트만 갱신(area/reason 보존, WHERE quadrant='unclassified'). 확정 quadrant 미접근.
    Ok(signal_store::set_suggested_quadrant_only(db.inner(), &signal_id, next).await?)
}

/// suggested_quadrant 문자열 힌트 → Quadrant(닫힌 세트). 세트 밖/미상은 None(가중 base 없음 취급).
fn parse_quadrant_hint(s: &str) -> Option<crate::models::Quadrant> {
    use crate::models::Quadrant;
    match s {
        "q1_do_now" => Some(Quadrant::Q1DoNow),
        "q2_schedule" => Some(Quadrant::Q2Schedule),
        "q3_quick_contain" => Some(Quadrant::Q3QuickContain),
        "q4_drop" => Some(Quadrant::Q4Drop),
        "unclassified" => Some(Quadrant::Unclassified),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::{insert_signal, set_suggested_quadrant_only};
    use crate::models::CalendarEvent;
    use crate::urgency::{calendar_urgency_score, urgency_escalated_quadrant};

    fn ev(title: &str, start: &str, end: &str) -> CalendarEvent {
        CalendarEvent {
            id: "e".into(),
            calendar_id: "c".into(),
            calendar_summary: "cal".into(),
            title: title.into(),
            start: start.into(),
            end: end.into(),
            all_day: false,
            location: None,
            url: None,
            project_id: "p".into(),
            project_color: "#2D6CDF".into(),
            project_text_color: "#FFFFFF".into(),
        }
    }

    #[test]
    fn google_oauth_attempts_are_cancelled_and_removed() {
        static TEST_ID: AtomicU64 = AtomicU64::new(1);
        let project_id = format!("oauth-test-{}", TEST_ID.fetch_add(1, Ordering::Relaxed));
        let first = begin_google_oauth_attempt(&project_id);
        assert!(!first.cancel.is_cancelled());

        let second = begin_google_oauth_attempt(&project_id);
        assert!(first.cancel.is_cancelled());
        assert!(!second.cancel.is_cancelled());

        assert!(cancel_google_oauth_attempt(&project_id));
        assert!(second.cancel.is_cancelled());
        assert!(!cancel_google_oauth_attempt(&project_id));

        let third = begin_google_oauth_attempt(&project_id);
        finish_google_oauth_attempt(&project_id, third.id + 1);
        assert!(cancel_google_oauth_attempt(&project_id));
        assert!(third.cancel.is_cancelled());
    }

    /// INVARIANT #1/#2 펜스(plan 검증): 미분류 카드 + **제목 매칭** 캘린더 이벤트가 임박하면 긴급도 점수가
    /// (매칭 없을 때보다) 상승하고, 그 가중은 **suggested_quadrant**에만 반영된다. 확정 `quadrant`는 끝까지
    /// unclassified로 남아야 한다(카드 자동 이동 0).
    #[tokio::test]
    async fn urgency_raises_suggested_hint_without_moving_quadrant() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("데모 준비", None)).await.unwrap();
        // 시작 상태: 확정 미분류 + 제안 힌트 없음.
        assert!(matches!(
            sig.quadrant,
            crate::models::Quadrant::Unclassified
        ));
        assert!(sig.suggested_quadrant.is_none());

        let now = chrono::Utc::now().timestamp();

        // 매칭 이벤트 없음(전): 점수 0 → 힌트 무변경(None 유지).
        let score_before = calendar_urgency_score(
            &sig.title,
            &[],
            &[ev(
                "치과 예약",
                &rfc3339_from_now(now, 6 * 3600),
                &rfc3339_from_now(now, 7 * 3600),
            )],
            now,
        );
        assert_eq!(score_before, 0.0, "매칭 이벤트 없으면 점수 0");

        // 매칭 이벤트 임박(후): 6시간 뒤 "팀 데모 발표" → 점수 상승.
        let matching = vec![ev(
            "팀 데모 발표",
            &rfc3339_from_now(now, 6 * 3600),
            &rfc3339_from_now(now, 7 * 3600),
        )];
        let score_after = calendar_urgency_score(&sig.title, &[], &matching, now);
        assert!(
            score_after > score_before,
            "매칭+임박이면 긴급도 상승: {score_after} > {score_before}"
        );

        // 가중을 suggested_quadrant에만 반영(확정 quadrant 무접근).
        let base = sig
            .suggested_quadrant
            .as_deref()
            .and_then(parse_quadrant_hint);
        let next = urgency_escalated_quadrant(base, score_after);
        assert!(
            matches!(next, Some(crate::models::Quadrant::Q1DoNow)),
            "임박 매칭 → q1 제안 힌트"
        );
        let updated = set_suggested_quadrant_only(&db, &sig.id, next)
            .await
            .unwrap();

        // 펜스: 확정 quadrant는 여전히 unclassified(카드 자동 이동 0), suggested만 상승.
        assert!(
            matches!(updated.quadrant, crate::models::Quadrant::Unclassified),
            "INVARIANT #1: 긴급도가 카드를 자동 이동시키지 않음(quadrant 불변)"
        );
        assert_eq!(
            updated.suggested_quadrant.as_deref(),
            Some("q1_do_now"),
            "긴급도 가중은 suggested_quadrant에만 반영"
        );

        // DB 재조회로 영속 확인(확정 quadrant 무변경 재확인).
        let row: (String, Option<String>) =
            sqlx::query_as("SELECT quadrant, suggested_quadrant FROM signals WHERE id = ?1")
                .bind(&sig.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(row.0, "unclassified", "확정 quadrant 영속 무변경");
        assert_eq!(row.1.as_deref(), Some("q1_do_now"));
    }

    /// now+offset초의 RFC3339(UTC) 문자열. 테스트 이벤트 시각 합성용.
    fn rfc3339_from_now(now: i64, offset: i64) -> String {
        chrono::DateTime::from_timestamp(now + offset, 0)
            .unwrap()
            .to_rfc3339()
    }
}
