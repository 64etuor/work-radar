//! 백그라운드 스케줄러 스파인 (Phase 13, foundational).
//!
//! 트레이 상주 앱이 창을 닫아도 살아 있는 tokio 태스크가 **bounded interval**(TICK_INTERVAL)로
//! 틱한다. 매 틱마다 `scheduled_notifications`에서 due 행(`fire_at <= now AND fired_at IS NULL`)을
//! 골라 네이티브 알림을 발사하고 `fired_at`을 찍는다.
//!
//! INVARIANT #5: 고정 간격 tick(`tokio::time::interval`) — busy-loop 없음, 무한 retry 없음.
//!   알림 권한이 없거나 발사가 실패해도 행을 건너뛰고 로그만 남긴다(앱 코어 무영향, graceful degrade).
//! INVARIANT #7: 예약 상태의 SSOT는 로컬 SQLite. 한 번 fired된 행은 절대 재발사되지 않으며
//!   상태가 DB에 있으므로 재부팅 후에도 미발사 행이 복구된다.
//!
//! 소비처(Phase 16 routines / Phase 20 CI)는 스케줄러 코드를 건드리지 않고
//! `scheduled_notifications`에 행을 INSERT하기만 하면 된다(제네릭 source/source_id).

use std::time::Duration;

use crate::commands::notification_store;
use crate::db::Db;

// Notifier 트레이트가 여기 있으므로 DueNotification을 scheduler:: 경로로 재노출(소비처 lib.rs Notifier impl).
pub(crate) use crate::commands::notification_store::DueNotification;

/// 스케줄러 틱 간격. busy-loop가 아닌 bounded interval(INVARIANT #5). 30s = 분 단위 알림에
/// 충분하면서 idle CPU를 거의 쓰지 않는 절충.
pub const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// 네이티브 알림 발사 추상화. 실제 구현은 tauri-plugin-notification(앱 핸들),
/// 테스트는 발사 호출을 기록하는 fake. 발사 실패는 Err로 노출(스케줄러가 로그만 남기고 계속).
pub trait Notifier: Send + Sync + 'static {
    fn notify(&self, n: &DueNotification) -> Result<(), String>;
}

/// 한 틱: due 행을 발사하고 fired_at을 찍는다. 발사가 실패한 행은 fired로 표시하지 않아
/// 다음 틱에서 재시도되지만, 발사 시도 자체가 bounded interval에 묶여 있어 폭주하지 않는다
/// (재시도 = 다음 틱, busy-loop 아님). 발사된 행 수를 반환(테스트/로그용).
pub async fn run_tick<N: Notifier>(db: &Db, notifier: &N, now: &str) -> Result<usize, sqlx::Error> {
    let due = notification_store::due(db, now).await?;
    let mut fired = 0usize;
    for n in &due {
        match notifier.notify(n) {
            Ok(()) => {
                notification_store::mark_fired_by_id(db, &n.id, now).await?;
                fired += 1;
            }
            Err(e) => {
                // graceful degrade: 권한 없음/발사 실패는 로그만. 행은 미발사로 남겨 다음 틱 재시도.
                eprintln!(
                    "[scheduler] notify failed (id={}, source={}): {e}",
                    n.id, n.source
                );
            }
        }
    }
    Ok(fired)
}

/// 백그라운드 틱 루프를 spawn한다(논블로킹). 트레이 상주 동안 계속 살아 있다.
/// `tokio::time::interval`로 고정 간격을 보장(INVARIANT #5: busy-loop/무한 즉시반복 아님).
/// DB 에러는 한 틱을 건너뛰고 다음 틱에서 재시도(앱은 계속 동작 — graceful degrade).
///
/// **`tauri::async_runtime::spawn` 사용(필수):** setup()은 macOS main 스레드(app_delegate
/// did_finish_launching)에서 돌아 진입된 Tokio 런타임이 없다 → `tokio::spawn`은 "no reactor running"
/// 패닉으로 부팅 즉시 abort. Tauri 관리 런타임(멀티스레드 Tokio, timer 포함)에 올린다.
pub fn spawn_loop<N: Notifier>(db: Db, notifier: N) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(TICK_INTERVAL);
        // mmbak 자동 임포트 동시 실행 가드 — 이 루프(스케줄러)가 단독 소유한다.
        let mmbak_in_flight = crate::commands::new_mmbak_auto_import_in_flight();
        loop {
            ticker.tick().await;
            let now = crate::scheduler::utc_now_string();
            if let Err(e) = run_tick(&db, &notifier, &now).await {
                eprintln!("[scheduler] tick failed: {e}");
            }
            // MoneyManager(.mmbak) 자동 임포트 훅: tick은 cheap check(옵션 1행 SELECT)+
            // 게이트 stamp+spawn만 수행 — 실제 임포트는 별도 task라 알림 tick 주기(30s)를
            // 밀지 않는다. 실패해도 게이트가 찍혀 다음 시도는 24h 뒤(bounded retry —
            // INVARIANT #5). 실패는 루프를 죽이지 않는다(graceful degrade). JoinHandle detach.
            match crate::commands::run_mmbak_auto_import_tick(&db, &now, &mmbak_in_flight).await {
                Ok(_) => {}
                Err(e) => tracing::warn!(code = %e.code, "mmbak auto-import tick failed"),
            }
        }
    });
}

/// `datetime('now')`와 동일 포맷의 현재 UTC 문자열('YYYY-MM-DD HH:MM:SS').
/// fire_at 비교가 SQLite datetime 문자열 사전순과 일치하도록 같은 포맷을 쓴다.
pub fn utc_now_string() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    async fn fresh_db() -> Db {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("wr-sched-test-{nanos}-{seq}.db"));
        init_db(&path).await.expect("init_db")
    }

    /// 발사 호출을 기록하는 fake notifier. always-ok.
    struct RecordingNotifier {
        fired: Mutex<Vec<String>>,
    }
    impl RecordingNotifier {
        fn new() -> Self {
            Self {
                fired: Mutex::new(Vec::new()),
            }
        }
    }
    impl Notifier for RecordingNotifier {
        fn notify(&self, n: &DueNotification) -> Result<(), String> {
            self.fired.lock().unwrap().push(n.id.clone());
            Ok(())
        }
    }

    /// 항상 실패하는 fake notifier(graceful degrade 검증용).
    struct FailingNotifier;
    impl Notifier for FailingNotifier {
        fn notify(&self, _n: &DueNotification) -> Result<(), String> {
            Err("permission denied".into())
        }
    }

    async fn insert(db: &Db, id: &str, fire_at: &str, fired_at: Option<&str>) {
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id, fired_at) \
             VALUES (?1, ?2, ?3, '본문', 'test', ?4, ?5)",
        )
        .bind(id)
        .bind(fire_at)
        .bind(format!("알림 {id}"))
        .bind(format!("src-{id}"))
        .bind(fired_at)
        .execute(db)
        .await
        .unwrap();
    }

    /// due-query: fire_at <= now & 미발사만 선택. 미래/이미발사 행은 제외, fire_at 오름차순.
    #[tokio::test]
    async fn due_query_selects_only_due_unfired() {
        let db = fresh_db().await;
        insert(&db, "past", "2026-05-22 09:00:00", None).await;
        insert(&db, "now", "2026-05-22 10:00:00", None).await;
        insert(&db, "future", "2026-05-22 11:00:00", None).await; // fire_at > now → 제외
        insert(
            &db,
            "already",
            "2026-05-22 08:00:00",
            Some("2026-05-22 08:00:01"),
        )
        .await; // fired → 제외

        let due = notification_store::due(&db, "2026-05-22 10:00:00")
            .await
            .unwrap();
        let ids: Vec<&str> = due.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["past", "now"], "due = past+now, 정렬 오름차순");
    }

    /// 멱등: 한 번 발사된 행은 fired_at이 찍히고 다음 틱에서 재선택되지 않는다.
    #[tokio::test]
    async fn fired_row_never_refires() {
        let db = fresh_db().await;
        insert(&db, "a", "2026-05-22 09:00:00", None).await;
        let notifier = RecordingNotifier::new();

        // 1st tick: 발사 1건.
        let fired1 = run_tick(&db, &notifier, "2026-05-22 10:00:00")
            .await
            .unwrap();
        assert_eq!(fired1, 1);
        // 2nd tick(같은/더 늦은 now): 이미 fired → 0건.
        let fired2 = run_tick(&db, &notifier, "2026-05-22 12:00:00")
            .await
            .unwrap();
        assert_eq!(fired2, 0, "fired 행은 재발사 안 함(멱등)");
        // notifier는 정확히 한 번만 호출.
        assert_eq!(
            notifier.fired.lock().unwrap().as_slice(),
            &["a".to_string()]
        );
    }

    /// 발사 실패(권한 없음 등)는 행을 fired로 표시하지 않아 다음 틱에서 재시도된다(graceful degrade).
    #[tokio::test]
    async fn failed_notify_leaves_row_unfired_for_retry() {
        let db = fresh_db().await;
        insert(&db, "a", "2026-05-22 09:00:00", None).await;

        // 실패 notifier: 발사 0건, 행은 미발사로 남는다.
        let failed = run_tick(&db, &FailingNotifier, "2026-05-22 10:00:00")
            .await
            .unwrap();
        assert_eq!(failed, 0);
        let still_due = notification_store::due(&db, "2026-05-22 10:00:00")
            .await
            .unwrap();
        assert_eq!(still_due.len(), 1, "실패 행은 다음 틱 재시도 대상으로 남음");

        // 이후 성공 notifier로 복구되면 정상 발사.
        let ok = RecordingNotifier::new();
        let fired = run_tick(&db, &ok, "2026-05-22 10:00:00").await.unwrap();
        assert_eq!(fired, 1);
    }

    /// 재부팅 복구: DB에 미발사로 영속된 행은 새 DB 핸들(=재시작 시뮬)에서도 due로 복구된다.
    #[tokio::test]
    async fn unfired_rows_persist_for_restart_recovery() {
        let path = std::env::temp_dir().join(format!(
            "wr-sched-persist-{}.db",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let db = init_db(&path).await.unwrap();
            insert(&db, "survivor", "2026-05-22 09:00:00", None).await;
            db.close().await;
        }
        // "재시작": 같은 파일로 새 풀.
        let db2 = init_db(&path).await.unwrap();
        let due = notification_store::due(&db2, "2026-05-22 10:00:00")
            .await
            .unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "survivor");
        db2.close().await;
        std::fs::remove_file(&path).ok();
    }
}
