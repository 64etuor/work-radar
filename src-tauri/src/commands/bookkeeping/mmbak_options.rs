//! MoneyManager(.mmbak) 자동 임포트 옵션 + watch-dir 최신 백업 임포트.
//!
//! - 옵션은 단일 row(id=1) — news_options(0020) 패턴(get은 멱등 re-seed).
//! - `import_bookkeeping_mmbak_latest`: watch_dir을 **1회, depth 1** 스캔해 mtime 최신
//!   `.mmbak`을 골라 기존 임포터(`import_bookkeeping_mmbak_inner`)에 위임한다.
//!   재귀/재시도 루프 없음(bounded scan).
//! - `run_mmbak_auto_import_tick`: 스케줄러 30s tick 훅. 24h 게이트(`should_auto_import`)
//!   통과 시에만 1회 시도. **성공/실패와 무관하게 last_auto_import_at을 찍는다** —
//!   실패 재시도는 다음 24h 게이트(retry storm 방지, INVARIANT #5 bounded retry).
//!   tick 자체는 cheap check + stamp + `tokio::spawn`만 수행 — 느린 임포트가
//!   알림 tick 주기를 밀지 않는다(실제 작업은 `run_mmbak_auto_import_once`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingMmbakOptions, BookkeepingSource, ImportBookkeepingMmbakInput,
    ImportBookkeepingMmbakSummary, SetBookkeepingMmbakOptionsInput,
};

use super::*;

/// 자동 임포트 최소 간격(시간). 백업은 하루 1회 수준으로 갱신되는 흐름이라 24h로 충분.
const AUTO_IMPORT_MIN_INTERVAL_HOURS: i64 = 24;

const OPTIONS_COLUMNS: &str =
    "watch_dir, project_id, auto_import_enabled, last_auto_import_at, updated_at";

type OptionsRow = (Option<String>, Option<String>, i64, Option<String>, String);

fn row_to_options(row: OptionsRow) -> BookkeepingMmbakOptions {
    BookkeepingMmbakOptions {
        watch_dir: row.0,
        project_id: row.1,
        auto_import_enabled: row.2 != 0,
        last_auto_import_at: row.3,
        updated_at: row.4,
    }
}

/// 순수 SELECT(seed 없음) — 스케줄러 tick의 cheap check용.
async fn fetch_mmbak_options(db: &Db) -> Result<Option<BookkeepingMmbakOptions>, AppError> {
    let row: Option<OptionsRow> = sqlx::query_as(&format!(
        "SELECT {OPTIONS_COLUMNS} FROM bookkeeping_mmbak_options WHERE id = 1"
    ))
    .fetch_optional(db)
    .await?;
    Ok(row.map(row_to_options))
}

#[tauri::command]
#[specta::specta]
pub async fn get_bookkeeping_mmbak_options(
    db: State<'_, Db>,
) -> Result<Option<BookkeepingMmbakOptions>, AppError> {
    get_bookkeeping_mmbak_options_inner(db.inner()).await
}

/// 멱등 re-seed → SELECT (news_options 패턴). row가 지워져도 다음 호출에서 복구.
pub(crate) async fn get_bookkeeping_mmbak_options_inner(
    db: &Db,
) -> Result<Option<BookkeepingMmbakOptions>, AppError> {
    sqlx::query("INSERT INTO bookkeeping_mmbak_options(id) VALUES (1) ON CONFLICT DO NOTHING")
        .execute(db)
        .await?;
    fetch_mmbak_options(db).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_bookkeeping_mmbak_options(
    db: State<'_, Db>,
    input: SetBookkeepingMmbakOptionsInput,
) -> Result<BookkeepingMmbakOptions, AppError> {
    set_bookkeeping_mmbak_options_inner(db.inner(), input).await
}

pub(crate) async fn set_bookkeeping_mmbak_options_inner(
    db: &Db,
    input: SetBookkeepingMmbakOptionsInput,
) -> Result<BookkeepingMmbakOptions, AppError> {
    let watch_dir = clean_optional(input.watch_dir.as_deref());
    if let Some(dir) = watch_dir.as_deref() {
        let meta = std::fs::metadata(dir).map_err(|_| {
            AppError::validation(
                "bookkeeping.mmbak.watch_dir_not_found",
                "감시 폴더를 찾을 수 없습니다",
            )
        })?;
        if !meta.is_dir() {
            return Err(AppError::validation(
                "bookkeeping.mmbak.watch_dir_not_a_dir",
                "감시 경로가 폴더가 아닙니다",
            ));
        }
    }
    let project_id = clean_optional(input.project_id.as_deref());
    if let Some(project_id) = project_id.as_deref() {
        ensure_project_exists(db, project_id, "bookkeeping.mmbak.project_not_found").await?;
    }

    // last_auto_import_at은 스케줄러 게이트 소유 — 여기서 건드리지 않는다.
    let row: OptionsRow = sqlx::query_as(&format!(
        "INSERT INTO bookkeeping_mmbak_options(id, watch_dir, project_id, auto_import_enabled, updated_at) \
         VALUES (1, ?1, ?2, ?3, datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
             watch_dir = excluded.watch_dir, \
             project_id = excluded.project_id, \
             auto_import_enabled = excluded.auto_import_enabled, \
             updated_at = datetime('now') \
         RETURNING {OPTIONS_COLUMNS}"
    ))
    .bind(watch_dir.as_deref())
    .bind(project_id.as_deref())
    .bind(if input.auto_import_enabled { 1_i64 } else { 0_i64 })
    .fetch_one(db)
    .await?;
    Ok(row_to_options(row))
}

#[tauri::command]
#[specta::specta]
pub async fn import_bookkeeping_mmbak_latest(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<ImportBookkeepingMmbakSummary, AppError> {
    import_bookkeeping_mmbak_latest_inner(db.inner(), project_id).await
}

pub(crate) async fn import_bookkeeping_mmbak_latest_inner(
    db: &Db,
    project_id: Option<String>,
) -> Result<ImportBookkeepingMmbakSummary, AppError> {
    let options = get_bookkeeping_mmbak_options_inner(db)
        .await?
        .ok_or_else(|| {
            AppError::validation(
                "bookkeeping.mmbak.options_missing",
                "머니매니저 옵션을 불러올 수 없습니다",
            )
        })?;
    let watch_dir = options
        .watch_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    let Some(watch_dir) = watch_dir else {
        return Err(AppError::validation(
            "bookkeeping.mmbak.watch_dir_unset",
            "감시 폴더가 설정되지 않았습니다 — 백업 폴더 경로를 먼저 저장하세요",
        ));
    };
    let latest = find_latest_mmbak(Path::new(watch_dir))?.ok_or_else(|| {
        AppError::not_found(
            "bookkeeping.mmbak.no_backup_found",
            "감시 폴더에 .mmbak 백업 파일이 없습니다",
        )
    })?;
    // 명시 인자 우선, 없으면 옵션의 기본 프로젝트.
    let project_id = project_id.or(options.project_id);
    import_bookkeeping_mmbak_inner(
        db,
        ImportBookkeepingMmbakInput {
            project_id,
            path: latest.to_string_lossy().to_string(),
        },
    )
    .await
}

/// watch_dir을 **1회** 스캔(depth 1, 재귀 없음)해 mtime이 가장 최신인 `.mmbak` 파일을 고른다.
/// 서브디렉터리·타 확장자·메타데이터 실패 항목은 건너뛴다.
/// mtime 동률은 파일명 내림차순으로 결정적 tie-break(MMGP 파일명은 타임스탬프를
/// 포함하므로 사전순 최댓값 ≈ 최신 백업).
#[allow(clippy::result_large_err)]
fn find_latest_mmbak(dir: &Path) -> Result<Option<PathBuf>, AppError> {
    let entries = std::fs::read_dir(dir).map_err(|_| {
        AppError::not_found(
            "bookkeeping.mmbak.watch_dir_unreadable",
            "감시 폴더를 열 수 없습니다",
        )
    })?;
    let mut best: Option<((SystemTime, OsString), PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_mmbak = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("mmbak"));
        if !is_mmbak {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(mtime) = meta.modified() else { continue };
        let key = (
            mtime,
            path.file_name().map(OsString::from).unwrap_or_default(),
        );
        if best.as_ref().is_none_or(|(k, _)| key > *k) {
            best = Some((key, path));
        }
    }
    Ok(best.map(|(_, path)| path))
}

/// 24h 게이트(순수). enabled가 아니면 false, 마지막 기록이 없으면 true,
/// 있으면 `AUTO_IMPORT_MIN_INTERVAL_HOURS` 경과 시에만 true.
/// 타임스탬프 포맷은 scheduler::utc_now_string과 동일('YYYY-MM-DD HH:MM:SS' UTC).
/// last가 파싱 불가한 쓰레기 값이면 due로 취급 — 1회 돌고 유효 값으로 덮인다.
pub(crate) fn should_auto_import(
    now_utc: &str,
    enabled: bool,
    last_auto_import_at: Option<&str>,
) -> bool {
    if !enabled {
        return false;
    }
    let Some(last) = last_auto_import_at else {
        return true;
    };
    let Ok(now) = chrono::NaiveDateTime::parse_from_str(now_utc, "%Y-%m-%d %H:%M:%S") else {
        // now가 계약 포맷이 아니면 판단 불가 — 보수적으로 skip(다음 tick에 재평가).
        return false;
    };
    match chrono::NaiveDateTime::parse_from_str(last, "%Y-%m-%d %H:%M:%S") {
        Ok(last) => now - last >= chrono::Duration::hours(AUTO_IMPORT_MIN_INTERVAL_HOURS),
        Err(_) => true,
    }
}

/// 동시 실행 가드 플래그. 스케줄러(spawn_loop)가 한 인스턴스를 소유하고 매 tick 전달한다.
pub(crate) type MmbakAutoImportInFlight = Arc<AtomicBool>;

pub(crate) fn new_mmbak_auto_import_in_flight() -> MmbakAutoImportInFlight {
    Arc::new(AtomicBool::new(false))
}

/// RAII 가드: drop 시 in-flight 플래그를 해제한다(spawned task가 패닉해도 해제됨).
struct InFlightGuard(MmbakAutoImportInFlight);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn try_acquire_in_flight(flag: &MmbakAutoImportInFlight) -> Option<InFlightGuard> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| InFlightGuard(flag.clone()))
}

/// 스케줄러 tick 훅 — **cheap check + stamp + spawn만** 수행하고 즉시 반환한다.
/// 느린 .mmbak 임포트가 알림 tick 주기(30s)를 밀지 않도록 실제 작업은
/// `tokio::spawn`으로 분리한다. 반환값은 spawn된 작업의 JoinHandle(테스트에서 await;
/// 스케줄러는 detach).
///
/// **bounded-retry 결정:** 게이트 통과 즉시(= spawn **전에**) last_auto_import_at을
/// 찍는다 — 임포트가 실패하거나 spawned task가 죽어도 다음 시도는 24h 뒤다.
/// tick(30s)마다 재시도하는 retry storm을 원천 차단한다(INVARIANT #5).
///
/// **동시 실행 가드:** 이전 spawn이 아직 도는 동안 게이트가 다시 열리면(24h 경계 등)
/// stamp 없이 skip — 두 임포트가 동시에 돌지 않는다. 플래그는 task 종료 시
/// RAII drop으로 해제되어 다음 tick에 재평가된다.
pub(crate) async fn run_mmbak_auto_import_tick(
    db: &Db,
    now_utc: &str,
    in_flight: &MmbakAutoImportInFlight,
) -> Result<Option<tokio::task::JoinHandle<()>>, AppError> {
    let Some(options) = fetch_mmbak_options(db).await? else {
        return Ok(None);
    };
    if !should_auto_import(
        now_utc,
        options.auto_import_enabled,
        options.last_auto_import_at.as_deref(),
    ) {
        return Ok(None);
    }
    let Some(guard) = try_acquire_in_flight(in_flight) else {
        return Ok(None);
    };
    // stamp는 spawn 전에 — 아래 UPDATE가 실패하면 guard drop으로 플래그도 해제된다.
    sqlx::query(
        "UPDATE bookkeeping_mmbak_options \
         SET last_auto_import_at = ?1, updated_at = datetime('now') WHERE id = 1",
    )
    .bind(now_utc)
    .execute(db)
    .await?;
    let db = db.clone();
    Ok(Some(tokio::spawn(async move {
        let _guard = guard; // task 종료(정상/패닉) 시 in-flight 해제.
        run_mmbak_auto_import_once(&db).await;
    })))
}

/// spawn 본체(테스트 가능): 최신 백업 임포트 1회 + 결과 기록. 에러를 밖으로 던지지
/// 않는다 — 실패는 failed sync job으로 기록해 운영 로그에 보인다
/// (메시지는 record_*가 새니타이즈; 여기 로그는 코드만 — PII 없음).
pub(crate) async fn run_mmbak_auto_import_once(db: &Db) {
    match import_bookkeeping_mmbak_latest_inner(db, None).await {
        Ok(summary) => {
            tracing::info!(
                scanned = summary.scanned_count,
                imported = summary.imported_count,
                duplicate = summary.duplicate_count,
                failed = summary.failed_count,
                "mmbak auto-import completed"
            );
        }
        Err(e) => {
            // 임포터 내부(load 실패)는 자체 failed job을 남기지만, 옵션/스캔 단계 실패는
            // 여기가 유일한 가시화 지점이다. 중복 기록보다 미기록이 더 나쁘므로 항상 남긴다.
            let record = record_bookkeeping_sync_status_inner(
                db,
                BookkeepingSource::MoneyManager,
                "failed",
                Some("mmbak.auto_import_failed"),
                Some(&e.to_string()),
            )
            .await;
            if let Err(record_err) = record {
                tracing::warn!(code = %record_err.code, "mmbak auto-import failure record failed");
            }
            tracing::warn!(code = %e.code, "mmbak auto-import failed; next attempt in 24h");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
    use std::time::Duration;

    async fn pool() -> Db {
        let p = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("sqlite in-memory");
        sqlx::migrate!("./migrations")
            .run(&p)
            .await
            .expect("migrations");
        p
    }

    fn set_input(
        watch_dir: Option<&str>,
        project_id: Option<&str>,
        enabled: bool,
    ) -> SetBookkeepingMmbakOptionsInput {
        SetBookkeepingMmbakOptionsInput {
            watch_dir: watch_dir.map(str::to_string),
            project_id: project_id.map(str::to_string),
            auto_import_enabled: enabled,
        }
    }

    /// 최소 유효 .mmbak 픽스처(지출 1건).
    async fn write_fixture_mmbak(path: &std::path::Path) {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&opts).await.expect("open");
        for sql in [
            "CREATE TABLE INOUTCOME (uid TEXT, assetUid TEXT, ctgUid TEXT, ZCONTENT TEXT, \
             ZDATE INTEGER, WDATE TEXT, DO_TYPE TEXT, ZMONEY TEXT, toAssetUid TEXT, \
             txUidTrans TEXT, cardDivideUid TEXT, CARDDIVIDMONTH TEXT, IS_DEL INTEGER, \
             UTIME INTEGER, currencyUid TEXT)",
            "CREATE TABLE ZCATEGORY (uid TEXT, NAME TEXT, TYPE INTEGER, pUid TEXT, \
             C_IS_DEL INTEGER, STATUS INTEGER)",
            "CREATE TABLE ASSETS (uid TEXT, NIC_NAME TEXT, groupUid TEXT)",
            "CREATE TABLE CURRENCY (uid TEXT, ISO TEXT, DECIMAL_POINT INTEGER)",
            "INSERT INTO ZCATEGORY VALUES ('10','식비',1,'0',0,0)",
            "INSERT INTO ASSETS VALUES ('a1','하나카드','g1')",
            "INSERT INTO CURRENCY VALUES ('KRW_KRW','KRW',0)",
            "INSERT INTO INOUTCOME VALUES ('mm-latest-1','a1','10','스타벅스',0,'2026-06-15','1','5500.0','','','','',0,100,'KRW_KRW')",
        ] {
            sqlx::query(sql).execute(&mut conn).await.expect("exec");
        }
        conn.close().await.expect("close");
    }

    fn touch(path: &std::path::Path, mtime: SystemTime) {
        std::fs::write(path, b"stub").expect("write");
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open");
        f.set_modified(mtime).expect("set mtime");
    }

    // ── options get/set ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn options_get_seeds_default_row() {
        let db = pool().await;
        let o = get_bookkeeping_mmbak_options_inner(&db)
            .await
            .expect("get")
            .expect("seeded row");
        assert_eq!(o.watch_dir, None);
        assert_eq!(o.project_id, None);
        assert!(!o.auto_import_enabled);
        assert_eq!(o.last_auto_import_at, None);
    }

    #[tokio::test]
    async fn options_set_then_get_roundtrip() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let saved = set_bookkeeping_mmbak_options_inner(
            &db,
            set_input(Some(dir.path().to_str().expect("utf8")), None, true),
        )
        .await
        .expect("set");
        assert!(saved.auto_import_enabled);
        assert_eq!(saved.watch_dir.as_deref(), dir.path().to_str());

        let o = get_bookkeeping_mmbak_options_inner(&db)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(o.watch_dir.as_deref(), dir.path().to_str());
        assert!(o.auto_import_enabled);
        // set은 last_auto_import_at을 건드리지 않는다.
        assert_eq!(o.last_auto_import_at, None);
    }

    #[tokio::test]
    async fn options_set_rejects_missing_dir_and_non_dir() {
        let db = pool().await;
        let err = set_bookkeeping_mmbak_options_inner(
            &db,
            set_input(Some("/nonexistent/mmbak-watch"), None, false),
        )
        .await
        .expect_err("missing dir rejected");
        assert_eq!(err.code, "bookkeeping.mmbak.watch_dir_not_found");

        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("not-a-dir.mmbak");
        std::fs::write(&file, b"x").expect("write");
        let err = set_bookkeeping_mmbak_options_inner(
            &db,
            set_input(Some(file.to_str().expect("utf8")), None, false),
        )
        .await
        .expect_err("file rejected");
        assert_eq!(err.code, "bookkeeping.mmbak.watch_dir_not_a_dir");
    }

    #[tokio::test]
    async fn options_set_rejects_unknown_project() {
        let db = pool().await;
        let err = set_bookkeeping_mmbak_options_inner(&db, set_input(None, Some("nope"), false))
            .await
            .expect_err("unknown project rejected");
        assert_eq!(err.code, "bookkeeping.mmbak.project_not_found");
    }

    // ── latest-file selection ────────────────────────────────────────────────

    #[test]
    fn find_latest_mmbak_picks_newest_mtime_and_ignores_others() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        touch(&dir.path().join("MMGP(26-6-1).mmbak"), base);
        touch(
            &dir.path().join("MMGP(26-7-2).mmbak"),
            base + Duration::from_secs(3600),
        );
        touch(
            &dir.path().join("newest-but-wrong-ext.txt"),
            base + Duration::from_secs(7200),
        );
        std::fs::create_dir(dir.path().join("sub.mmbak")).expect("subdir");
        // depth 1만: 하위 폴더의 더 최신 파일은 무시된다.
        std::fs::create_dir(dir.path().join("nested")).expect("nested");
        touch(
            &dir.path().join("nested/deeper.mmbak"),
            base + Duration::from_secs(9999),
        );

        let latest = find_latest_mmbak(dir.path()).expect("scan").expect("hit");
        assert_eq!(
            latest.file_name().and_then(|n| n.to_str()),
            Some("MMGP(26-7-2).mmbak")
        );
    }

    #[test]
    fn find_latest_mmbak_breaks_mtime_ties_by_filename_desc() {
        let dir = tempfile::tempdir().expect("tempdir");
        let same = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        // 동일 mtime → 파일명 내림차순(사전순 최댓값)이 결정적으로 이긴다.
        touch(&dir.path().join("MMGP(26-7-2-090000).mmbak"), same);
        touch(&dir.path().join("MMGP(26-7-2-145327).mmbak"), same);
        touch(&dir.path().join("MMGP(26-7-1-235959).mmbak"), same);

        let latest = find_latest_mmbak(dir.path()).expect("scan").expect("hit");
        assert_eq!(
            latest.file_name().and_then(|n| n.to_str()),
            Some("MMGP(26-7-2-145327).mmbak")
        );
    }

    #[test]
    fn find_latest_mmbak_empty_dir_is_none_and_missing_dir_is_err() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(find_latest_mmbak(dir.path()).expect("scan"), None);
        let err = find_latest_mmbak(Path::new("/nonexistent/mmbak-watch")).expect_err("missing");
        assert_eq!(err.code, "bookkeeping.mmbak.watch_dir_unreadable");
    }

    // ── import latest ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn import_latest_errors_when_watch_dir_unset() {
        let db = pool().await;
        let err = import_bookkeeping_mmbak_latest_inner(&db, None)
            .await
            .expect_err("unset watch dir");
        assert_eq!(err.code, "bookkeeping.mmbak.watch_dir_unset");
    }

    #[tokio::test]
    async fn import_latest_imports_newest_backup() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        // 유효 픽스처가 최신, 옛 파일은 빈 stub(잘못 골리면 open 실패로 드러난다).
        let old = dir.path().join("old.mmbak");
        touch(
            &old,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        );
        let newest = dir.path().join("MMGP(26-7-2-145327).mmbak");
        write_fixture_mmbak(&newest).await;

        set_bookkeeping_mmbak_options_inner(
            &db,
            set_input(Some(dir.path().to_str().expect("utf8")), None, false),
        )
        .await
        .expect("set options");

        let summary = import_bookkeeping_mmbak_latest_inner(&db, None)
            .await
            .expect("import latest");
        assert_eq!(summary.scanned_count, 1);
        assert_eq!(summary.imported_count, 1);
    }

    // ── 24h gate ─────────────────────────────────────────────────────────────

    #[test]
    fn should_auto_import_gate_logic() {
        let now = "2026-07-02 12:00:00";
        // disabled → 항상 false.
        assert!(!should_auto_import(now, false, None));
        assert!(!should_auto_import(now, false, Some("2020-01-01 00:00:00")));
        // enabled + 기록 없음 → due.
        assert!(should_auto_import(now, true, None));
        // 정확히 24h 경과 → due, 그 미만 → skip.
        assert!(should_auto_import(now, true, Some("2026-07-01 12:00:00")));
        assert!(should_auto_import(now, true, Some("2026-06-30 12:00:00")));
        assert!(!should_auto_import(now, true, Some("2026-07-01 12:00:01")));
        assert!(!should_auto_import(now, true, Some("2026-07-02 11:59:59")));
        // 파싱 불가한 last → due(1회 돌고 유효 값으로 덮임).
        assert!(should_auto_import(now, true, Some("garbage")));
        // 파싱 불가한 now → 보수적 skip (last 기록이 있어 비교가 필요한 경우).
        assert!(!should_auto_import(
            "garbage",
            true,
            Some("2020-01-01 00:00:00")
        ));
        // last 기록 자체가 없으면 now 포맷과 무관하게 due(첫 실행).
        assert!(should_auto_import("garbage", true, None));
    }

    // ── scheduler tick hook ──────────────────────────────────────────────────

    async fn mm_row_count(db: &Db) -> i64 {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM bookkeeping_transactions WHERE source = 'moneymanager'",
        )
        .fetch_one(db)
        .await
        .expect("count");
        n
    }

    #[tokio::test]
    async fn tick_stamps_gate_before_work_then_gates_for_24h() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        write_fixture_mmbak(&dir.path().join("backup.mmbak")).await;
        set_bookkeeping_mmbak_options_inner(
            &db,
            set_input(Some(dir.path().to_str().expect("utf8")), None, true),
        )
        .await
        .expect("set options");
        let in_flight = new_mmbak_auto_import_in_flight();

        let handle = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:00", &in_flight)
            .await
            .expect("tick")
            .expect("spawned");
        // (b) 게이트 stamp는 spawn **전에** 동기적으로 찍힌다 — handle await 전에 이미 보인다.
        let o = get_bookkeeping_mmbak_options_inner(&db)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(
            o.last_auto_import_at.as_deref(),
            Some("2026-07-02 12:00:00")
        );
        handle.await.expect("spawned task");
        assert_eq!(mm_row_count(&db).await, 1, "임포트 완료");
        assert!(!in_flight.load(Ordering::Acquire), "완료 후 플래그 해제");

        // 30초 뒤 tick: 게이트에 막혀 spawn하지 않는다.
        let skipped = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:30", &in_flight)
            .await
            .expect("tick");
        assert!(skipped.is_none());

        // 24h 뒤: 다시 시도한다.
        let handle = run_mmbak_auto_import_tick(&db, "2026-07-03 12:00:00", &in_flight)
            .await
            .expect("tick")
            .expect("re-spawned");
        handle.await.expect("spawned task");
    }

    #[tokio::test]
    async fn tick_in_flight_guard_prevents_concurrent_run() {
        let db = pool().await;
        sqlx::query(
            "INSERT INTO bookkeeping_mmbak_options(id, auto_import_enabled) VALUES (1, 1) \
             ON CONFLICT(id) DO UPDATE SET auto_import_enabled = 1",
        )
        .execute(&db)
        .await
        .expect("enable");
        let in_flight = new_mmbak_auto_import_in_flight();

        // (a) 이전 임포트가 아직 도는 상황을 시뮬레이션: 플래그 선점.
        in_flight.store(true, Ordering::Release);
        let skipped = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:00", &in_flight)
            .await
            .expect("tick");
        assert!(skipped.is_none(), "in-flight 중엔 spawn 없음");
        let o = get_bookkeeping_mmbak_options_inner(&db)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(
            o.last_auto_import_at, None,
            "skip 시 stamp도 없음(다음 tick 재평가)"
        );

        // 해제 후에는 정상 spawn.
        in_flight.store(false, Ordering::Release);
        let handle = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:00", &in_flight)
            .await
            .expect("tick")
            .expect("spawned after release");
        handle.await.expect("spawned task");
        assert!(!in_flight.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn tick_failure_still_sets_gate_and_records_failed_job() {
        let db = pool().await;
        // watch_dir 미설정 + enabled → 임포트는 실패하지만 게이트는 닫히고 failed job이 남는다.
        sqlx::query(
            "INSERT INTO bookkeeping_mmbak_options(id, auto_import_enabled) VALUES (1, 1) \
             ON CONFLICT(id) DO UPDATE SET auto_import_enabled = 1",
        )
        .execute(&db)
        .await
        .expect("enable");
        let in_flight = new_mmbak_auto_import_in_flight();

        let handle = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:00", &in_flight)
            .await
            .expect("tick must not error")
            .expect("spawned");
        handle.await.expect("spawned task must not panic");

        let o = get_bookkeeping_mmbak_options_inner(&db)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(
            o.last_auto_import_at.as_deref(),
            Some("2026-07-02 12:00:00")
        );

        let job: (String, Option<String>) = sqlx::query_as(
            "SELECT status, sanitized_error_code FROM bookkeeping_sync_jobs \
             WHERE source = 'moneymanager' ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_one(&db)
        .await
        .expect("failed job recorded");
        assert_eq!(job.0, "failed");
        assert_eq!(job.1.as_deref(), Some("mmbak.auto_import_failed"));

        // 실패 직후 다음 tick도 storm 없이 skip.
        let skipped = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:30", &in_flight)
            .await
            .expect("tick");
        assert!(skipped.is_none());
    }

    #[tokio::test]
    async fn tick_disabled_never_attempts() {
        let db = pool().await;
        let in_flight = new_mmbak_auto_import_in_flight();
        let skipped = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:00", &in_flight)
            .await
            .expect("tick");
        // seed 전(row 없음)에도, seed 후 disabled에도 시도하지 않는다.
        assert!(skipped.is_none());
        get_bookkeeping_mmbak_options_inner(&db)
            .await
            .expect("seed");
        let skipped = run_mmbak_auto_import_tick(&db, "2026-07-02 12:00:00", &in_flight)
            .await
            .expect("tick");
        assert!(skipped.is_none());
    }
}
