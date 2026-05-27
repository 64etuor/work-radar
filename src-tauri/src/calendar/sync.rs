//! SyncEngine — pending_calendar_writes 워커 (Today×Timeline PR 2).
//!
//! tokio interval + Notify 즉시 깨우기로 큐를 굴린다. Google API 디바운스는
//! `next_attempt_at = now + debounce_ms` (pending_store.upsert_write) + `fetch_due_writes`
//! 가 처리.
//!
//! INVARIANT #5: bounded retry — 실패는 backoff [1s, 3s, 9s] 3회 후 `last_error` 보존하고
//! emit `CalendarSyncFailed`(spec §6.4). 성공은 큐에서 제거하고 emit `CalendarSyncFlushed`.
//!
//! INVARIANT #2: cross-cal 변경은 payload `staged=true`라 `fetch_due_writes`가 skip한다
//! (commit_staged_writes IPC가 staged 플래그를 제거할 때만 워커가 가져간다).

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{interval, Duration, MissedTickBehavior};

use crate::calendar::pending_store::{
    delete_write, fetch_due_writes, is_terminal_attempt, record_failure,
};
use crate::calendar::timing::SYNC_WORKER_TICK_MS;
use crate::calendar::{
    refresh_core, CalendarCreds, CalendarProvider, CreateEventInput, HttpCalendarProvider,
};
use crate::commands::tokens::project_credential_ref;
use crate::keychain;
use crate::models::{PendingWrite, TokenKind};

/// 워커 컨텍스트. `spawn`이 self를 통째로 move해 백그라운드 태스크가 된다. notify는 IPC 커맨드가
/// 큐를 채운 직후 깨울 핸들 — `tauri::Builder::manage(Arc<Notify>)`로 외부에 노출된다.
pub struct SyncEngine {
    pool: SqlitePool,
    app: AppHandle,
    notify: Arc<Notify>,
}

impl SyncEngine {
    /// 생성. notify는 IPC 커맨드(stage_calendar_write/commit_staged_writes)가 같은 Arc로
    /// `notify_one()`을 호출해 다음 사이클을 즉시 깨운다.
    pub fn new(pool: SqlitePool, app: AppHandle) -> (Self, Arc<Notify>) {
        let notify = Arc::new(Notify::new());
        (
            Self {
                pool,
                app,
                notify: notify.clone(),
            },
            notify,
        )
    }

    /// 백그라운드 태스크로 굴린다. 한 인스턴스(start_recovery_monitor 패턴과 동일) 가정.
    /// Tauri setup hook이 sync context이므로 tokio::spawn 대신 tauri::async_runtime::spawn 사용.
    pub fn spawn(self) {
        tauri::async_runtime::spawn(async move { self.run().await });
    }

    async fn run(self) {
        let mut tick = interval(Duration::from_millis(SYNC_WORKER_TICK_MS));
        // 슬립/일시정지 후 tight-loop catch-up 방지(다음 tick까지 한 박자 지연).
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = self.notify.notified() => {}
            }
            if let Err(e) = self.flush_once().await {
                tracing::warn!(
                    code = "calendar.sync.flush_failed",
                    error = %e,
                    "sync flush_once error"
                );
            }
        }
    }

    async fn flush_once(&self) -> sqlx::Result<()> {
        let due = fetch_due_writes(&self.pool).await?;
        if due.is_empty() {
            return Ok(());
        }
        // tick 시작 시점에 (1) provider 1회 빌드, (2) calendar_id → project_id 매핑 1회 스캔,
        // (3) project_id → access_token lazy 캐시. 한 tick 안에서 동일 캘린더/프로젝트의 다중 행이
        // refresh_core(외부 호출 + keychain rotate)를 여러 번 때리는 비용을 제거한다.
        let provider = match HttpCalendarProvider::new() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(
                    code = "calendar.sync.provider_init_failed",
                    error = %e,
                    "skip flush tick"
                );
                return Ok(());
            }
        };
        let calendar_to_project = build_calendar_to_project_map(&self.pool).await?;
        let mut token_cache: HashMap<String, String> = HashMap::new();
        for w in due {
            self.process(&provider, &calendar_to_project, &mut token_cache, w)
                .await;
        }
        Ok(())
    }

    async fn process<P: CalendarProvider>(
        &self,
        provider: &P,
        calendar_to_project: &HashMap<String, String>,
        token_cache: &mut HashMap<String, String>,
        w: PendingWrite,
    ) {
        let pending_id = w.id;
        match self
            .execute(provider, calendar_to_project, token_cache, &w)
            .await
        {
            Ok(()) => {
                if let Err(e) = delete_write(&self.pool, pending_id).await {
                    tracing::warn!(
                        code = "calendar.sync.delete_failed",
                        pending_id,
                        error = %e,
                        "failed to delete completed pending write"
                    );
                }
                if let Err(e) = self.app.emit(
                    "CalendarSyncFlushed",
                    serde_json::json!({ "pendingId": pending_id }),
                ) {
                    tracing::warn!(
                        code = "calendar.sync.emit_failed",
                        pending_id,
                        error = ?e,
                        "failed to emit CalendarSyncFlushed"
                    );
                }
            }
            Err(SyncError::Terminal(msg)) => {
                // Terminal = 재시도 무의미(파싱/인증/검증). retry 예산 소모 없이 즉시 종결:
                // 큐에서 삭제 + CalendarSyncFailed 1회 emit. attempts 카운터를 굴리지 않는다.
                tracing::error!(
                    code = "calendar.sync.terminal",
                    pending_id,
                    "pending calendar write hit terminal error (skip retries)"
                );
                if let Err(e) = delete_write(&self.pool, pending_id).await {
                    tracing::warn!(
                        code = "calendar.sync.delete_failed",
                        pending_id,
                        error = %e,
                        "failed to delete terminally-failed pending write"
                    );
                }
                if let Err(e) = self.app.emit(
                    "CalendarSyncFailed",
                    serde_json::json!({ "pendingId": pending_id, "error": msg }),
                ) {
                    tracing::warn!(
                        code = "calendar.sync.emit_failed",
                        pending_id,
                        error = ?e,
                        "failed to emit CalendarSyncFailed (terminal)"
                    );
                }
            }
            Err(SyncError::Transient(msg)) => {
                if let Err(e) = record_failure(&self.pool, pending_id, &msg).await {
                    tracing::warn!(
                        code = "calendar.sync.record_failure_failed",
                        pending_id,
                        error = %e,
                        "failed to record pending write failure"
                    );
                }
                // attempts는 record_failure 후 w.attempts + 1.
                if is_terminal_attempt(w.attempts + 1) {
                    tracing::error!(
                        code = "calendar.sync.terminal",
                        pending_id,
                        attempts = w.attempts + 1,
                        "pending calendar write hit terminal failure (retry budget exhausted)"
                    );
                    if let Err(e) = self.app.emit(
                        "CalendarSyncFailed",
                        serde_json::json!({ "pendingId": pending_id, "error": msg }),
                    ) {
                        tracing::warn!(
                            code = "calendar.sync.emit_failed",
                            pending_id,
                            error = ?e,
                            "failed to emit CalendarSyncFailed (transient exhausted)"
                        );
                    }
                }
            }
        }
    }

    /// 실제 외부 호출 한 단위. 토큰 본문/외부 응답 본문은 로그/메시지에 노출되지 않는다(스펙 §5.5).
    /// provider/token_cache는 flush_once tick 단위로 공유 — 다중 행이 같은 캘린더/프로젝트면 1회만 refresh.
    /// 제네릭은 cargo test에서 FakeProvider를 꽂기 위한 seam.
    async fn execute<P: CalendarProvider>(
        &self,
        provider: &P,
        calendar_to_project: &HashMap<String, String>,
        token_cache: &mut HashMap<String, String>,
        w: &PendingWrite,
    ) -> SyncResult {
        let access = self
            .access_token_cached(provider, calendar_to_project, token_cache, &w.calendar_id)
            .await?;
        execute_with_access(&self.pool, provider, &access, w).await
    }
}

// ── execute / link_back / unlink: 자유 함수로 분리(테스트에서 SyncEngine 없이 호출 가능) ───────

/// `execute`의 코어. access token이 이미 해소된 상태에서 호출 — cargo test에서 SyncEngine + AppHandle
/// 없이 직접 호출해 end-to-end 동작을 검증한다.
async fn execute_with_access<P: CalendarProvider>(
    pool: &SqlitePool,
    provider: &P,
    access: &str,
    w: &PendingWrite,
) -> SyncResult {
    match w.kind.as_str() {
        "create" => {
            let input = parse_create_input(&w.payload_json)?;
            let (event_id, _url) = provider
                .create_event(access, &w.calendar_id, &input)
                .await?;
            link_back_impl(pool, w, &event_id)
                .await
                .map_err(|e| SyncError::Terminal(format!("link_back: {e}")))?;
            Ok(())
        }
        "patch" => {
            let event_id = w
                .event_id
                .as_deref()
                .ok_or_else(|| SyncError::Terminal("patch without event_id".into()))?;
            let patch = build_patch_body(&w.payload_json)?;
            provider
                .patch_event(access, &w.calendar_id, event_id, &patch)
                .await?;
            Ok(())
        }
        "delete" => {
            let event_id = w
                .event_id
                .as_deref()
                .ok_or_else(|| SyncError::Terminal("delete without event_id".into()))?;
            provider
                .delete_event(access, &w.calendar_id, event_id)
                .await?;
            unlink_impl(pool, w)
                .await
                .map_err(|e| SyncError::Terminal(format!("unlink: {e}")))?;
            Ok(())
        }
        other => Err(SyncError::Terminal(format!("unknown kind {other}"))),
    }
}

async fn link_back_impl(pool: &SqlitePool, w: &PendingWrite, event_id: &str) -> sqlx::Result<()> {
    match w.target_kind.as_str() {
        "signal" => {
            sqlx::query(
                "UPDATE signals SET linked_event_id = ?1, linked_calendar_id = ?2 WHERE id = ?3",
            )
            .bind(event_id)
            .bind(&w.calendar_id)
            .bind(&w.target_id)
            .execute(pool)
            .await?;
        }
        "routine_check" => {
            if let Some((routine_id, date)) = split_routine_key(&w.target_id) {
                sqlx::query(
                    "UPDATE routine_checks
                     SET linked_event_id = ?1, linked_calendar_id = ?2
                     WHERE routine_id = ?3 AND date = ?4",
                )
                .bind(event_id)
                .bind(&w.calendar_id)
                .bind(routine_id)
                .bind(date)
                .execute(pool)
                .await?;
            }
        }
        _ => {}
    }
    Ok(())
}

async fn unlink_impl(pool: &SqlitePool, w: &PendingWrite) -> sqlx::Result<()> {
    match w.target_kind.as_str() {
        "signal" => {
            sqlx::query(
                "UPDATE signals
                 SET linked_event_id = NULL, linked_calendar_id = NULL,
                     scheduled_at = NULL, scheduled_duration = NULL
                 WHERE id = ?1",
            )
            .bind(&w.target_id)
            .execute(pool)
            .await?;
        }
        "routine_check" => {
            if let Some((routine_id, date)) = split_routine_key(&w.target_id) {
                sqlx::query(
                    "UPDATE routine_checks
                     SET linked_event_id = NULL, linked_calendar_id = NULL,
                         time_override = NULL
                     WHERE routine_id = ?1 AND date = ?2",
                )
                .bind(routine_id)
                .bind(date)
                .execute(pool)
                .await?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// `routine_id|date` → `(routine_id, date)`. 형식 어긋나면 None(워커가 mirror 무변경).
fn split_routine_key(key: &str) -> Option<(&str, &str)> {
    let (id, date) = key.split_once('|')?;
    if id.is_empty() || date.is_empty() {
        return None;
    }
    Some((id, date))
}

// ── payload → CreateEventInput / patch body 빌더 ──────────────────────────────

/// pending_calendar_writes.payload_json(create)의 최소 형태.
/// `{"title": String, "start": RFC3339, "duration_min": i32, "all_day"?: bool, "description"?: String}`.
fn parse_create_input(payload: &str) -> Result<CreateEventInput, SyncError> {
    let v: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| SyncError::Terminal(format!("create payload parse: {e}")))?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .ok_or_else(|| SyncError::Terminal("create payload missing title".into()))?
        .to_string();
    let start = v
        .get("start")
        .and_then(|x| x.as_str())
        .ok_or_else(|| SyncError::Terminal("create payload missing start".into()))?
        .to_string();
    let duration_min = v
        .get("duration_min")
        .and_then(|x| x.as_i64())
        .ok_or_else(|| SyncError::Terminal("create payload missing duration_min".into()))?;
    let all_day = v.get("all_day").and_then(|x| x.as_bool()).unwrap_or(false);
    let end = compute_end(&start, duration_min, all_day)?;
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    Ok(CreateEventInput {
        title,
        start,
        end,
        all_day,
        description,
    })
}

/// patch payload(`{start?, duration_min?, title?}`) → Google `events.patch` body.
/// timed 이벤트 가정(all-day patch는 PR 2 범위 외 — schedule 시점에 결정된다).
fn build_patch_body(payload: &str) -> Result<serde_json::Value, SyncError> {
    let v: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| SyncError::Terminal(format!("patch payload parse: {e}")))?;
    let mut body = serde_json::Map::new();
    if let Some(title) = v.get("title").and_then(|x| x.as_str()) {
        body.insert("summary".into(), serde_json::Value::String(title.into()));
    }
    if let Some(start) = v.get("start").and_then(|x| x.as_str()) {
        // patch도 start와 함께 end가 같이 가야 Google이 받아준다(부분 PATCH지만 start만 보내면
        // 기존 end가 그대로라 거리 변경이 안 반영됨). duration_min이 같이 와야 한다.
        let duration_min = v
            .get("duration_min")
            .and_then(|x| x.as_i64())
            .ok_or_else(|| SyncError::Terminal("patch with start requires duration_min".into()))?;
        let end = compute_end(start, duration_min, false)?;
        body.insert("start".into(), serde_json::json!({ "dateTime": start }));
        body.insert("end".into(), serde_json::json!({ "dateTime": end }));
    } else if let Some(duration_min) = v.get("duration_min").and_then(|x| x.as_i64()) {
        // start 없이 duration만 — resize 케이스. start는 변경 안 함, end만 계산해 새로 보낸다.
        // 실제 end 계산엔 Google에서 받아 온 start가 필요한데, 그건 payload에 없다.
        // 단순화: resize-only는 PR 2에서 미지원 — IPC가 reschedule(start+duration) 페이로드로 묶어 보낸다.
        let _ = duration_min;
        return Err(SyncError::Terminal(
            "resize-only patch not supported (use reschedule with start+duration)".into(),
        ));
    }
    Ok(serde_json::Value::Object(body))
}

/// start(RFC3339 timed) + duration_min → end(RFC3339). all_day=true는 start YYYY-MM-DD → end +1 day.
fn compute_end(start: &str, duration_min: i64, all_day: bool) -> Result<String, SyncError> {
    if all_day {
        let date = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|e| SyncError::Terminal(format!("all-day start parse: {e}")))?;
        let end = date
            .succ_opt()
            .ok_or_else(|| SyncError::Terminal("all-day end overflow".into()))?;
        return Ok(end.format("%Y-%m-%d").to_string());
    }
    let dt = chrono::DateTime::parse_from_rfc3339(start)
        .map_err(|e| SyncError::Terminal(format!("start parse: {e}")))?;
    let end = dt + chrono::Duration::minutes(duration_min);
    Ok(end.to_rfc3339())
}

// ── access token resolution: calendar_id → project_id → access (cached per tick) ────

impl SyncEngine {
    /// tick 단위 캐시 access token. project_id 단위로 cache → 같은 프로젝트의 다중 캘린더/행이
    /// keychain · refresh_core를 1회만 거친다. 회전된 refresh_token은 즉시 keychain에 저장.
    /// 토큰 본문은 캐시 안에만 — 메시지/로그 미노출(스펙 §5.5).
    async fn access_token_cached<P: CalendarProvider>(
        &self,
        provider: &P,
        calendar_to_project: &HashMap<String, String>,
        token_cache: &mut HashMap<String, String>,
        calendar_id: &str,
    ) -> SyncResult<String> {
        let project_id = calendar_to_project.get(calendar_id).ok_or_else(|| {
            SyncError::Terminal(format!("calendar {calendar_id} not bound to any project"))
        })?;
        if let Some(t) = token_cache.get(project_id) {
            return Ok(t.clone());
        }
        let access = resolve_access_token(&self.pool, provider, project_id).await?;
        token_cache.insert(project_id.clone(), access.clone());
        Ok(access)
    }
}

/// flush_once tick 시작 시 1회 스캔: 모든 프로젝트의 google_calendar_ids JSON을 파싱해
/// calendar_id → project_id 매핑 빌드. 프로젝트 수는 작아(개인용 도구) 풀스캔 OK.
async fn build_calendar_to_project_map(pool: &SqlitePool) -> sqlx::Result<HashMap<String, String>> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, google_calendar_ids FROM projects")
            .fetch_all(pool)
            .await?;
    let mut map = HashMap::new();
    for (project_id, ids_json) in rows {
        let Some(ids_json) = ids_json.filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let parsed: serde_json::Value = match serde_json::from_str(&ids_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(arr) = parsed.as_array() else {
            continue;
        };
        for item in arr {
            if let Some(cid) = item.get("id").and_then(|v| v.as_str()) {
                map.entry(cid.to_string())
                    .or_insert_with(|| project_id.clone());
            }
        }
    }
    Ok(map)
}

/// project_id → access token(refresh_core 경유). 회전된 refresh_token은 keychain에 보존 저장.
/// 토큰 본문은 메시지/로그에 노출되지 않는다(스펙 §5.5).
async fn resolve_access_token<P: CalendarProvider>(
    pool: &SqlitePool,
    provider: &P,
    project_id: &str,
) -> SyncResult<String> {
    let cref = project_credential_ref(pool, project_id)
        .await
        .map_err(|e| SyncError::Terminal(format!("credential_ref: {e}")))?;
    let Some(blob) = keychain::get_token(&cref, TokenKind::GoogleCalendar)
        .map_err(|e| SyncError::Terminal(format!("keychain get: {e}")))?
    else {
        return Err(SyncError::Terminal("no calendar creds blob".into()));
    };
    let creds = CalendarCreds::from_blob(&blob)
        .map_err(|e| SyncError::Terminal(format!("creds parse: {e}")))?;
    if !creds.has_refresh() {
        return Err(SyncError::Terminal(
            "calendar not connected (no refresh_token)".into(),
        ));
    }
    let before = creds.refresh_token.clone();
    let (access, updated) = refresh_core(provider, creds).await?;
    if updated.refresh_token != before {
        keychain::set_token(&cref, TokenKind::GoogleCalendar, &updated.to_blob())
            .map_err(|e| SyncError::Terminal(format!("keychain set: {e}")))?;
    }
    Ok(access)
}

// ── sync 내부 에러(워커 전용, AppError 아님 — 큐의 last_error 문자열에만 박힌다) ────────

type SyncResult<T = ()> = Result<T, SyncError>;

#[derive(Debug, thiserror::Error)]
enum SyncError {
    #[error("{0}")]
    Terminal(String),
    #[error("{0}")]
    Transient(String),
}

impl From<crate::calendar::CalendarError> for SyncError {
    fn from(e: crate::calendar::CalendarError) -> Self {
        use crate::calendar::CalendarError as E;
        match e {
            E::Transient(m) => SyncError::Transient(m),
            E::Terminal(m) | E::ReconnectRequired(m) => SyncError::Terminal(m),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_routine_key_cases() {
        assert_eq!(
            split_routine_key("r1|2026-05-28"),
            Some(("r1", "2026-05-28"))
        );
        assert_eq!(split_routine_key("r1|"), None);
        assert_eq!(split_routine_key("|d"), None);
        assert_eq!(split_routine_key("nopipe"), None);
    }

    #[test]
    fn compute_end_timed_adds_minutes() {
        let end = compute_end("2026-05-28T10:00:00+09:00", 30, false).unwrap();
        // RFC3339 비교는 시점 동치 확인.
        let parsed = chrono::DateTime::parse_from_rfc3339(&end).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339("2026-05-28T10:30:00+09:00").unwrap();
        assert_eq!(parsed, start);
    }

    #[test]
    fn compute_end_all_day_succ_date() {
        let end = compute_end("2026-05-28", 0, true).unwrap();
        assert_eq!(end, "2026-05-29");
    }

    #[test]
    fn parse_create_input_minimal() {
        let payload = r#"{"title":"Demo","start":"2026-05-28T10:00:00+09:00","duration_min":45}"#;
        let input = parse_create_input(payload).unwrap();
        assert_eq!(input.title, "Demo");
        assert_eq!(input.start, "2026-05-28T10:00:00+09:00");
        assert!(!input.all_day);
        assert!(input.description.is_none());
    }

    #[test]
    fn build_patch_body_start_requires_duration() {
        let payload = r#"{"start":"2026-05-28T10:00:00+09:00"}"#;
        assert!(build_patch_body(payload).is_err());
    }

    #[test]
    fn build_patch_body_with_start_and_duration_sets_end() {
        let payload = r#"{"start":"2026-05-28T10:00:00+09:00","duration_min":30}"#;
        let body = build_patch_body(payload).unwrap();
        assert!(body.get("start").is_some());
        assert!(body.get("end").is_some());
    }

    // ── 통합: execute_with_access(create) end-to-end ─────────────────────────────
    //
    // SyncEngine 본체는 tauri AppHandle을 필요로 해 cargo test에서 직접 끼우기 어렵다.
    // 대신 워커 본체 한 사이클이 호출하는 자유 함수 `execute_with_access` + free
    // `delete_write`를 직접 호출해 end-to-end 상태 변화(provider 호출 + signals mirror +
    // pending row 제거)를 검증한다. emit 검증은 AppHandle mock이 무거워 의도적으로 생략 —
    // emit은 process() 분기에서 별도 호출이고, 큐/DB 상태가 본 통합의 진실원이다.
    use std::sync::Mutex;

    use crate::calendar::pending_store::{delete_write, format_sqlite_datetime, upsert_write};
    use crate::calendar::{
        CalendarCreds, CalendarError, CalendarProvider, CreateEventInput, RawCalendar, RawEvent,
        TokenResponse,
    };
    use chrono::Utc;
    use sqlx::sqlite::SqlitePoolOptions;

    /// create_event 호출을 기록하는 미니 fake. patch/delete/list/exchange/refresh/fetch는 미사용.
    #[derive(Default)]
    struct RecordingProvider {
        created: Mutex<Vec<(String, String)>>, // (calendar_id, title)
        new_event_id: String,
    }

    impl CalendarProvider for RecordingProvider {
        async fn exchange_code(
            &self,
            _c: &CalendarCreds,
            _code: &str,
            _v: &str,
            _r: &str,
        ) -> Result<TokenResponse, CalendarError> {
            unimplemented!()
        }
        async fn refresh_access(&self, _c: &CalendarCreds) -> Result<TokenResponse, CalendarError> {
            unimplemented!()
        }
        async fn list_calendars(&self, _at: &str) -> Result<Vec<RawCalendar>, CalendarError> {
            Ok(vec![])
        }
        async fn fetch_events(
            &self,
            _at: &str,
            _cal: &str,
            _min: &str,
            _max: &str,
        ) -> Result<Vec<RawEvent>, CalendarError> {
            Ok(vec![])
        }
        async fn create_event(
            &self,
            _at: &str,
            calendar_id: &str,
            input: &CreateEventInput,
        ) -> Result<(String, Option<String>), CalendarError> {
            self.created
                .lock()
                .unwrap()
                .push((calendar_id.to_string(), input.title.clone()));
            Ok((self.new_event_id.clone(), None))
        }
        async fn patch_event(
            &self,
            _at: &str,
            _cal: &str,
            _ev: &str,
            _p: &serde_json::Value,
        ) -> Result<(), CalendarError> {
            Ok(())
        }
        async fn delete_event(
            &self,
            _at: &str,
            _cal: &str,
            _ev: &str,
        ) -> Result<(), CalendarError> {
            Ok(())
        }
    }

    async fn fresh_pool() -> sqlx::SqlitePool {
        let p = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        p
    }

    /// 한 due pending_calendar_write(kind=create, target=signal)에 대해
    /// execute_with_access → delete_write 한 사이클을 돌렸을 때:
    ///   1) provider.create_event가 calendar_id + title로 호출됐고,
    ///   2) signals.linked_event_id / linked_calendar_id가 mirror에 박혔고,
    ///   3) pending row가 큐에서 사라졌는지.
    #[tokio::test]
    async fn flush_once_create_end_to_end() {
        let pool = fresh_pool().await;
        // seed signal
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) VALUES ('s1','Demo','braindump','thought')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // seed pending write (due now). debounce_ms=0이라 fetch_due_writes가 즉시 본다.
        let pid = upsert_write(
            &pool,
            "create",
            "signal",
            "s1",
            "calA",
            None,
            r#"{"title":"Demo","start":"2026-05-28T10:00:00+09:00","duration_min":30}"#,
            0,
        )
        .await
        .unwrap();
        // sanity: due fetcher가 1건을 잡는다.
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        assert_eq!(due.len(), 1);
        let row = &due[0];

        let provider = RecordingProvider {
            new_event_id: "evt_xyz".into(),
            ..Default::default()
        };
        let result = execute_with_access(&pool, &provider, "fake_access", row).await;
        assert!(
            result.is_ok(),
            "execute_with_access should succeed: {result:?}"
        );
        // 워커 process() 성공 분기 모방: 큐에서 삭제.
        delete_write(&pool, pid).await.unwrap();

        // 1) provider.create_event 호출 확인.
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created, vec![("calA".to_string(), "Demo".to_string())]);

        // 2) signal mirror 박힘.
        let (le, lc): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT linked_event_id, linked_calendar_id FROM signals WHERE id = 's1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(le.as_deref(), Some("evt_xyz"));
        assert_eq!(lc.as_deref(), Some("calA"));

        // 3) pending row 삭제 확인.
        let remaining: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes WHERE id = ?")
                .bind(pid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remaining.0, 0);
        // format_sqlite_datetime / Utc는 lifetime 워밍업으로만 참조 — 추후 patch/delete e2e 추가 시 재사용.
        let _ = format_sqlite_datetime(Utc::now());
    }
}
