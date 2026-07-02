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

use chrono::TimeZone;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{interval, Duration, MissedTickBehavior};

use crate::calendar::pending_store::{
    delete_write, fetch_due_writes, is_terminal_attempt, mark_created_event_id, record_failure,
    record_terminal_failure,
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
                // 외부 write가 반영됐으니 표시 TTL 캐시를 비운다 — 다음 fetch가 PATCH 전
                // 스냅샷(최대 60s stale)을 돌려줘 optimistic 위치를 되돌리는 것 방지.
                crate::commands::calendar::invalidate_calendar_events_cache().await;
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
                // Terminal = 자동 재시도 무의미(파싱/인증/검증). row는 attempts=3으로 보존해
                // 사용자가 원인을 고친 뒤 명시 retry/cancel 할 수 있게 한다.
                tracing::error!(
                    code = "calendar.sync.terminal",
                    pending_id,
                    "pending calendar write hit terminal error (skip retries)"
                );
                if let Err(e) = record_terminal_failure(&self.pool, pending_id, &msg).await {
                    tracing::warn!(
                        code = "calendar.sync.record_terminal_failed",
                        pending_id,
                        error = %e,
                        "failed to record terminally-failed pending write"
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
            if let Some(event_id) = w.event_id.as_deref() {
                link_back_impl(pool, w, event_id)
                    .await
                    .map_err(|e| SyncError::Terminal(format!("link_back: {e}")))?;
                return Ok(());
            }
            // 새 mirror 생성 전, 이 카드/루틴의 기존 링크(옛 mirror)를 읽어둔다 — 생성·링크백 후
            // 옛 이벤트를 삭제해 오펀을 막는다('create가 기존 링크를 대체'하는 일반 케이스 방어:
            // MoveCalendar(다른 캘린더 이동) 등). Schedule-when-linked는 build_queue_row에서 이미
            // patch로 가지만, 여기 워커 단의 방어가 cross-cal 및 잔여 경로까지 커버한다(defense-in-depth).
            let prev_link = fetch_target_link(pool, w)
                .await
                .map_err(|e| SyncError::Terminal(format!("fetch prev link: {e}")))?;
            let input = parse_create_input(&w.payload_json)?;
            let (event_id, _url) = provider
                .create_event(access, &w.calendar_id, &input)
                .await?;
            mark_created_event_id(pool, w.id, &event_id)
                .await
                .map_err(|e| SyncError::Terminal(format!("mark_created_event_id: {e}")))?;
            if w.target_kind == "routine_master" {
                // 원자적 조건부 relink(active-flush TOCTOU 차단): enable이 이 create가 flush되는 사이
                // disable로 취소되지 않았을 때만(google_calendar_id가 여전히 NOT NULL) relink한다.
                // disable의 clear_google_mirror가 google_calendar_id를 NULL로 만들면 — 이 UPDATE 직전
                // 커밋돼도 — rows_affected=0이 되어 relink 없이 방금 만든 orphan 마스터를 지운다.
                // 다른 non-NULL 캘린더(move/replace)는 매칭되어 정상 relink. link_back_impl의 무조건
                // UPDATE를 routine_master에 한해 CAS로 대체(critic P4a round-3). best-effort orphan delete.
                let res = sqlx::query(
                    "UPDATE routines SET google_event_id = ?1, google_calendar_id = ?2 \
                     WHERE id = ?3 AND google_calendar_id IS NOT NULL",
                )
                .bind(&event_id)
                .bind(&w.calendar_id)
                .bind(&w.target_id)
                .execute(pool)
                .await
                .map_err(|e| SyncError::Terminal(format!("routine relink CAS: {e}")))?;
                if res.rows_affected() == 0 {
                    let _ = provider
                        .delete_event(access, &w.calendar_id, &event_id)
                        .await;
                    return Ok(());
                }
            } else {
                link_back_impl(pool, w, &event_id)
                    .await
                    .map_err(|e| SyncError::Terminal(format!("link_back: {e}")))?;
            }
            // 옛 mirror가 새 이벤트와 다르면 삭제(오펀 방지). best-effort — 새 이벤트·링크는 이미
            // 정합이라 삭제 실패(이미 없음 포함)해도 write는 성공으로 본다. 재시도 경로
            // (w.event_id Some)는 옛 id를 잃으므로 첫 실행에서만 시도 — 잔여는 reconciliation 후속.
            if let Some((old_cal, old_evt)) = prev_link {
                if old_evt != event_id {
                    let _ = provider.delete_event(access, &old_cal, &old_evt).await;
                }
            }
            Ok(())
        }
        "patch" => {
            let event_id = w
                .event_id
                .as_deref()
                .ok_or_else(|| SyncError::Terminal("patch without event_id".into()))?;
            let patch = build_patch_body(&w.payload_json)?;
            match provider
                .patch_event(access, &w.calendar_id, event_id, &patch)
                .await
            {
                Ok(()) => Ok(()),
                // P4b A3: routine_master master가 외부에서 삭제됨(404/410) → 조건부 unlink(미러가 여전히
                // 이 event를 가리킬 때만) + Terminal("sync expired"). 인라인 clear_google_mirror-on-NotFound
                // (ADR-0005 reactive sweep) 패리티 — NULL out 없이 두면 이후 편집/exdate가 영구 실패.
                // 알려진 무해 노이즈: disable의 delete가 이 patch보다 먼저 flush되면 patch가 NotFound를
                // 맞고(미러는 이미 NULL → unlink 0행) CalendarSyncFailed가 뜬다 — 이미 꺼진 루틴에 대한
                // terminal 행 1개일 뿐, 재활성/orphan/데이터 손상 없음(P4b critic NIT#2).
                Err(crate::calendar::CalendarError::NotFound(_))
                    if w.target_kind == "routine_master" =>
                {
                    sqlx::query(
                        "UPDATE routines SET google_event_id = NULL, google_calendar_id = NULL \
                         WHERE id = ?1 AND google_event_id = ?2",
                    )
                    .bind(&w.target_id)
                    .bind(event_id)
                    .execute(pool)
                    .await
                    .map_err(|e| SyncError::Terminal(format!("routine master unlink: {e}")))?;
                    Err(SyncError::Terminal(
                        "routine master gone (sync expired)".into(),
                    ))
                }
                // 그 외 target/에러는 기존 generic `?` 매핑 그대로(byte-identical).
                Err(e) => Err(e.into()),
            }
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
        // 반복 시리즈 SPLIT을 한 execute 안에서 원자적으로: 옛 마스터 UNTIL cap(patch) + 새 마스터
        // create. google_sync.rs::split_routine_sync_after_edit_with_provider의 의미를 큐로 이동
        // (실행·재시도·일관성은 큐 소유). 순서 경쟁·부분실패 재시도 안전.
        "series_replace" => {
            let v: serde_json::Value = serde_json::from_str(&w.payload_json)
                .map_err(|e| SyncError::Terminal(format!("series_replace payload parse: {e}")))?;
            let old_event_id = v
                .get("old_event_id")
                .and_then(|x| x.as_str())
                .ok_or_else(|| SyncError::Terminal("series_replace missing old_event_id".into()))?;
            let old_patch = v
                .get("old_patch")
                .filter(|x| x.is_object())
                .ok_or_else(|| {
                    SyncError::Terminal("series_replace missing old_patch object".into())
                })?;
            let new_create = v
                .get("new_create")
                .filter(|x| x.is_object())
                .ok_or_else(|| {
                    SyncError::Terminal("series_replace missing new_create object".into())
                })?;

            // 0) 멱등/취소 가드(P4b A1): routine mirror를 읽어 3-way 분기.
            //  · None(미러 NULL) = enqueue 이후 disable/삭제가 개입해 미러를 clear함 → **취소**.
            //    앞선 시도가 새 마스터를 이미 만들었으면(w.event_id Some) 그 orphan을 best-effort 삭제하고
            //    patch/create 둘 다 skip한다(취소된 split이 새 마스터를 남기지 않게).
            //  · Some(current ≠ old) = 앞선 시도가 이미 relink까지 commit함(mark 실패로 pending.event_id가
            //    NULL로 남아 수동 retry된 상황) → no-op(두 번째 마스터 방지, link_back이 commit point).
            //  · Some(current == old) = 진행.
            match fetch_target_link(pool, w)
                .await
                .map_err(|e| SyncError::Terminal(format!("fetch routine link: {e}")))?
            {
                None => {
                    if let Some(orphan) = w.event_id.as_deref() {
                        let _ = provider.delete_event(access, &w.calendar_id, orphan).await;
                    }
                    return Ok(());
                }
                Some((_cal, current_evt)) => {
                    if current_evt != old_event_id {
                        return Ok(());
                    }
                }
            }

            // 1) 옛 마스터를 UNTIL로 cap(patch, verbatim body). 옛 마스터는 KEEP(과거 인스턴스
            // 보관 tombstone) — 삭제하지 않는다. NotFound(외부에서 사라짐) → mirror NULL + terminal
            // (인라인 clear_google_mirror-on-NotFound 보존).
            match provider
                .patch_event(access, &w.calendar_id, old_event_id, old_patch)
                .await
            {
                Ok(()) => {}
                Err(crate::calendar::CalendarError::NotFound(_)) => {
                    // 옛 마스터가 외부에서 사라짐 → 미러 clear + terminal. 조건부(google_event_id =
                    // old_event_id)라 flush 사이 더 새 link가 생겼다면 null하지 않는다(unlink_impl과
                    // 동일한 late-flush 안전). 가드에서 current_evt == old_event_id를 이미 확인함.
                    sqlx::query(
                        "UPDATE routines SET google_event_id = NULL, google_calendar_id = NULL \
                         WHERE id = ?1 AND google_event_id = ?2",
                    )
                    .bind(&w.target_id)
                    .bind(old_event_id)
                    .execute(pool)
                    .await
                    .map_err(|e| SyncError::Terminal(format!("series unlink: {e}")))?;
                    return Err(SyncError::Terminal(
                        "series old master gone (sync expired)".into(),
                    ));
                }
                Err(e) => return Err(e.into()),
            }

            // 2) 새 마스터 create(멱등: 앞선 시도가 이미 만들었으면 w.event_id 재사용, create skip).
            let (new_id, freshly_created) = if let Some(existing) = w.event_id.as_deref() {
                (existing.to_string(), false)
            } else {
                let input =
                    parse_create_input(&serde_json::to_string(new_create).map_err(|e| {
                        SyncError::Terminal(format!("series_replace new_create serialize: {e}"))
                    })?)?;
                let (id, _url) = provider
                    .create_event(access, &w.calendar_id, &input)
                    .await?;
                (id, true)
            };

            // 3) routines mirror를 새 마스터로 relink(routine_master arm) — **COMMIT POINT**.
            // create 직후 곧바로 relink해, 이후(mark) 실패로 재시도해도 위 멱등 가드가 new≠old를 보고
            // no-op → create 중복 없음. (잔여 극박막 window = create 성공 직후 이 UPDATE 실패;
            // 완전 제거는 client-assigned event id 멱등 create 필요 — follow-up, 기존 create arm도 공유.)
            // P4b A2: 무조건 link_back 대신 create arm과 동일한 CAS(google_calendar_id IS NOT NULL) —
            // 가드 통과 후에도 flush 직전 disable이 미러를 clear했으면 relink하지 않고 방금 만든 새
            // 마스터(orphan)를 best-effort 삭제한다. rows>0일 때만 mark(freshly_created)로 진행.
            let relink = sqlx::query(
                "UPDATE routines SET google_event_id = ?1, google_calendar_id = ?2 \
                 WHERE id = ?3 AND google_calendar_id IS NOT NULL",
            )
            .bind(&new_id)
            .bind(&w.calendar_id)
            .bind(&w.target_id)
            .execute(pool)
            .await
            .map_err(|e| SyncError::Terminal(format!("series relink CAS: {e}")))?;
            if relink.rows_affected() == 0 {
                let _ = provider.delete_event(access, &w.calendar_id, &new_id).await;
                return Ok(());
            }

            // 4) pending row에 생성 id 기록(재시도 회계) — commit 이후. 실패해도 routine은 이미
            // 새 마스터를 추적하므로 다음 retry는 멱등 가드에서 no-op.
            if freshly_created {
                mark_created_event_id(pool, w.id, &new_id)
                    .await
                    .map_err(|e| SyncError::Terminal(format!("mark_created_event_id: {e}")))?;
            }
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
        "routine_master" => {
            // target_id = routine_id 직접(파이프 없음 — split_routine_key 미사용).
            sqlx::query(
                "UPDATE routines SET google_event_id = ?1, google_calendar_id = ?2 WHERE id = ?3",
            )
            .bind(event_id)
            .bind(&w.calendar_id)
            .bind(&w.target_id)
            .execute(pool)
            .await?;
        }
        _ => {}
    }
    Ok(())
}

/// 워커가 새 mirror 생성 전 카드/루틴의 기존 링크(옛 mirror)를 읽는다 — 생성·링크백 후 옛
/// 이벤트를 지워 오펀을 막기 위함(link_back_impl의 역). 둘 다 있을 때만 Some.
async fn fetch_target_link(
    pool: &SqlitePool,
    w: &PendingWrite,
) -> sqlx::Result<Option<(String, String)>> {
    let row: Option<(Option<String>, Option<String>)> = match w.target_kind.as_str() {
        "signal" => {
            sqlx::query_as("SELECT linked_calendar_id, linked_event_id FROM signals WHERE id = ?1")
                .bind(&w.target_id)
                .fetch_optional(pool)
                .await?
        }
        "routine_check" => {
            let Some((routine_id, date)) = split_routine_key(&w.target_id) else {
                return Ok(None);
            };
            sqlx::query_as(
                "SELECT linked_calendar_id, linked_event_id FROM routine_checks \
                 WHERE routine_id = ?1 AND date = ?2",
            )
            .bind(routine_id)
            .bind(date)
            .fetch_optional(pool)
            .await?
        }
        "routine_master" => {
            // target_id = routine_id 직접. 둘 다 non-NULL일 때만 Some(signal arm 미러).
            sqlx::query_as("SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1")
                .bind(&w.target_id)
                .fetch_optional(pool)
                .await?
        }
        _ => None,
    };
    Ok(row.and_then(|(cal, evt)| match (cal, evt) {
        (Some(c), Some(e)) => Some((c, e)),
        _ => None,
    }))
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
        "routine_master" => {
            // target_id = routine_id 직접. 다른 routine 컬럼은 건드리지 않는다.
            // P4b A4: 삭제된 바로 그 event(w.event_id)가 여전히 미러에 걸려 있을 때만 clear —
            // late-flushing delete row가 더 새 link(P4c move의 create@new_cal)를 null하지 않게.
            // delete arm은 event_id가 항상 Some; None이면 `google_event_id = NULL` 비교가 거짓이라
            // 0행(no match) = 안전. 정상 disable은 이미 낙관적으로 미러를 clear했으므로 0행이 정상.
            sqlx::query(
                "UPDATE routines
                 SET google_event_id = NULL, google_calendar_id = NULL
                 WHERE id = ?1 AND google_event_id = ?2",
            )
            .bind(&w.target_id)
            .bind(w.event_id.as_deref())
            .execute(pool)
            .await?;
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
    let raw_start = v
        .get("start")
        .and_then(|x| x.as_str())
        .ok_or_else(|| SyncError::Terminal("create payload missing start".into()))?
        .to_string();
    let duration_min = v
        .get("duration_min")
        .and_then(|x| x.as_i64())
        .ok_or_else(|| SyncError::Terminal("create payload missing duration_min".into()))?;
    let all_day = v.get("all_day").and_then(|x| x.as_bool()).unwrap_or(false);
    // 반복 마스터: recurrence 라인 + time_zone(IANA). 없으면 종전과 동일(빈 vec / None).
    // malformed(non-string 원소)는 조용히 버리지 않고 Terminal — fail-closed.
    let recurrence: Vec<String> = parse_recurrence_lines(&v)?.unwrap_or_default();
    let time_zone = v
        .get("time_zone")
        .and_then(|x| x.as_str())
        .map(String::from);
    // recurring(time_zone Some, non-all-day)이면 start/end는 offset 미부여 wall-clock 유지 —
    // Google recurring은 dateTime을 timeZone 필드로 해석하므로 normalize_timed_start(로컬 offset 부여)
    // 를 타면 안 된다. legacy(time_zone None)는 종전대로 normalize → byte-identical.
    let recurring = time_zone.is_some() && !all_day;
    let start = if all_day || recurring {
        raw_start
    } else {
        normalize_timed_start(&raw_start)?
    };
    let end = if recurring {
        compute_wall_clock_end(&start, duration_min)?
    } else {
        compute_end(&start, duration_min, all_day)?
    };
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
        recurrence,
        time_zone,
    })
}

/// patch payload(`{start?, duration_min?, title?}`) → Google `events.patch` body.
/// timed 이벤트 가정(all-day patch는 PR 2 범위 외 — schedule 시점에 결정된다).
fn build_patch_body(payload: &str) -> Result<serde_json::Value, SyncError> {
    let v: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| SyncError::Terminal(format!("patch payload parse: {e}")))?;
    // recurring patch(루틴 마스터): time_zone Some이면 start/end는 wall-clock dateTime + timeZone 필드
    // 로 직렬화(offset 미부여, build_event_payload의 recurring 계약 미러). legacy(None)는 종전대로.
    let time_zone = v
        .get("time_zone")
        .and_then(|x| x.as_str())
        .map(String::from);
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
        if let Some(tz) = time_zone.as_deref() {
            // recurring: wall-clock dateTime(정규화 안 함) + timeZone 필드.
            let end = compute_wall_clock_end(start, duration_min)?;
            body.insert(
                "start".into(),
                serde_json::json!({ "dateTime": start, "timeZone": tz }),
            );
            body.insert(
                "end".into(),
                serde_json::json!({ "dateTime": end, "timeZone": tz }),
            );
        } else {
            let start = normalize_timed_start(start)?;
            let end = compute_end(&start, duration_min, false)?;
            body.insert("start".into(), serde_json::json!({ "dateTime": start }));
            body.insert("end".into(), serde_json::json!({ "dateTime": end }));
        }
    } else if let Some(duration_min) = v.get("duration_min").and_then(|x| x.as_i64()) {
        // start 없이 duration만 — resize 케이스. start는 변경 안 함, end만 계산해 새로 보낸다.
        // 실제 end 계산엔 Google에서 받아 온 start가 필요한데, 그건 payload에 없다.
        // 단순화: resize-only는 PR 2에서 미지원 — IPC가 reschedule(start+duration) 페이로드로 묶어 보낸다.
        let _ = duration_min;
        return Err(SyncError::Terminal(
            "resize-only patch not supported (use reschedule with start+duration)".into(),
        ));
    }
    // 반복 마스터: recurrence 배열이 있으면 patch body에 동봉(RRULE/EXDATE 갱신). 없으면 미삽입 →
    // 기존 non-recurring patch는 byte-identical. malformed(non-string 원소)는 Terminal — fail-closed
    // (조용히 [] 로 걸러 recurrence를 의도치 않게 지우는 것 방지).
    if let Some(lines) = parse_recurrence_lines(&v)? {
        let arr = lines.into_iter().map(serde_json::Value::String).collect();
        body.insert("recurrence".into(), serde_json::Value::Array(arr));
    }
    Ok(serde_json::Value::Object(body))
}

/// payload의 `recurrence` 배열 → `Vec<String>`. 키가 없으면 `None`(비반복). 키가 있는데 원소 중
/// 문자열이 아닌 게 있으면 `Terminal` — malformed 입력을 조용히 필터링하지 않고 fail-closed로 거부한다
/// (parse_create_input / build_patch_body 공용).
fn parse_recurrence_lines(v: &serde_json::Value) -> Result<Option<Vec<String>>, SyncError> {
    let Some(arr) = v.get("recurrence").and_then(|x| x.as_array()) else {
        return Ok(None);
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let line = item
            .as_str()
            .ok_or_else(|| SyncError::Terminal("recurrence contains a non-string entry".into()))?;
        out.push(line.to_string());
    }
    Ok(Some(out))
}

/// 반복 이벤트용 wall-clock end 계산. start(`YYYY-MM-DDTHH:MM:SS`, offset 없음) + duration_min →
/// end(`YYYY-MM-DDTHH:MM:SS`, offset 없음). Google recurring은 dateTime을 별도 timeZone 필드로
/// 해석하므로 로컬 offset을 붙이지 않는다(compute_end는 RFC3339 offset을 요구/생성 — recurring 부적합).
fn compute_wall_clock_end(start: &str, duration_min: i64) -> Result<String, SyncError> {
    let naive = chrono::NaiveDateTime::parse_from_str(start.trim(), "%Y-%m-%dT%H:%M:%S")
        .map_err(|e| SyncError::Terminal(format!("recurring start parse: {e}")))?;
    let end = naive + chrono::Duration::minutes(duration_min);
    Ok(end.format("%Y-%m-%dT%H:%M:%S").to_string())
}

pub(crate) fn normalize_timed_start(start: &str) -> Result<String, SyncError> {
    let trimmed = start.trim();
    if trimmed.is_empty() {
        return Err(SyncError::Terminal("start missing/empty".into()));
    }
    if chrono::DateTime::parse_from_rfc3339(trimmed).is_ok() {
        return Ok(trimmed.to_string());
    }
    let naive = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S")
        .map_err(|e| SyncError::Terminal(format!("start parse: {e}")))?;
    let local = chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())
        .ok_or_else(|| SyncError::Terminal("start local time ambiguous".into()))?;
    Ok(local.to_rfc3339())
}

/// start(RFC3339 timed) + duration_min → end(RFC3339). all_day=true는 start YYYY-MM-DD →
/// end = start + max(1, ceil(duration_min/1440)) days (Google all-day end.date는 exclusive —
/// duration이 며칠 분량이면 멀티데이 그대로 미러, 1일 미만/누락은 1일).
pub(crate) fn compute_end(
    start: &str,
    duration_min: i64,
    all_day: bool,
) -> Result<String, SyncError> {
    if all_day {
        let date = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|e| SyncError::Terminal(format!("all-day start parse: {e}")))?;
        let days = ((duration_min.max(0) + 1439) / 1440).max(1);
        let end = date
            .checked_add_signed(chrono::Duration::days(days))
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
pub(crate) enum SyncError {
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
            // NotFound(404/410)은 이 큐 경로에선 재시도 무의미 → Terminal(기존 동작 보존).
            E::Terminal(m) | E::ReconnectRequired(m) | E::NotFound(m) => SyncError::Terminal(m),
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

    /// duration_min이 며칠 분량이면 멀티데이 all-day로 미러(end exclusive). 1440=1일, 4320=3일.
    #[test]
    fn compute_end_all_day_multi_day_from_duration() {
        assert_eq!(compute_end("2026-05-28", 1440, true).unwrap(), "2026-05-29");
        assert_eq!(compute_end("2026-05-28", 4320, true).unwrap(), "2026-05-31");
        // 하루 미만/half-day는 1일로 올림, 1.5일은 2일로 올림.
        assert_eq!(compute_end("2026-05-28", 30, true).unwrap(), "2026-05-29");
        assert_eq!(compute_end("2026-05-28", 2160, true).unwrap(), "2026-05-30");
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
    fn parse_create_input_normalizes_local_iso_start() {
        let payload = r#"{"title":"Demo","start":"2026-05-28T10:00:00","duration_min":45}"#;
        let input = parse_create_input(payload).unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(&input.start).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&input.end).is_ok());
        assert!(input.start.starts_with("2026-05-28T10:00:00"));
    }

    #[test]
    fn parse_create_input_rejects_empty_start() {
        let payload = r#"{"title":"Demo","start":"","duration_min":45}"#;
        let err = parse_create_input(payload).expect_err("empty start should be terminal");
        assert!(format!("{err}").contains("start missing/empty"));
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

    #[test]
    fn build_patch_body_normalizes_local_iso_start() {
        let payload = r#"{"start":"2026-05-28T10:00:00","duration_min":30}"#;
        let body = build_patch_body(payload).unwrap();
        let start = body
            .get("start")
            .and_then(|v| v.get("dateTime"))
            .and_then(|v| v.as_str())
            .expect("patch start");
        let end = body
            .get("end")
            .and_then(|v| v.get("dateTime"))
            .and_then(|v| v.as_str())
            .expect("patch end");
        assert!(chrono::DateTime::parse_from_rfc3339(start).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(end).is_ok());
        assert!(start.starts_with("2026-05-28T10:00:00"));
    }

    // ── P1: recurrence/time_zone 통로 (반복 마스터가 큐로 흐르게) ──────────────────

    /// 반복 create payload: recurrence 배열 + time_zone → CreateEventInput에 그대로 전달.
    /// recurring이면 start/end는 offset 미부여 wall-clock 유지(Google이 timeZone 필드로 해석).
    #[test]
    fn parse_create_input_recurring_keeps_wall_clock_and_recurrence() {
        let payload = r#"{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR","EXDATE;TZID=Asia/Seoul:20260601T070000"]}"#;
        let input = parse_create_input(payload).unwrap();
        assert_eq!(input.time_zone.as_deref(), Some("Asia/Seoul"));
        assert_eq!(
            input.recurrence,
            vec![
                "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR".to_string(),
                "EXDATE;TZID=Asia/Seoul:20260601T070000".to_string(),
            ]
        );
        // recurring start는 offset 미부여 wall-clock 그대로(정규화 안 함).
        assert_eq!(input.start, "2026-05-29T07:00:00");
        assert!(chrono::DateTime::parse_from_rfc3339(&input.start).is_err());
        // end도 wall-clock(offset 없음).
        assert_eq!(input.end, "2026-05-29T07:30:00");
    }

    /// recurring end는 순수 wall-clock 산술 — 자정 넘김도 offset/tz 해석 없이 롤오버(pin NIT#1).
    #[test]
    fn parse_create_input_recurring_end_rolls_over_midnight() {
        let payload = r#"{"title":"야근 루틴","start":"2026-05-29T23:45:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=DAILY"]}"#;
        let input = parse_create_input(payload).unwrap();
        assert_eq!(input.start, "2026-05-29T23:45:00");
        assert_eq!(input.end, "2026-05-30T00:15:00"); // 순수 wall-clock 롤오버(offset 미부여)
    }

    /// malformed recurrence(non-string 원소)는 조용히 필터링하지 않고 Terminal(fail-closed) —
    /// create/patch 양쪽. 조용히 []로 걸러 recurrence를 의도치 않게 지우는 회귀 방지(NIT#3).
    #[test]
    fn recurrence_non_string_entry_is_terminal_both_paths() {
        let create = r#"{"title":"R","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":[null]}"#;
        assert!(parse_create_input(create).is_err());
        let patch = r#"{"start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":[123]}"#;
        assert!(build_patch_body(patch).is_err());
    }

    /// 회귀: recurrence/time_zone 없는 기존 payload는 종전과 동일 — start normalize(로컬 offset 부여),
    /// recurrence 빈 vec, time_zone None.
    #[test]
    fn parse_create_input_non_recurring_preserves_offset_behavior() {
        let payload = r#"{"title":"Demo","start":"2026-05-28T10:00:00","duration_min":45}"#;
        let input = parse_create_input(payload).unwrap();
        assert!(input.recurrence.is_empty());
        assert!(input.time_zone.is_none());
        // normalize_timed_start가 로컬 offset을 부여 → RFC3339 파싱 가능(종전 동작).
        assert!(chrono::DateTime::parse_from_rfc3339(&input.start).is_ok());
        assert_eq!(
            input.start,
            normalize_timed_start("2026-05-28T10:00:00").unwrap()
        );
        assert_eq!(input.end, compute_end(&input.start, 45, false).unwrap());
    }

    /// 반복 patch payload: recurrence 배열 동봉 + start/end.timeZone(wall-clock dateTime).
    #[test]
    fn build_patch_body_recurring_includes_recurrence_and_timezone() {
        let payload = r#"{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO"]}"#;
        let body = build_patch_body(payload).unwrap();
        assert_eq!(body["summary"], "아침 운동");
        // wall-clock dateTime + timeZone 필드(offset 미부여).
        assert_eq!(body["start"]["dateTime"], "2026-05-29T07:00:00");
        assert_eq!(body["start"]["timeZone"], "Asia/Seoul");
        assert_eq!(body["end"]["dateTime"], "2026-05-29T07:30:00");
        assert_eq!(body["end"]["timeZone"], "Asia/Seoul");
        let rec = body["recurrence"].as_array().expect("recurrence array");
        assert_eq!(rec.len(), 1);
        assert_eq!(rec[0], "RRULE:FREQ=WEEKLY;BYDAY=MO");
    }

    /// 회귀: recurrence/time_zone 없는 patch는 종전과 바이트 동일(normalize offset dateTime,
    /// timeZone/recurrence 키 없음).
    #[test]
    fn build_patch_body_non_recurring_unchanged() {
        let payload = r#"{"start":"2026-05-28T10:00:00+09:00","duration_min":30}"#;
        let body = build_patch_body(payload).unwrap();
        let start = normalize_timed_start("2026-05-28T10:00:00+09:00").unwrap();
        let end = compute_end(&start, 30, false).unwrap();
        let expected = serde_json::json!({
            "start": { "dateTime": start },
            "end": { "dateTime": end },
        });
        assert_eq!(body, expected);
        assert!(body.get("recurrence").is_none());
        assert!(body["start"].get("timeZone").is_none());
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
        deleted: Mutex<Vec<(String, String)>>, // (calendar_id, event_id)
        patched: Mutex<Vec<(String, String, serde_json::Value)>>, // (calendar_id, event_id, body)
        new_event_id: String,
        patch_returns_not_found: bool,
        /// Some((pool, routine_id))면 create_event 도중 그 routine의 미러를 NULL로 지운다 —
        /// "워커가 외부 create를 호출하는 사이 disable이 커밋"하는 레이스를 결정적으로 재현
        /// (post-create CAS 분기 회귀 전용).
        clear_mirror_on_create: Option<(SqlitePool, String)>,
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
            // 레이스 재현 훅: 외부 create가 진행되는 "사이"에 disable이 커밋된 상황.
            if let Some((pool, rid)) = &self.clear_mirror_on_create {
                sqlx::query(
                    "UPDATE routines SET google_event_id = NULL, google_calendar_id = NULL \
                     WHERE id = ?1",
                )
                .bind(rid)
                .execute(pool)
                .await
                .expect("clear_mirror_on_create");
            }
            Ok((self.new_event_id.clone(), None))
        }
        async fn patch_event(
            &self,
            _at: &str,
            cal: &str,
            ev: &str,
            p: &serde_json::Value,
        ) -> Result<(), CalendarError> {
            self.patched
                .lock()
                .unwrap()
                .push((cal.to_string(), ev.to_string(), p.clone()));
            if self.patch_returns_not_found {
                return Err(CalendarError::NotFound("gone".into()));
            }
            Ok(())
        }
        async fn delete_event(&self, _at: &str, cal: &str, ev: &str) -> Result<(), CalendarError> {
            self.deleted
                .lock()
                .unwrap()
                .push((cal.to_string(), ev.to_string()));
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

    /// 오펀 누수 방어(defense-in-depth): 이미 다른 이벤트가 링크된 카드에 대한 create(예: MoveCalendar로
    /// 다른 캘린더에 새 이벤트 생성)는, 새 이벤트 생성·링크백 후 **옛 mirror 이벤트를 삭제**해야 한다.
    /// 안 그러면 옛 이벤트가 카드에 안 묶인 채 Google에 남아 중복이 된다.
    #[tokio::test]
    async fn create_replacing_existing_link_deletes_old_event() {
        let pool = fresh_pool().await;
        // 이미 cal_old의 evt_old에 링크된 시그널.
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, linked_event_id, linked_calendar_id) \
             VALUES ('s1','Demo','braindump','thought','evt_old','cal_old')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // 새 캘린더(cal_new)에 create — MoveCalendar 커밋 후 워커가 보는 형태(staged 제거됨).
        let _pid = upsert_write(
            &pool,
            "create",
            "signal",
            "s1",
            "cal_new",
            None,
            r#"{"title":"Demo","start":"2026-06-21T10:00:00+09:00","duration_min":30}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];
        let provider = RecordingProvider {
            new_event_id: "evt_new".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", row)
            .await
            .unwrap();

        // 링크가 새 이벤트로 이동.
        let (le, lc): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT linked_event_id, linked_calendar_id FROM signals WHERE id = 's1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(le.as_deref(), Some("evt_new"));
        assert_eq!(lc.as_deref(), Some("cal_new"));
        // 옛 mirror 이벤트가 삭제됨(오펀 방지).
        let deleted = provider.deleted.lock().unwrap().clone();
        assert_eq!(
            deleted,
            vec![("cal_old".to_string(), "evt_old".to_string())],
            "옛 mirror 이벤트를 삭제해 오펀을 막아야 한다"
        );
    }

    #[tokio::test]
    async fn create_with_stored_event_id_links_back_without_second_insert() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) VALUES ('s1','Demo','braindump','thought')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let pid = upsert_write(
            &pool,
            "create",
            "signal",
            "s1",
            "calA",
            Some("evt_stored"),
            r#"{"title":"Demo","start":"2026-05-28T10:00:00+09:00","duration_min":30}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];

        let provider = RecordingProvider {
            new_event_id: "evt_duplicate".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake_access", row)
            .await
            .unwrap();
        delete_write(&pool, pid).await.unwrap();

        let created = provider.created.lock().unwrap().clone();
        assert!(
            created.is_empty(),
            "stored event_id must prevent duplicate create"
        );
        let (le, lc): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT linked_event_id, linked_calendar_id FROM signals WHERE id = 's1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(le.as_deref(), Some("evt_stored"));
        assert_eq!(lc.as_deref(), Some("calA"));
    }

    // ── P2: routine_master target arm (link_back / unlink / fetch_target_link) ────

    /// routine_master create: 반복 마스터를 큐로 생성하면 provider.create_event 호출 후
    /// routines.google_event_id / google_calendar_id 미러에 박혀야 한다. target_id = routine_id
    /// (파이프 없음). payload는 P1 형식(recurrence + time_zone).
    #[tokio::test]
    async fn routine_master_create_links_back_routines_mirror() {
        let pool = fresh_pool().await;
        // enable이 낙관적으로 google_calendar_id를 세팅한 상태(create 큐 전제) — cancel-check 통과.
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let pid = upsert_write(
            &pool,
            "create",
            "routine_master",
            "r1",
            "calA",
            None,
            r#"{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];

        let provider = RecordingProvider {
            new_event_id: "evt_master".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake_access", row)
            .await
            .unwrap();
        delete_write(&pool, pid).await.unwrap();

        // provider.create_event 호출 확인.
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created, vec![("calA".to_string(), "아침 운동".to_string())]);

        // routines 미러 박힘.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_master"));
        assert_eq!(cal.as_deref(), Some("calA"));
    }

    /// routine_master create 취소-검사(critic P4a round-2): 워커가 create 행을 처리하는 사이 enable이
    /// disable로 취소돼 routine.google_calendar_id가 NULL이면, 방금 만든 orphan 마스터를 지우고
    /// relink하지 않는다 — 취소된 enable이 재활성화되지 않게.
    #[tokio::test]
    async fn routine_master_create_cancelled_mid_flight_deletes_orphan_no_relink() {
        let pool = fresh_pool().await;
        // routine은 취소됨(google_calendar_id NULL) — disable가 clear_google_mirror한 상태.
        sqlx::query("INSERT INTO routines (id, title, freq) VALUES ('r1','아침 운동','weekly')")
            .execute(&pool)
            .await
            .unwrap();
        let pid = upsert_write(
            &pool,
            "create",
            "routine_master",
            "r1",
            "calA",
            None,
            r#"{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider {
            new_event_id: "evt_orphan".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake_access", &due[0])
            .await
            .unwrap();
        delete_write(&pool, pid).await.unwrap();

        // create는 호출됐지만, 취소 감지 후 방금 만든 orphan을 삭제.
        assert_eq!(
            provider.created.lock().unwrap().clone(),
            vec![("calA".to_string(), "아침 운동".to_string())]
        );
        assert_eq!(
            provider.deleted.lock().unwrap().clone(),
            vec![("calA".to_string(), "evt_orphan".to_string())],
            "취소된 enable의 orphan 마스터를 삭제해야 한다"
        );
        // routine은 relink되지 않음(google_event_id NULL 유지).
        let (evt,): (Option<String>,) =
            sqlx::query_as("SELECT google_event_id FROM routines WHERE id = 'r1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(evt.is_none(), "취소된 enable은 relink되면 안 된다");
    }

    /// routine_master delete: 링크된 마스터를 큐로 삭제하면 provider.delete_event 호출 후
    /// routines.google_event_id / google_calendar_id 두 컬럼이 NULL로 언링크돼야 한다.
    #[tokio::test]
    async fn routine_master_delete_nulls_routines_mirror() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_master','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let pid = upsert_write(
            &pool,
            "delete",
            "routine_master",
            "r1",
            "calA",
            Some("evt_master"),
            r#"{}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];

        let provider = RecordingProvider::default();
        execute_with_access(&pool, &provider, "fake_access", row)
            .await
            .unwrap();
        delete_write(&pool, pid).await.unwrap();

        // provider.delete_event 호출 확인.
        let deleted = provider.deleted.lock().unwrap().clone();
        assert_eq!(
            deleted,
            vec![("calA".to_string(), "evt_master".to_string())]
        );

        // routines 미러 NULL.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(evt.is_none());
        assert!(cal.is_none());
    }

    /// routine_master fetch_target_link: 이미 링크된 마스터에 대한 create(재링크)는 옛 링크를 읽어
    /// 새 이벤트 생성·링크백 후 옛 이벤트를 삭제해 오펀을 막는다(signal arm과 동일 방어).
    #[tokio::test]
    async fn routine_master_create_replacing_link_deletes_old_event() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_old','cal_old')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let _pid = upsert_write(
            &pool,
            "create",
            "routine_master",
            "r1",
            "cal_new",
            None,
            r#"{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=DAILY"]}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];
        let provider = RecordingProvider {
            new_event_id: "evt_new".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", row)
            .await
            .unwrap();

        // 링크가 새 이벤트로 이동.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_new"));
        assert_eq!(cal.as_deref(), Some("cal_new"));
        // 옛 마스터 이벤트 삭제(오펀 방지).
        let deleted = provider.deleted.lock().unwrap().clone();
        assert_eq!(
            deleted,
            vec![("cal_old".to_string(), "evt_old".to_string())]
        );
    }

    // ── P3: series_replace worker kind (split 원자화) ─────────────────────────────

    /// Happy path: 옛 마스터(evt_old@calA)에 링크된 루틴 + series_replace 행(event_id=NULL).
    /// execute → 옛 마스터를 old_patch로 patch(cap), 새 마스터 create, routines가 새 id로 relink.
    /// 옛 마스터는 KEEP(삭제 안 함) — 과거 인스턴스 보관 tombstone.
    #[tokio::test]
    async fn series_replace_caps_old_and_creates_new_relinks() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_old','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        let pid = upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            None,
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];

        let provider = RecordingProvider {
            new_event_id: "evt_new_master".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", row)
            .await
            .unwrap();
        delete_write(&pool, pid).await.unwrap();

        // 옛 마스터가 old_patch로 patch됨(cap).
        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1);
        assert_eq!(patched[0].0, "calA");
        assert_eq!(patched[0].1, "evt_old");
        assert_eq!(
            patched[0].2["recurrence"][0],
            "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"
        );
        // 새 마스터 create됨(new_create title).
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created, vec![("calA".to_string(), "아침 운동".to_string())]);
        // 옛 마스터는 KEEP — 삭제 안 됨.
        assert!(provider.deleted.lock().unwrap().is_empty());
        // routines가 새 마스터로 relink.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_new_master"));
        assert_eq!(cal.as_deref(), Some("calA"));
    }

    /// 멱등 가드: routine이 이미 old_event_id가 아닌 다른(새) 마스터를 추적하면(앞선 시도가 relink
    /// 까지 commit한 뒤 mark 실패로 pending.event_id가 NULL로 남아 수동 retry된 상황) series_replace는
    /// no-op — patch/create 모두 호출 안 하고 두 번째 마스터를 만들지 않는다(중복 방지).
    #[tokio::test]
    async fn series_replace_noop_when_routine_already_relinked() {
        let pool = fresh_pool().await;
        // routine은 이미 새 마스터(evt_new_master)를 추적 — split이 앞서 commit됨.
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_new_master','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // pending row는 여전히 old_event_id 기준(event_id=NULL) — mark 실패로 남은 형태.
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            None,
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider {
            new_event_id: "evt_should_not_be_created".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", &due[0])
            .await
            .unwrap();

        // no-op: patch/create 모두 미호출, routine 링크 불변(두 번째 마스터 없음).
        assert!(provider.patched.lock().unwrap().is_empty());
        assert!(provider.created.lock().unwrap().is_empty());
        let (evt,): (Option<String>,) =
            sqlx::query_as("SELECT google_event_id FROM routines WHERE id = 'r1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_new_master"));
    }

    /// P4b critic NIT#1 회귀 — post-create CAS 분기: 가드는 통과(미러==old)했는데 **외부 create가
    /// 진행되는 사이** disable이 미러를 지운 레이스. relink CAS(`WHERE google_calendar_id IS NOT
    /// NULL`)가 0행 → 방금 만든 새 마스터를 orphan으로 삭제하고 relink 없이 Ok — 재활성화 금지.
    #[tokio::test]
    async fn series_replace_disable_between_create_and_relink_deletes_new_master() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_old','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            None,
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider {
            new_event_id: "evt_new".into(),
            // 외부 create 호출 "도중" disable 커밋을 재현.
            clear_mirror_on_create: Some((pool.clone(), "r1".into())),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", &due[0])
            .await
            .unwrap();

        // 가드는 통과했으므로 patch+create는 호출됨 — 그러나 CAS 0행 → 새 마스터 orphan 삭제.
        assert_eq!(provider.patched.lock().unwrap().len(), 1);
        assert_eq!(
            provider.deleted.lock().unwrap().clone(),
            vec![("calA".to_string(), "evt_new".to_string())],
            "CAS 0행이면 방금 만든 새 마스터를 삭제해야 한다"
        );
        // 미러는 NULL 유지(disable이 이김 — 재활성화 금지).
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(evt.is_none());
        assert!(cal.is_none());
    }

    /// 재시도 멱등: event_id가 이미 Some('evt_new')(앞선 시도가 새 마스터를 이미 만듦)면
    /// create_event를 다시 부르지 않고 그대로 evt_new로 relink.
    #[tokio::test]
    async fn series_replace_retry_skips_create_relinks_stored_id() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_old','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        let pid = upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            Some("evt_new"),
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];

        let provider = RecordingProvider {
            new_event_id: "should_not_be_used".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", row)
            .await
            .unwrap();
        delete_write(&pool, pid).await.unwrap();

        // create_event 재호출 안 됨.
        assert!(
            provider.created.lock().unwrap().is_empty(),
            "stored event_id must skip re-create on retry"
        );
        // 여전히 저장된 새 id로 relink.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_new"));
        assert_eq!(cal.as_deref(), Some("calA"));
    }

    /// NotFound on old patch: 옛 마스터가 외부에서 사라짐(patch가 NotFound) → Terminal,
    /// routines.google_event_id / google_calendar_id NULL(인라인 clear_google_mirror 보존).
    #[tokio::test]
    async fn series_replace_old_patch_not_found_nulls_mirror_terminal() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_old','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        let _pid = upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            None,
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let row = &due[0];

        let provider = RecordingProvider {
            new_event_id: "unused".into(),
            patch_returns_not_found: true,
            ..Default::default()
        };
        let result = execute_with_access(&pool, &provider, "fake", row).await;
        assert!(
            matches!(result, Err(SyncError::Terminal(_))),
            "old master gone should be terminal: {result:?}"
        );
        // 새 마스터 create 시도 안 함.
        assert!(provider.created.lock().unwrap().is_empty());
        // routines mirror NULL.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(evt.is_none());
        assert!(cal.is_none());
    }

    // ── P4b A1: series_replace 취소 가드(미러 NULL = disable/삭제 개입) ─────────────

    /// 미러 NULL + w.event_id None: enqueue 후 disable가 미러를 clear했다 → 취소.
    /// patch/create 둘 다 skip, 삭제할 orphan도 없음, Ok.
    #[tokio::test]
    async fn series_replace_cancelled_when_mirror_null_no_op() {
        let pool = fresh_pool().await;
        // routine 존재하지만 미러 둘 다 NULL(disable가 clear).
        sqlx::query("INSERT INTO routines (id, title, freq) VALUES ('r1','아침 운동','weekly')")
            .execute(&pool)
            .await
            .unwrap();
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        let _pid = upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            None,
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider {
            new_event_id: "evt_should_not_be_created".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", &due[0])
            .await
            .unwrap();

        // 취소: patch/create/delete 모두 미호출.
        assert!(provider.patched.lock().unwrap().is_empty());
        assert!(provider.created.lock().unwrap().is_empty());
        assert!(provider.deleted.lock().unwrap().is_empty());
    }

    /// 미러 NULL + w.event_id Some(앞선 시도가 새 마스터 생성): 취소 → 그 orphan을 best-effort 삭제,
    /// patch/create skip.
    #[tokio::test]
    async fn series_replace_cancelled_deletes_orphan_when_event_id_some() {
        let pool = fresh_pool().await;
        sqlx::query("INSERT INTO routines (id, title, freq) VALUES ('r1','아침 운동','weekly')")
            .execute(&pool)
            .await
            .unwrap();
        let payload = r#"{
            "old_event_id":"evt_old",
            "old_patch":{"recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260528T215959Z"]},
            "new_create":{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"all_day":false,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]}
        }"#;
        // event_id=Some("evt_x") = 앞선 시도가 만든 새 마스터.
        let _pid = upsert_write(
            &pool,
            "series_replace",
            "routine_master",
            "r1",
            "calA",
            Some("evt_x"),
            payload,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider::default();
        execute_with_access(&pool, &provider, "fake", &due[0])
            .await
            .unwrap();

        assert!(provider.patched.lock().unwrap().is_empty());
        assert!(provider.created.lock().unwrap().is_empty());
        assert_eq!(
            provider.deleted.lock().unwrap().clone(),
            vec![("calA".to_string(), "evt_x".to_string())],
            "취소된 split의 orphan 새 마스터를 삭제해야 한다"
        );
    }

    // ── P4b A3: patch arm — routine_master NotFound → 조건부 unlink + Terminal ──────

    /// routine_master patch가 NotFound → 미러 NULL(조건부) + Terminal("sync expired").
    #[tokio::test]
    async fn patch_routine_master_not_found_nulls_mirror_terminal() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_m','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let pid = upsert_write(
            &pool,
            "patch",
            "routine_master",
            "r1",
            "calA",
            Some("evt_m"),
            r#"{"title":"아침 운동","start":"2026-05-29T07:00:00","duration_min":30,"time_zone":"Asia/Seoul","recurrence":["RRULE:FREQ=WEEKLY;BYDAY=MO"]}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let _ = pid;
        let provider = RecordingProvider {
            patch_returns_not_found: true,
            ..Default::default()
        };
        let result = execute_with_access(&pool, &provider, "fake", &due[0]).await;
        assert!(
            matches!(result, Err(SyncError::Terminal(_))),
            "routine master gone → terminal: {result:?}"
        );
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(evt.is_none(), "routine_master 미러 NULL out");
        assert!(cal.is_none());
    }

    /// 회귀: signal target patch가 NotFound → generic Terminal, signal 미러(linked_*)는 손대지 않음.
    #[tokio::test]
    async fn patch_signal_not_found_generic_terminal_untouched() {
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, linked_event_id, linked_calendar_id) \
             VALUES ('s1','Demo','braindump','thought','evt_s','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let _pid = upsert_write(
            &pool,
            "patch",
            "signal",
            "s1",
            "calA",
            Some("evt_s"),
            r#"{"start":"2026-05-28T10:00:00+09:00","duration_min":30}"#,
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider {
            patch_returns_not_found: true,
            ..Default::default()
        };
        let result = execute_with_access(&pool, &provider, "fake", &due[0]).await;
        assert!(
            matches!(result, Err(SyncError::Terminal(_))),
            "signal NotFound → generic terminal: {result:?}"
        );
        // signal 미러는 손대지 않음(routine_master 전용 sweep이 아니므로).
        let (le, lc): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT linked_event_id, linked_calendar_id FROM signals WHERE id = 's1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(le.as_deref(), Some("evt_s"), "signal 미러 유지");
        assert_eq!(lc.as_deref(), Some("calA"));
    }

    // ── P4b A4: delete arm 조건부 unlink(late-flush가 더 새 link를 null하지 않게) ──

    /// stale delete row(evt_A)가 flush될 때 미러가 이미 더 새 link(evt_B)를 가리키면 미러를 null하지
    /// 않는다 — provider delete는 evt_A로 호출되지만 routines.google_event_id는 evt_B 유지.
    #[tokio::test]
    async fn delete_stale_event_keeps_newer_link() {
        let pool = fresh_pool().await;
        // 미러는 이미 더 새 link(evt_B)를 가리킴.
        sqlx::query(
            "INSERT INTO routines (id, title, freq, google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','weekly','evt_B','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // stale delete row는 옛 event(evt_A) 대상.
        let _pid = upsert_write(
            &pool,
            "delete",
            "routine_master",
            "r1",
            "calA",
            Some("evt_A"),
            "{}",
            0,
        )
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        let provider = RecordingProvider::default();
        execute_with_access(&pool, &provider, "fake", &due[0])
            .await
            .unwrap();

        // provider delete는 evt_A로 호출됨(외부 이벤트 정리).
        assert_eq!(
            provider.deleted.lock().unwrap().clone(),
            vec![("calA".to_string(), "evt_A".to_string())]
        );
        // 하지만 미러는 더 새 link(evt_B) 유지 — stale delete가 null하지 않음.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_B"), "더 새 link 유지");
        assert_eq!(cal.as_deref(), Some("calA"));
    }

    // ── P4b 통합: enqueue split(B2) → 워커 execute(dialect 호환) ────────────────────

    /// end-to-end: 실제 seeded synced routine에 B2 split을 enqueue한 뒤 fetch한 series_replace 행을
    /// 워커 execute_with_access로 돌리면 옛 마스터가 capped body로 patch되고, 새 마스터가 create되고,
    /// routines가 새 id로 relink된다(enqueue 방언 → 워커 방언 호환 증명).
    #[tokio::test]
    async fn enqueue_split_then_worker_end_to_end() {
        use tokio::sync::Notify;
        let pool = fresh_pool().await;
        sqlx::query(
            "INSERT INTO routines \
             (id, title, freq, time_of_day, duration_min, kind, created_at, \
              google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','daily','07:00',30,'personal','2026-05-29 00:00:00', \
                     'evt_old','calA')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let notify = std::sync::Arc::new(Notify::new());
        let before = crate::commands::routines::routine_edit_sync_snapshot(&pool, "r1")
            .await
            .unwrap()
            .expect("synced snapshot");
        crate::commands::routines::patch_synced_routine_after_edit(
            &pool,
            &notify,
            "r1",
            Some(before),
            "2026-06-09",
        )
        .await
        .unwrap();

        // 큐에 series_replace 행 1개. 디바운스를 지나 due로 만든다(워커가 볼 시점 모사).
        sqlx::query(
            "UPDATE pending_calendar_writes SET next_attempt_at = datetime('now','-1 second')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].kind, "series_replace");
        let row = due[0].clone();

        let provider = RecordingProvider {
            new_event_id: "evt_new_master".into(),
            ..Default::default()
        };
        execute_with_access(&pool, &provider, "fake", &row)
            .await
            .unwrap();

        // 옛 마스터가 capped body로 patch됨(UNTIL 포함).
        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1);
        assert_eq!(patched[0].0, "calA");
        assert_eq!(patched[0].1, "evt_old");
        let old_rec = patched[0].2["recurrence"][0].as_str().unwrap();
        assert!(
            old_rec.contains("UNTIL="),
            "옛 마스터 capped RRULE: {old_rec}"
        );
        // 새 마스터 create됨.
        assert_eq!(
            provider.created.lock().unwrap().clone(),
            vec![("calA".to_string(), "아침 운동".to_string())]
        );
        // routines가 새 마스터로 relink.
        let (evt, cal): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_event_id, google_calendar_id FROM routines WHERE id = 'r1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evt.as_deref(), Some("evt_new_master"));
        assert_eq!(cal.as_deref(), Some("calA"));
    }

    // ── P4c 통합: move 2-행 enqueue(delete@old_cal + create@new_cal) 순서 안전 ─────────

    /// 동기화 루틴 + 프로젝트를 seed하고 move_routine_google_sync_inner로 2-행(delete+create)을
    /// enqueue한 뒤, due 행을 지정된 순서로 execute_with_access에 통과시킨다. 반환: (delete_row, create_row)
    /// 실행 후 최종 미러가 (cal_new, evt_new)로, 옛 이벤트가 정확히 1회 삭제·새 이벤트 1회 생성되는지
    /// 두 순서 모두 검증하기 위한 공용 셋업.
    async fn seed_and_enqueue_move(pool: &SqlitePool) {
        use tokio::sync::Notify;
        // 새 프로젝트(kind 검증용).
        sqlx::query(
            "INSERT INTO projects (id, name, kind, credential_ref) \
             VALUES ('projA','A','personal','test_creds'),('projB','B','personal','test_creds')",
        )
        .execute(pool)
        .await
        .unwrap();
        // 옛 캘린더로 동기화된 루틴.
        sqlx::query(
            "INSERT INTO routines \
             (id, title, freq, time_of_day, duration_min, kind, created_at, project_id, \
              google_event_id, google_calendar_id) \
             VALUES ('r1','아침 운동','daily','07:00',30,'personal','2026-05-29 00:00:00','projA', \
                     'evt_old','cal_old')",
        )
        .execute(pool)
        .await
        .unwrap();

        let notify = std::sync::Arc::new(Notify::new());
        crate::commands::routines::move_routine_google_sync_inner(
            pool, &notify, "r1", "projB", "cal_new",
        )
        .await
        .unwrap();

        // 낙관적 미러 = (projB, cal_new, evt NULL).
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id='r1'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(cal.as_deref(), Some("cal_new"));
        assert!(evt.is_none());

        // 디바운스를 지나 due로.
        sqlx::query(
            "UPDATE pending_calendar_writes SET next_attempt_at = datetime('now','-1 second')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// (a) delete-first: 옛 이벤트가 cal_old에서 삭제되고 조건부 unlink는 0행(미러 evt=NULL≠evt_old)이라
    /// 미러 (cal_new, NULL) 유지 → 이후 create가 cal_new에 생성·CAS relink → 최종 (cal_new, evt_new).
    #[tokio::test]
    async fn move_two_row_delete_first_converges() {
        let pool = fresh_pool().await;
        seed_and_enqueue_move(&pool).await;
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        assert_eq!(due.len(), 2, "delete + create 2행");
        let delete_row = due.iter().find(|w| w.kind == "delete").unwrap().clone();
        let create_row = due.iter().find(|w| w.kind == "create").unwrap().clone();

        let provider = RecordingProvider {
            new_event_id: "evt_new".into(),
            ..Default::default()
        };
        // delete 먼저.
        execute_with_access(&pool, &provider, "fake", &delete_row)
            .await
            .unwrap();
        execute_with_access(&pool, &provider, "fake", &create_row)
            .await
            .unwrap();

        assert_convergent(&pool, &provider).await;
    }

    /// (b) create-first: cal_new에 생성·CAS relink → 미러 (cal_new, evt_new). 이후 delete는 옛 이벤트를
    /// cal_old에서 삭제하지만 조건부 unlink(evt_old≠evt_new)는 0행 → 미러 (cal_new, evt_new) 유지.
    #[tokio::test]
    async fn move_two_row_create_first_converges() {
        let pool = fresh_pool().await;
        seed_and_enqueue_move(&pool).await;
        let due = crate::calendar::pending_store::fetch_due_writes(&pool)
            .await
            .unwrap();
        assert_eq!(due.len(), 2, "delete + create 2행");
        let delete_row = due.iter().find(|w| w.kind == "delete").unwrap().clone();
        let create_row = due.iter().find(|w| w.kind == "create").unwrap().clone();

        let provider = RecordingProvider {
            new_event_id: "evt_new".into(),
            ..Default::default()
        };
        // create 먼저.
        execute_with_access(&pool, &provider, "fake", &create_row)
            .await
            .unwrap();
        execute_with_access(&pool, &provider, "fake", &delete_row)
            .await
            .unwrap();

        assert_convergent(&pool, &provider).await;
    }

    /// 두 순서 공용 수렴 단언: 옛 이벤트(cal_old/evt_old) 정확히 1회 삭제 + 새 이벤트 1회 생성 +
    /// 최종 미러 (cal_new, evt_new), NULL 아님.
    async fn assert_convergent(pool: &SqlitePool, provider: &RecordingProvider) {
        assert_eq!(
            provider.deleted.lock().unwrap().clone(),
            vec![("cal_old".to_string(), "evt_old".to_string())],
            "옛 이벤트가 정확히 1회 삭제"
        );
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1, "새 이벤트 정확히 1회 생성");
        assert_eq!(created[0].0, "cal_new", "새 이벤트는 cal_new에");
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id='r1'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            cal.as_deref(),
            Some("cal_new"),
            "최종 미러 캘린더 = cal_new"
        );
        assert_eq!(
            evt.as_deref(),
            Some("evt_new"),
            "최종 미러 이벤트 = evt_new(never NULL)"
        );
    }
}
