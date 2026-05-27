//! SyncEngine — pending_calendar_writes 워커 (Today×Timeline PR 2).
//!
//! tokio interval(200ms) + Notify 즉시 깨우기로 큐를 굴린다. 800ms 디바운스는
//! `next_attempt_at = now + debounce_ms` (pending_store.upsert_write) + `fetch_due_writes`
//! 가 처리.
//!
//! INVARIANT #5: bounded retry — 실패는 backoff [1s, 3s, 9s] 3회 후 `last_error` 보존
//! + emit `CalendarSyncFailed`(spec §6.4). 성공은 큐에서 제거 + emit `CalendarSyncFlushed`.
//! INVARIANT #2: cross-cal 변경은 payload `staged=true` → `fetch_due_writes`가 skip
//! (commit_staged_writes IPC가 staged 플래그를 제거할 때만 워커가 가져간다).

use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{interval, Duration};

use crate::calendar::pending_store::{
    delete_write, fetch_due_writes, is_terminal_attempt, record_failure,
};
use crate::calendar::{
    refresh_core, CalendarCreds, CalendarProvider, CreateEventInput, HttpCalendarProvider,
};
use crate::commands::tokens::project_credential_ref;
use crate::keychain;
use crate::models::{PendingWrite, TokenKind};

/// 200ms 폴링 tick — Notify로 즉시 깨워질 때까지의 floor.
const TICK_MS: u64 = 200;

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
    pub fn spawn(self) {
        tokio::spawn(async move { self.run().await });
    }

    async fn run(self) {
        let mut tick = interval(Duration::from_millis(TICK_MS));
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
        for w in due {
            self.process(w).await;
        }
        Ok(())
    }

    async fn process(&self, w: PendingWrite) {
        let pending_id = w.id;
        match self.execute(&w).await {
            Ok(()) => {
                if let Err(e) = delete_write(&self.pool, pending_id).await {
                    tracing::warn!(
                        code = "calendar.sync.delete_failed",
                        pending_id,
                        error = %e,
                        "failed to delete completed pending write"
                    );
                }
                let _ = self.app.emit(
                    "CalendarSyncFlushed",
                    serde_json::json!({ "pendingId": pending_id }),
                );
            }
            Err(err) => {
                let msg = err.to_string();
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
                        "pending calendar write hit terminal failure"
                    );
                    let _ = self.app.emit(
                        "CalendarSyncFailed",
                        serde_json::json!({ "pendingId": pending_id, "error": msg }),
                    );
                }
            }
        }
    }

    /// 실제 외부 호출 한 단위. 토큰 본문/외부 응답 본문은 로그/메시지에 노출되지 않는다(스펙 §5.5).
    async fn execute(&self, w: &PendingWrite) -> SyncResult {
        let access = access_token_for_calendar(&self.pool, &w.calendar_id)
            .await?
            .ok_or_else(|| SyncError::Terminal("calendar not connected".into()))?;
        let provider = HttpCalendarProvider::new()
            .map_err(|e| SyncError::Terminal(format!("provider init: {e}")))?;
        match w.kind.as_str() {
            "create" => {
                let input = parse_create_input(&w.payload_json)?;
                let (event_id, _url) = provider
                    .create_event(&access, &w.calendar_id, &input)
                    .await?;
                self.link_back(w, &event_id)
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
                    .patch_event(&access, &w.calendar_id, event_id, &patch)
                    .await?;
                Ok(())
            }
            "delete" => {
                let event_id = w
                    .event_id
                    .as_deref()
                    .ok_or_else(|| SyncError::Terminal("delete without event_id".into()))?;
                provider
                    .delete_event(&access, &w.calendar_id, event_id)
                    .await?;
                self.unlink(w)
                    .await
                    .map_err(|e| SyncError::Terminal(format!("unlink: {e}")))?;
                Ok(())
            }
            other => Err(SyncError::Terminal(format!("unknown kind {other}"))),
        }
    }

    /// create 성공 후 카드/루틴 mirror에 (event_id, calendar_id) 박기.
    async fn link_back(&self, w: &PendingWrite, event_id: &str) -> sqlx::Result<()> {
        match w.target_kind.as_str() {
            "signal" => {
                sqlx::query(
                    "UPDATE signals SET linked_event_id = ?1, linked_calendar_id = ?2 WHERE id = ?3",
                )
                .bind(event_id)
                .bind(&w.calendar_id)
                .bind(&w.target_id)
                .execute(&self.pool)
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
                    .execute(&self.pool)
                    .await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// delete 성공 후 카드/루틴 mirror 정리(시간/이벤트 핸들 클리어).
    async fn unlink(&self, w: &PendingWrite) -> sqlx::Result<()> {
        match w.target_kind.as_str() {
            "signal" => {
                sqlx::query(
                    "UPDATE signals
                     SET linked_event_id = NULL, linked_calendar_id = NULL,
                         scheduled_at = NULL, scheduled_duration = NULL
                     WHERE id = ?1",
                )
                .bind(&w.target_id)
                .execute(&self.pool)
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
                    .execute(&self.pool)
                    .await?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// `routine_id|date` → `(routine_id, date)`. 형식 어긋나면 None(워커가 mirror 무변경).
fn split_routine_key(key: &str) -> Option<(&str, &str)> {
    let mut it = key.splitn(2, '|');
    let id = it.next()?;
    let date = it.next()?;
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

// ── access token resolution: calendar_id → project_id → access ────────────────

/// 큐 행의 calendar_id로 어느 프로젝트에 속한 캘린더인지 찾고, 그 프로젝트의 access token을 재발급한다.
/// `projects.google_calendar_ids`는 `[{"id":"...","summary":"..."}]` JSON 배열 — id 일치하는 프로젝트의
/// credential_ref + keychain blob → refresh_core. 회전된 refresh_token은 보존 저장. 토큰 본문 미반환.
async fn access_token_for_calendar(
    pool: &SqlitePool,
    calendar_id: &str,
) -> SyncResult<Option<String>> {
    // 모든 프로젝트의 (id, google_calendar_ids) 쌍을 가져와 JSON을 파싱해 매칭.
    // 프로젝트 수는 작아(개인용 도구) 풀스캔 OK. 최적화는 필요해지면 그때.
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, google_calendar_ids FROM projects")
            .fetch_all(pool)
            .await
            .map_err(|e| SyncError::Terminal(format!("projects fetch: {e}")))?;
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
        let matched = arr
            .iter()
            .any(|item| item.get("id").and_then(|v| v.as_str()) == Some(calendar_id));
        if !matched {
            continue;
        }
        return resolve_access_token(pool, &project_id).await.map(Some);
    }
    Ok(None)
}

/// project_id → access token(refresh_core 경유). 회전된 refresh_token은 keychain에 보존 저장.
/// 토큰 본문은 메시지/로그에 노출되지 않는다(스펙 §5.5).
async fn resolve_access_token(pool: &SqlitePool, project_id: &str) -> SyncResult<String> {
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
    let provider = HttpCalendarProvider::new()
        .map_err(|e| SyncError::Terminal(format!("provider init: {e}")))?;
    let before = creds.refresh_token.clone();
    let (access, updated) = refresh_core(&provider, creds).await?;
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
}
