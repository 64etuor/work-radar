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
pub(crate) async fn load_calendar_creds(
    db: &Db,
    project_id: &str,
) -> Result<Option<CalendarCreds>, String> {
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
    keychain::set_token(&cref, TokenKind::GoogleCalendar, &creds.to_blob())?;
    invalidate_calendar_events_cache().await;
    Ok(())
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
        keychain::set_token(&cref, TokenKind::GoogleCalendar, &updated.to_blob())?;
        invalidate_calendar_events_cache().await;
        Ok(())
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
    keychain::delete_token(&cref, TokenKind::GoogleCalendar)?;
    invalidate_calendar_events_cache().await;
    Ok(())
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

/// cref(=project credential_ref)로 Google Calendar access token을 확보한다(refresh_core 재발급, bounded).
/// gate 라우터와 기존 project_id 경로가 공유하는 단일 레시피. refresh_token 회전 시에만 keychain 갱신.
/// 토큰 본문 미반환. (load_calendar_creds는 project_id를 받아 cref를 재유도하므로 시그니처를 바꾸지 않고
/// 여기서 cref 키로 keychain blob을 직접 읽어 from_blob한다 — 사람 경로와 동치.)
pub(crate) async fn access_token_for_cref(cref: &str) -> Result<Option<String>, String> {
    let Some(blob) =
        keychain::get_token(cref, TokenKind::GoogleCalendar).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let creds = CalendarCreds::from_blob(&blob).map_err(|e| e.to_string())?;
    if !creds.has_refresh() {
        return Ok(None);
    }
    let provider = calendar::HttpCalendarProvider::new().map_err(|e| e.to_string())?;
    let before = creds.refresh_token.clone();
    let (access, updated) = calendar::refresh_core(&provider, creds)
        .await
        .map_err(|e| e.to_string())?;
    if updated.refresh_token != before {
        keychain::set_token(cref, TokenKind::GoogleCalendar, &updated.to_blob())
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(access))
}

/// 프로젝트의 access token 확보(refresh로 재발급, bounded). 미연결/client 미입력이면 None.
/// refresh_token이 회전된 경우에만 keychain을 갱신(고빈도 fetch에서 churn 최소화). 토큰 본문 미반환.
/// cref 유도 후 `access_token_for_cref`에 위임한다(gate 라우터와 단일 레시피 공유) — 동작 동일.
pub(crate) async fn access_token_for(db: &Db, project_id: &str) -> Result<Option<String>, String> {
    let cref = project_credential_ref(db, project_id).await?;
    access_token_for_cref(&cref).await
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
    save_selected_calendars(db.inner(), &project_id, calendars).await
}

pub(crate) async fn save_selected_calendars(
    db: &Db,
    project_id: &str,
    calendars: Vec<SelectedCalendar>,
) -> Result<(), AppError> {
    let json = serde_json::to_string(&calendars)
        .map_err(|e| AppError::terminal("calendar.serialize", format!("직렬화 실패: {e}")))?;
    sqlx::query(
        "UPDATE projects SET google_calendar_ids = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(project_id)
    .bind(json)
    .execute(db)
    .await?;
    invalidate_calendar_events_cache().await;
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

/// 표시 캐시 전체 무효화. 이벤트 색(project_color)은 fetch 시점에 박혀 캐시에 들어가므로,
/// 프로젝트 캘린더 색 변경 시 다음 fetch가 새 색으로 재구성되도록 이 캐시를 비워야 한다
/// (프런트 `["calendarEvents"]` 무효화만으론 refetch가 force_refresh=false라 stale 색을 다시 받음).
/// 색 변경은 드문 사용자 액션이라 전체 무효화로 충분(키 단위 부분 무효화 불요).
pub(crate) async fn invalidate_calendar_events_cache() {
    calendar_events_cache().invalidate_all().await;
}

#[cfg(test)]
async fn seed_calendar_events_cache_for_test(key: String, events: Vec<CalendarEvent>) {
    calendar_events_cache()
        .get_or_fetch(key, true, || async { Ok::<_, AppError>(events) })
        .await
        .expect("seed calendar events cache");
}

#[cfg(test)]
async fn calendar_events_cache_contains_for_test(key: &str) -> bool {
    let events = calendar_events_cache()
        .get_or_fetch(key.to_string(), false, || async {
            Ok::<_, AppError>(Vec::<CalendarEvent>::new())
        })
        .await
        .expect("read calendar events cache");
    !events.is_empty()
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
    let mut events = calendar_events_cache()
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
            Ok::<_, AppError>(
                calendar::fetch_events_core(&provider, ctxs, &time_min, &time_max).await,
            )
        })
        .await?;
    overlay_pending_event_writes(db, &mut events).await?;
    Ok(events)
}

/// ADR-0002 "큐에 우리 pending이 있으면 우리 값이 이김": 표시 read가 아직 Google에 반영
/// 전(디바운스/재시도 중)인 pending write를 fetch 결과(TTL 캐시 포함) 위에 오버레이한다.
/// 이게 없으면 디바운스 윈도 안의 refetch가 Google의 옛 시간을 돌려줘 로컬 편집이 화면에서
/// 되돌아간다. staged 행(cross-cal Acceptance 대기)은 사람 승인 전이므로 미적용.
///
/// P5B(routine_master 검토, 결론 = 케이스 a — 오버레이 확장 불요): P4a–P4c가 도입한
/// `routine_master` create/patch/`series_replace` pending 행은 디바운스 윈도 동안 화면에
/// stale 아티팩트를 만들지 **않으므로** 이 오버레이가 관여할 필요가 없다. 근거:
///  · Google은 반복 마스터를 `singleEvents=true`로 **per-instance 전개**해 돌려준다
///    (calendar/http.rs `("singleEvents","true")`) — 각 인스턴스 id는 인스턴스 고유값이고
///    `recurringEventId`가 마스터 id다(calendar/parse.rs `parse_calendar_event`).
///  · 프런트 `buildTodayBlocks`(src/lib/todayBlocks.ts)가 각 시각 루틴을 instance-link
///    (`linked_event_id`)와 **master(`google_event_id`)** 양쪽 키로 등록하고, fetch된 이벤트를
///    id **또는 `recurringEventId`** 로 매칭해(`eventLookupKeys`) 매칭되면 **흡수**한다 —
///    루틴은 앱-정본 시각(override ?? time_of_day)으로 정확히 1블록만 그린다. 편집(patch/exdate)·
///    분할(series_replace)은 미러의 `google_event_id`를 옛 마스터에 **그대로 둔 채** 워커 flush를
///    기다리므로, 윈도 동안 옛 마스터의 전개 인스턴스는 identity로 흡수되고 블록은 앱-정본 시각으로
///    렌더된다(stale 없음). enable(create)은 옛 마스터가 없어 흡수 대상 자체가 없다.
///  · 이 오버레이의 `delete`/`patch` arm은 `e.id`(=인스턴스 id)로 매칭하므로 반복 마스터의 전개
///    인스턴스와는 구조적으로 매칭되지 않는다 — 반복 이벤트 표시 정합은 위 프런트 흡수가 담당한다
///    (이 함수는 signal/event 단일 이벤트용). disable/move의 마스터 삭제는 event-키 delete 행이지만
///    미러 정리·프런트 흡수 해제가 함께 일어나는 별개 경로이며 P5B 범위(=routine_master pending) 밖.
async fn overlay_pending_event_writes(
    db: &Db,
    events: &mut Vec<CalendarEvent>,
) -> Result<(), AppError> {
    // attempts >= 3(재시도 예산 소진 = is_terminal_attempt)은 제외 — Google에 반영되지 못한
    // 채로 큐에 남는 행이 화면을 영구히 거짓으로 덮지 않게 한다(실패는 토스트로 이미 노출).
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT kind, calendar_id, event_id, payload_json
         FROM pending_calendar_writes
         WHERE event_id IS NOT NULL
           AND attempts < 3
           AND (json_extract(payload_json, '$.staged') IS NULL
                OR json_extract(payload_json, '$.staged') = 0)",
    )
    .fetch_all(db)
    .await?;
    apply_pending_overlay(events, &rows);
    Ok(())
}

/// 순수 오버레이 — `delete` pending은 이벤트 숨김, `patch`(start+duration_min)는 시간 덮어쓰기.
/// `create`는 event_id가 아직 없어 대상 외. all-day 이벤트는 patch payload가 timed 전제라 skip.
/// 파싱 불가 payload는 조용히 건너뛴다(오버레이는 표시 가속 — 실패해도 fetch 결과 그대로).
/// 같은 이벤트에 patch+delete가 공존하면(큐 UNIQUE상 kind별 최대 1행) 순서 무관 delete가 이긴다
/// (retain이 패치 여부와 무관하게 제거).
fn apply_pending_overlay(
    events: &mut Vec<CalendarEvent>,
    rows: &[(String, String, String, String)],
) {
    for (kind, cal_id, event_id, payload) in rows {
        match kind.as_str() {
            "delete" => {
                events.retain(|e| !(e.id == *event_id && e.calendar_id == *cal_id));
            }
            "patch" => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                    continue;
                };
                let Some(raw_start) = v.get("start").and_then(|x| x.as_str()) else {
                    continue;
                };
                let Some(dur) = v.get("duration_min").and_then(|x| x.as_i64()) else {
                    continue;
                };
                let Ok(start) = calendar::sync::normalize_timed_start(raw_start) else {
                    continue;
                };
                let Ok(end) = calendar::sync::compute_end(&start, dur, false) else {
                    continue;
                };
                for e in events.iter_mut() {
                    if e.id == *event_id && e.calendar_id == *cal_id && !e.all_day {
                        e.start = start.clone();
                        e.end = end.clone();
                    }
                }
            }
            _ => {}
        }
    }
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
    let offset = crate::timezone::local_offset_string();
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
    fetch_calendar_events_range_inner(
        db.inner(),
        project_id,
        &start_date,
        &end_date,
        force_refresh,
    )
    .await
}

/// `fetch_calendar_events_range`의 코어(State 없이 호출 가능 — MCP `wr_calendar_list_events`가 공유).
/// 미연결/선택 캘린더 없음 프로젝트는 조용히 건너뛴다(graceful degrade) — 호출자는 빈 목록이
/// "일정 없음"과 "미연결" 둘 다일 수 있음을 안다.
pub(crate) async fn fetch_calendar_events_range_inner(
    db: &Db,
    project_id: Option<String>,
    start_date: &str,
    end_date: &str,
    force_refresh: bool,
) -> Result<Vec<CalendarEvent>, AppError> {
    let offset = crate::timezone::local_offset_string();
    let (time_min, time_max) = calendar::range_window(start_date, end_date, &offset);
    let project_ids = resolve_project_ids(db, project_id).await?;
    fetch_events_windowed(db, project_ids, time_min, time_max, force_refresh).await
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
    let access = access_token_for(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let provider = calendar::HttpCalendarProvider::new()?;
    create_calendar_event_with_provider(&provider, &access, &calendar_id, event).await
}

async fn create_calendar_event_with_provider<P: CalendarProvider>(
    provider: &P,
    access: &str,
    calendar_id: &str,
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

    let input = calendar::CreateEventInput {
        title: title.to_string(),
        start: event.start,
        end: event.end,
        all_day: event.all_day,
        description: event
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
        ..Default::default()
    };
    let (id, url) = provider.create_event(access, calendar_id, &input).await?;
    invalidate_calendar_events_cache().await;
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
            recurring_event_id: None,
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

    /// ADR-0002 pending-이김 오버레이: patch는 시간 덮어쓰기, delete는 숨김, all-day는 skip.
    #[test]
    fn pending_overlay_patch_overrides_and_delete_hides() {
        let mut events = vec![
            CalendarEvent {
                id: "e1".into(),
                calendar_id: "c1".into(),
                ..ev(
                    "회의",
                    "2026-06-10T10:00:00+09:00",
                    "2026-06-10T10:30:00+09:00",
                )
            },
            CalendarEvent {
                id: "e2".into(),
                calendar_id: "c1".into(),
                ..ev(
                    "점심",
                    "2026-06-10T12:00:00+09:00",
                    "2026-06-10T13:00:00+09:00",
                )
            },
            CalendarEvent {
                id: "e3".into(),
                calendar_id: "c1".into(),
                all_day: true,
                ..ev("휴가", "2026-06-10", "2026-06-11")
            },
        ];
        let rows = vec![
            (
                "patch".to_string(),
                "c1".to_string(),
                "e1".to_string(),
                r#"{"start":"2026-06-10T14:00:00+09:00","duration_min":45}"#.to_string(),
            ),
            (
                "delete".to_string(),
                "c1".to_string(),
                "e2".to_string(),
                "{}".to_string(),
            ),
            (
                "patch".to_string(),
                "c1".to_string(),
                "e3".to_string(),
                r#"{"start":"2026-06-10T09:00:00+09:00","duration_min":30}"#.to_string(),
            ),
        ];
        apply_pending_overlay(&mut events, &rows);
        assert_eq!(events.len(), 2, "delete pending은 이벤트를 숨긴다");
        assert_eq!(events[0].id, "e1");
        assert_eq!(events[0].start, "2026-06-10T14:00:00+09:00");
        assert_eq!(events[0].end, "2026-06-10T14:45:00+09:00");
        assert_eq!(events[1].id, "e3");
        assert_eq!(events[1].start, "2026-06-10", "all-day는 오버레이 비대상");
    }

    /// 다른 캘린더/이벤트 id·깨진 payload는 오버레이 무영향(표시 가속 — 조용히 skip).
    #[test]
    fn pending_overlay_ignores_mismatches_and_bad_payload() {
        let mut events = vec![CalendarEvent {
            id: "e1".into(),
            calendar_id: "c1".into(),
            ..ev(
                "회의",
                "2026-06-10T10:00:00+09:00",
                "2026-06-10T10:30:00+09:00",
            )
        }];
        let rows = vec![
            (
                "patch".to_string(),
                "c2".to_string(), // 다른 캘린더
                "e1".to_string(),
                r#"{"start":"2026-06-10T14:00:00+09:00","duration_min":45}"#.to_string(),
            ),
            (
                "patch".to_string(),
                "c1".to_string(),
                "e1".to_string(),
                "not-json".to_string(),
            ),
            (
                "create".to_string(),
                "c1".to_string(),
                "e1".to_string(),
                "{}".to_string(),
            ),
        ];
        apply_pending_overlay(&mut events, &rows);
        assert_eq!(events[0].start, "2026-06-10T10:00:00+09:00");
        assert_eq!(events.len(), 1);
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

    #[tokio::test]
    async fn selected_calendar_changes_clear_event_ttl_cache() {
        let db = fresh_db().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &project_input("업무", crate::models::ProjectKind::Work),
        )
        .await
        .unwrap();

        let key = "test-window|project".to_string();
        seed_calendar_events_cache_for_test(
            key.clone(),
            vec![CalendarEvent {
                id: "old".into(),
                calendar_id: "old-cal".into(),
                ..ev(
                    "기존 일정",
                    "2026-06-10T10:00:00+09:00",
                    "2026-06-10T10:30:00+09:00",
                )
            }],
        )
        .await;
        assert!(
            calendar_events_cache_contains_for_test(&key).await,
            "precondition: cache entry is populated"
        );

        save_selected_calendars(
            &db,
            &project.id,
            vec![SelectedCalendar {
                id: "new-cal".into(),
                summary: "새 캘린더".into(),
            }],
        )
        .await
        .unwrap();

        assert!(
            !calendar_events_cache_contains_for_test(&key).await,
            "calendar selection changes must invalidate the Rust TTL event cache"
        );
    }

    struct CreateOnlyProvider;

    impl CalendarProvider for CreateOnlyProvider {
        async fn exchange_code(
            &self,
            _creds: &CalendarCreds,
            _code: &str,
            _verifier: &str,
            _redirect_uri: &str,
        ) -> Result<calendar::TokenResponse, calendar::CalendarError> {
            unreachable!("not used by direct create test")
        }

        async fn refresh_access(
            &self,
            _creds: &CalendarCreds,
        ) -> Result<calendar::TokenResponse, calendar::CalendarError> {
            unreachable!("not used by direct create test")
        }

        async fn list_calendars(
            &self,
            _access_token: &str,
        ) -> Result<Vec<calendar::RawCalendar>, calendar::CalendarError> {
            unreachable!("not used by direct create test")
        }

        async fn fetch_events(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _time_min: &str,
            _time_max: &str,
        ) -> Result<Vec<calendar::RawEvent>, calendar::CalendarError> {
            unreachable!("not used by direct create test")
        }

        async fn create_event(
            &self,
            _access_token: &str,
            calendar_id: &str,
            input: &calendar::CreateEventInput,
        ) -> Result<(String, Option<String>), calendar::CalendarError> {
            assert_eq!(calendar_id, "new-cal");
            assert_eq!(input.title, "새 일정");
            Ok((
                "created-event".into(),
                Some("https://calendar.example/e".into()),
            ))
        }

        async fn patch_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _event_id: &str,
            _patch: &serde_json::Value,
        ) -> Result<(), calendar::CalendarError> {
            unreachable!("not used by direct create test")
        }

        async fn delete_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _event_id: &str,
        ) -> Result<(), calendar::CalendarError> {
            unreachable!("not used by direct create test")
        }
    }

    #[tokio::test]
    async fn successful_direct_calendar_create_clears_event_ttl_cache() {
        let key = "test-create-window|project".to_string();
        seed_calendar_events_cache_for_test(
            key.clone(),
            vec![CalendarEvent {
                id: "old".into(),
                calendar_id: "new-cal".into(),
                ..ev(
                    "기존 일정",
                    "2026-06-10T10:00:00+09:00",
                    "2026-06-10T10:30:00+09:00",
                )
            }],
        )
        .await;
        assert!(calendar_events_cache_contains_for_test(&key).await);

        let created = create_calendar_event_with_provider(
            &CreateOnlyProvider,
            "access-token",
            "new-cal",
            CreateCalendarEventInput {
                title: " 새 일정 ".into(),
                start: "2026-06-10T14:00:00+09:00".into(),
                end: "2026-06-10T15:00:00+09:00".into(),
                all_day: false,
                description: Some(" 설명 ".into()),
            },
        )
        .await
        .unwrap();

        assert_eq!(created.id, "created-event");
        assert!(
            !calendar_events_cache_contains_for_test(&key).await,
            "successful direct create must invalidate the Rust TTL event cache"
        );
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
