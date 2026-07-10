//! 앱 기본 통화 설정 IPC (app_config `bookkeeping.default_currency`).
//!
//! 범용화: KRW 하드코딩을 설정으로 대체한다. 미설정 시 `DEFAULT_CURRENCY`(KRW)로
//! 기존 동작을 보존한다. 값은 3자리 ISO 4217 코드만 허용(`clean_currency` 검증 공유).

use tauri::State;

use super::common::{clean_currency, default_currency, DEFAULT_CURRENCY, KEY_DEFAULT_CURRENCY};
use crate::commands::nav::set_config;
use crate::db::Db;
use crate::error::AppError;

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_default_currency(db: State<'_, Db>) -> Result<String, AppError> {
    Ok(default_currency(db.inner()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn set_bookkeeping_default_currency(
    db: State<'_, Db>,
    currency: String,
) -> Result<String, AppError> {
    let cleaned = clean_currency(&currency, DEFAULT_CURRENCY)?;
    set_config(db.inner(), KEY_DEFAULT_CURRENCY, &cleaned).await?;
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::super::common::default_currency;
    use crate::commands::nav::set_config;
    use crate::db::init_db;

    fn temp_db_path() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("work-radar-currency-test-{nanos}-{seq}.db"))
    }

    #[tokio::test]
    async fn default_currency_falls_back_to_krw_and_honors_config() {
        let db = init_db(&temp_db_path()).await.expect("init db");
        // 미설정 = KRW (기존 동작 보존).
        assert_eq!(default_currency(&db).await, "KRW");
        // 설정 반영.
        set_config(&db, super::super::common::KEY_DEFAULT_CURRENCY, "usd")
            .await
            .expect("set config");
        // 저장값은 그대로여도 조회 시 정규화(대문자) 적용.
        assert_eq!(default_currency(&db).await, "USD");
        // 불량 값은 KRW로 fail-closed.
        set_config(
            &db,
            super::super::common::KEY_DEFAULT_CURRENCY,
            "not-a-code",
        )
        .await
        .expect("set config");
        assert_eq!(default_currency(&db).await, "KRW");
    }
}
