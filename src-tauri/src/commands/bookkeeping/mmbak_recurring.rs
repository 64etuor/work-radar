//! MoneyManager REPEATTRANSACTION → 앱 고정비(`bookkeeping_recurring_expenses`) 미러링.
//!
//! **소유권 계약(백업이 정본):**
//! - 백업이 이기는 필드 — `name` / `merchant` / `amount_minor` / `currency` / `category` /
//!   `schedule_day` / `end_month`. 매 임포트마다 백업 값으로 덮는다.
//! - 앱이 소유하는 필드 — `project_id` / `expense_kind` / `payment_method_*` / `note` /
//!   `start_month`. 백업에 대응물이 없거나(kind·note), 재파생하면 과거가 사라진다
//!   (`start_month`는 USETIME 파생인데 MM에서 규칙을 고치면 USETIME이 앞으로 밀린다).
//!   전부 **최초 삽입 시에만** 기록한다.
//! - `status` — 백업의 삭제 표시(IS_DEL)만 미러한다: 삭제 → `archived`, 삭제 해제 →
//!   `archived`였던 것만 `active`로 복구. `paused`는 MM에 대응물이 없는 앱 판단이라 보존한다.
//!
//! 앱에서 직접 만든 고정비(`source='manual'`)는 이 동기화가 절대 건드리지 않는다 —
//! 모든 문장이 `source='moneymanager'`로 스코프된다.

use std::collections::HashMap;

use crate::db::Db;
use crate::error::AppError;
use crate::moneymanager::{map_repeats, MmAsset, MmCategory, MmCurrency, MmRepeatRow};

/// 고정비 미러링 1회의 집계.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct MmRecurringSyncCounts {
    /// 새로 만들어졌거나 백업 값으로 갱신된 규칙 수.
    pub(crate) upserted: u32,
    /// 백업에서 삭제 표시돼 archived로 바뀐 규칙 수.
    pub(crate) archived: u32,
    /// 고정비로 매핑하지 않은 규칙 수(수입 반복·이체·월 아닌 주기·불량 금액).
    pub(crate) skipped: u32,
}

/// REPEATTRANSACTION 전체를 고정비로 미러링한다. 커서 없이 매번 full-scan —
/// 규칙은 수십 건 규모이고, 그래야 "백업이 정본"이 성립한다.
pub(crate) async fn sync_mm_recurring(
    db: &Db,
    project_id: Option<&str>,
    rows: &[MmRepeatRow],
    categories: &HashMap<String, MmCategory>,
    assets: &HashMap<String, MmAsset>,
    currencies: &HashMap<String, MmCurrency>,
) -> Result<MmRecurringSyncCounts, AppError> {
    let mapped = map_repeats(rows, categories, assets, currencies);
    let mut counts = MmRecurringSyncCounts {
        skipped: mapped.skipped.len() as u32,
        ..MmRecurringSyncCounts::default()
    };

    for rule in &mapped.recurring {
        // 범위 재확인이 없는 이유: `amount_minor`(i32)와 `schedule_day`(u32, day-of-month)는
        // 매핑 단계에서 이미 스키마 CHECK 범위로 좁혀져 나온다.
        let schedule_day = i64::from(rule.schedule_day);

        // 1) 원자적 신규 삽입. 앱 소유 필드(project_id·expense_kind·결제수단·start_month)는
        //    여기서만 기록된다. 이미 있으면 DO NOTHING → rows_affected 0.
        let inserted = sqlx::query(
            "INSERT INTO bookkeeping_recurring_expenses \
             (id, project_id, name, merchant, amount_minor, currency, category, \
              payment_method_kind, payment_method_label, payment_method_last4, expense_kind, \
              schedule_day, start_month, end_month, status, note, source, source_ref) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, \
                     'unknown', ?7, NULL, 'fixed', ?8, ?9, ?10, 'active', NULL, \
                     'moneymanager', ?11) \
             ON CONFLICT(source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING",
        )
        .bind(project_id)
        .bind(&rule.name)
        .bind(rule.merchant.as_deref())
        .bind(rule.amount_minor)
        .bind(&rule.currency)
        .bind(&rule.category_label)
        .bind(rule.account.as_deref())
        .bind(schedule_day)
        .bind(&rule.start_month)
        .bind(rule.end_month.as_deref())
        .bind(&rule.source_ref)
        .execute(db)
        .await?;
        if inserted.rows_affected() > 0 {
            counts.upserted += 1;
            continue;
        }

        // 2) 이미 있는 규칙 → 백업 소유 필드만 갱신. WHERE의 diff 가드가 없으면 변경이
        //    없어도 매 임포트마다 updated_at이 튄다(무의미한 churn).
        //    `IS NOT`는 NULL-safe 비교 — end_month/merchant가 NULL이어도 정확히 판정한다.
        let updated = sqlx::query(
            "UPDATE bookkeeping_recurring_expenses SET \
               name = ?2, merchant = ?3, amount_minor = ?4, currency = ?5, category = ?6, \
               schedule_day = ?7, end_month = ?8, \
               status = CASE WHEN status = 'archived' THEN 'active' ELSE status END, \
               updated_at = datetime('now') \
             WHERE source = 'moneymanager' AND source_ref = ?1 \
               AND (name IS NOT ?2 OR merchant IS NOT ?3 OR amount_minor IS NOT ?4 \
                    OR currency IS NOT ?5 OR category IS NOT ?6 OR schedule_day IS NOT ?7 \
                    OR end_month IS NOT ?8 OR status = 'archived')",
        )
        .bind(&rule.source_ref)
        .bind(&rule.name)
        .bind(rule.merchant.as_deref())
        .bind(rule.amount_minor)
        .bind(&rule.currency)
        .bind(&rule.category_label)
        .bind(schedule_day)
        .bind(rule.end_month.as_deref())
        .execute(db)
        .await?;
        if updated.rows_affected() > 0 {
            counts.upserted += 1;
        }
    }

    // 백업에서 삭제된 규칙 → archived 미러. 이미 archived면 no-op(멱등).
    for uid in &mapped.deleted_uids {
        let archived = sqlx::query(
            "UPDATE bookkeeping_recurring_expenses \
             SET status = 'archived', updated_at = datetime('now') \
             WHERE source = 'moneymanager' AND source_ref = ?1 AND status <> 'archived'",
        )
        .bind(uid)
        .execute(db)
        .await?;
        if archived.rows_affected() > 0 {
            counts.archived += 1;
        }
    }

    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        BookkeepingExpenseKind, BookkeepingPaymentMethodKind, BookkeepingRecurringExpense,
        BookkeepingRecurringExpenseStatus, BookkeepingSource,
        CreateBookkeepingRecurringExpenseInput,
    };
    use crate::moneymanager::{
        MoneyManagerBackup, REPEAT_TRANSACTION_COLUMNS, REPEAT_TRANSACTION_DDL,
    };
    use chrono::TimeZone;
    use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};

    // 이 모듈 본체는 부모의 공유 헬퍼를 쓰지 않는다(Db/AppError를 직접 import) — 테스트만
    // 필요하므로 모듈 레벨 `use super::*` 대신 여기서 명시적으로 가져온다.
    use super::super::{
        create_bookkeeping_recurring_expense_inner, RECURRING_EXPENSE_RETURNING_COLUMNS,
    };

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

    fn kst_millis(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
        chrono_tz::Asia::Seoul
            .with_ymd_and_hms(y, mo, d, h, mi, s)
            .single()
            .expect("kst datetime")
            .timestamp_millis()
    }

    /// REPEATTRANSACTION 픽스처 파일 + 부속 마스터 테이블.
    async fn fixture(dir: &tempfile::TempDir, repeat_rows: &[String]) -> std::path::PathBuf {
        let path = dir.path().join("backup.mmbak");
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&opts).await.expect("open");
        for ddl in [
            "CREATE TABLE ZCATEGORY (uid TEXT, NAME TEXT, TYPE INTEGER, pUid TEXT, \
             C_IS_DEL INTEGER, STATUS INTEGER)",
            "CREATE TABLE ASSETS (uid TEXT, NIC_NAME TEXT, groupUid TEXT)",
            "CREATE TABLE CURRENCY (uid TEXT, ISO TEXT, DECIMAL_POINT INTEGER)",
            REPEAT_TRANSACTION_DDL,
        ] {
            sqlx::query(ddl).execute(&mut conn).await.expect("ddl");
        }
        for seed in [
            "INSERT INTO ZCATEGORY VALUES ('30','보험',1,'0',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('36','주거/통신',1,'0',0,0)",
            "INSERT INTO ASSETS VALUES ('a1','기업은행','g1')",
            "INSERT INTO CURRENCY VALUES ('KRW_KRW','KRW',0)",
        ] {
            sqlx::query(seed).execute(&mut conn).await.expect("seed");
        }
        for sql in repeat_rows {
            sqlx::query(sql).execute(&mut conn).await.expect("repeat");
        }
        conn.close().await.expect("close");
        path
    }

    /// 기본 픽스처 행: 주택청약 100,000원 / 22일 / 무기한.
    fn cheongyak_row(amount: f64, is_del: i64, end_date_ms: i64) -> String {
        let usetime = kst_millis(2026, 6, 23, 13, 49, 21);
        let next = kst_millis(2026, 7, 22, 18, 53, 57);
        format!(
            "INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES \
             ('rep-1',{is_del},{usetime},0,{end_date_ms},{next},1,1,'a1','','36','KRW_KRW',\
              {amount},'주택청약','청약(49)')"
        )
    }

    async fn load(path: &std::path::Path) -> LoadedRepeats {
        let mut backup = MoneyManagerBackup::open_read_only(path)
            .await
            .expect("open read-only");
        let rows = backup.load_repeat_transactions().await.expect("repeats");
        let categories = backup.load_categories().await.expect("categories");
        let assets = backup.load_assets().await.expect("assets");
        let currencies = backup.load_currencies().await.expect("currencies");
        backup.close().await.expect("close");
        LoadedRepeats {
            rows,
            categories,
            assets,
            currencies,
        }
    }

    struct LoadedRepeats {
        rows: Vec<MmRepeatRow>,
        categories: HashMap<String, MmCategory>,
        assets: HashMap<String, MmAsset>,
        currencies: HashMap<String, MmCurrency>,
    }

    async fn sync(db: &Db, loaded: &LoadedRepeats) -> MmRecurringSyncCounts {
        sync_mm_recurring(
            db,
            None,
            &loaded.rows,
            &loaded.categories,
            &loaded.assets,
            &loaded.currencies,
        )
        .await
        .expect("sync")
    }

    async fn rules(db: &Db) -> Vec<BookkeepingRecurringExpense> {
        sqlx::query_as::<_, BookkeepingRecurringExpense>(&format!(
            "SELECT {RECURRING_EXPENSE_RETURNING_COLUMNS} FROM bookkeeping_recurring_expenses \
             ORDER BY name ASC"
        ))
        .fetch_all(db)
        .await
        .expect("rules")
    }

    #[tokio::test]
    async fn first_sync_creates_rule_from_backup() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture(&dir, &[cheongyak_row(100_000.0, 0, 0)]).await;

        let counts = sync(&db, &load(&path).await).await;
        assert_eq!(counts.upserted, 1);
        assert_eq!(counts.archived, 0);
        assert_eq!(counts.skipped, 0);

        let rules = rules(&db).await;
        assert_eq!(rules.len(), 1);
        let rule = &rules[0];
        assert_eq!(rule.source, BookkeepingSource::MoneyManager);
        assert_eq!(rule.source_ref.as_deref(), Some("rep-1"));
        assert_eq!(rule.name, "주택청약");
        assert_eq!(rule.merchant.as_deref(), Some("청약(49)"));
        assert_eq!(rule.amount_minor, 100_000);
        assert_eq!(rule.category, "주거/통신");
        assert_eq!(rule.schedule_day, 22);
        assert_eq!(rule.start_month, "2026-06");
        assert_eq!(rule.end_month, None);
        assert_eq!(rule.status, BookkeepingRecurringExpenseStatus::Active);
        assert_eq!(rule.expense_kind, BookkeepingExpenseKind::Fixed);
        // 결제수단 라벨은 자산 별명, 종류는 사람이 정한다.
        assert_eq!(rule.payment_method_label.as_deref(), Some("기업은행"));
        assert_eq!(
            rule.payment_method_kind,
            BookkeepingPaymentMethodKind::Unknown
        );
    }

    #[tokio::test]
    async fn resync_is_idempotent_when_backup_unchanged() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture(&dir, &[cheongyak_row(100_000.0, 0, 0)]).await;

        let loaded = load(&path).await;
        assert_eq!(sync(&db, &loaded).await.upserted, 1);
        let before = rules(&db).await[0].updated_at.clone();

        // 변경 없는 재동기화 → 갱신 카운트 0, updated_at도 그대로(diff 가드).
        let second = sync(&db, &loaded).await;
        assert_eq!(second.upserted, 0);
        let after = rules(&db).await;
        assert_eq!(after.len(), 1, "중복 행 생성 금지");
        assert_eq!(after[0].updated_at, before, "변경 없으면 updated_at 불변");
    }

    #[tokio::test]
    async fn backup_wins_on_amount_and_schedule_but_app_fields_survive() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture(&dir, &[cheongyak_row(100_000.0, 0, 0)]).await;
        sync(&db, &load(&path).await).await;

        // 사용자가 앱 전용 필드를 손본다(결제수단 종류·메모·프로젝트 기본값).
        sqlx::query(
            "UPDATE bookkeeping_recurring_expenses \
             SET payment_method_kind = 'bank_transfer', note = '자동이체', amount_minor = 1 \
             WHERE source_ref = 'rep-1'",
        )
        .execute(&db)
        .await
        .expect("app-side edit");

        // 백업에서 금액이 바뀜 → 금액은 백업이 이기고, 앱 소유 필드는 살아남는다.
        let dir2 = tempfile::tempdir().expect("tempdir2");
        let path = fixture(&dir2, &[cheongyak_row(120_000.0, 0, 0)]).await;
        let counts = sync(&db, &load(&path).await).await;
        assert_eq!(counts.upserted, 1);

        let rule = &rules(&db).await[0];
        assert_eq!(rule.amount_minor, 120_000, "backup-wins: 금액은 백업값");
        assert_eq!(
            rule.payment_method_kind,
            BookkeepingPaymentMethodKind::BankTransfer,
            "앱 소유 필드는 보존"
        );
        assert_eq!(rule.note.as_deref(), Some("자동이체"));
        assert_eq!(
            rule.start_month, "2026-06",
            "start_month는 재파생하지 않는다"
        );
    }

    #[tokio::test]
    async fn deleted_in_backup_archives_and_restore_reactivates() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture(&dir, &[cheongyak_row(100_000.0, 0, 0)]).await;
        sync(&db, &load(&path).await).await;

        // MM에서 삭제 → archived 미러.
        let dir2 = tempfile::tempdir().expect("t2");
        let deleted = fixture(&dir2, &[cheongyak_row(100_000.0, 1, 0)]).await;
        let counts = sync(&db, &load(&deleted).await).await;
        assert_eq!(counts.archived, 1);
        assert_eq!(counts.upserted, 0, "삭제 행은 매핑 대상이 아니다");
        assert_eq!(
            rules(&db).await[0].status,
            BookkeepingRecurringExpenseStatus::Archived
        );

        // 같은 삭제를 다시 봐도 멱등.
        assert_eq!(sync(&db, &load(&deleted).await).await.archived, 0);

        // MM에서 삭제 취소 → active 복구.
        let dir3 = tempfile::tempdir().expect("t3");
        let restored = fixture(&dir3, &[cheongyak_row(100_000.0, 0, 0)]).await;
        assert_eq!(sync(&db, &load(&restored).await).await.upserted, 1);
        assert_eq!(
            rules(&db).await[0].status,
            BookkeepingRecurringExpenseStatus::Active
        );
    }

    #[tokio::test]
    async fn paused_status_is_app_owned_and_never_reactivated() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture(&dir, &[cheongyak_row(100_000.0, 0, 0)]).await;
        sync(&db, &load(&path).await).await;

        sqlx::query("UPDATE bookkeeping_recurring_expenses SET status = 'paused'")
            .execute(&db)
            .await
            .expect("pause");

        // 백업 금액이 바뀌어 UPDATE 경로를 타도 paused는 유지된다(MM엔 pause 개념이 없다).
        let dir2 = tempfile::tempdir().expect("t2");
        let path = fixture(&dir2, &[cheongyak_row(120_000.0, 0, 0)]).await;
        sync(&db, &load(&path).await).await;
        let rule = &rules(&db).await[0];
        assert_eq!(rule.status, BookkeepingRecurringExpenseStatus::Paused);
        assert_eq!(rule.amount_minor, 120_000);
    }

    /// 앱에서 직접 만든 고정비(source='manual', source_ref=NULL).
    async fn create_manual_rule(db: &Db, name: &str) {
        create_bookkeeping_recurring_expense_inner(
            db,
            CreateBookkeepingRecurringExpenseInput {
                project_id: None,
                name: name.to_string(),
                merchant: None,
                amount_minor: 17_000,
                currency: "KRW".to_string(),
                category: "구독".to_string(),
                payment_method_kind: BookkeepingPaymentMethodKind::Card,
                payment_method_label: None,
                payment_method_last4: None,
                expense_kind: BookkeepingExpenseKind::Subscription,
                schedule_day: 5,
                start_month: "2026-01".to_string(),
                end_month: None,
                note: None,
            },
        )
        .await
        .expect("manual rule");
    }

    #[tokio::test]
    async fn manual_rules_are_never_touched() {
        let db = pool().await;
        create_manual_rule(&db, "넷플릭스").await;

        let dir = tempfile::tempdir().expect("tempdir");
        // 백업이 통째로 비어도(모든 규칙 삭제) manual 규칙은 그대로다.
        let path = fixture(&dir, &[cheongyak_row(100_000.0, 1, 0)]).await;
        sync(&db, &load(&path).await).await;

        let rules = rules(&db).await;
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "넷플릭스");
        assert_eq!(rules[0].source, BookkeepingSource::Manual);
        assert_eq!(rules[0].source_ref, None);
        assert_eq!(rules[0].status, BookkeepingRecurringExpenseStatus::Active);
    }

    #[tokio::test]
    async fn manual_rules_do_not_collide_on_null_source_ref() {
        let db = pool().await;
        for name in ["넷플릭스", "왓챠"] {
            create_manual_rule(&db, name).await;
        }
        // 부분 UNIQUE 인덱스(WHERE source_ref IS NOT NULL)라 NULL 여러 개가 공존한다.
        assert_eq!(rules(&db).await.len(), 2);
    }

    #[tokio::test]
    async fn end_date_maps_to_end_month_and_clears_when_removed() {
        let db = pool().await;
        let end = kst_millis(2027, 3, 21, 0, 0, 0);
        let dir1 = tempfile::tempdir().expect("t1");
        let path = fixture(&dir1, &[cheongyak_row(100_000.0, 0, end)]).await;
        sync(&db, &load(&path).await).await;
        assert_eq!(rules(&db).await[0].end_month.as_deref(), Some("2027-03"));

        // MM에서 종료일을 지우면 NULL로 되돌아온다(NULL-safe diff 가드가 잡아낸다).
        let dir2 = tempfile::tempdir().expect("t2");
        let path = fixture(&dir2, &[cheongyak_row(100_000.0, 0, 0)]).await;
        assert_eq!(sync(&db, &load(&path).await).await.upserted, 1);
        assert_eq!(rules(&db).await[0].end_month, None);
    }
}
