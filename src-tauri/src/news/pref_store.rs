//! 소스별 on/off pref. registry()에 없는 소스 행이 DB에 있으면 그냥 무시(미래 호환).
//! 등록 안 된 새 소스가 registry에 추가되면 첫 호출 시 default enabled로 upsert.

use super::{registry, NewsSourceMeta};
use crate::db::Db;
use crate::error::AppError;

/// 등록된 모든 소스 + 현재 enabled 상태. registry 순서 보존.
pub async fn list_available(db: &Db) -> Result<Vec<NewsSourceMeta>, AppError> {
    let saved: std::collections::HashMap<String, bool> =
        sqlx::query_as::<_, (String, i64)>("SELECT source, enabled FROM news_source_pref")
            .fetch_all(db)
            .await?
            .into_iter()
            .map(|(s, e)| (s, e != 0))
            .collect();

    let mut out = Vec::new();
    for src in registry() {
        let id = src.id().to_string();
        let enabled = saved.get(&id).copied().unwrap_or(true); // 기본 ON
        out.push(NewsSourceMeta {
            label: src.label().to_string(),
            id,
            category: src.category(),
            enabled,
        });
    }
    Ok(out)
}

/// upsert one source pref.
pub async fn set_enabled(db: &Db, source: &str, enabled: bool) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO news_source_pref(source, enabled) VALUES (?, ?) \
         ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled",
    )
    .bind(source)
    .bind(if enabled { 1 } else { 0 })
    .execute(db)
    .await?;
    Ok(())
}

/// fetcher가 활성 소스만 페치하도록 — `list_available()`에서 enabled=true만 추출.
pub async fn enabled_ids(db: &Db) -> Result<Vec<String>, AppError> {
    Ok(list_available(db)
        .await?
        .into_iter()
        .filter(|m| m.enabled)
        .map(|m| m.id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let p = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn defaults_existing_three_on_new_off() {
        let p = pool().await;
        let list = list_available(&p).await.unwrap();
        // registry는 이제 13개 소스.
        assert_eq!(list.len(), 13);
        // 기존 3개는 기본 ON(DB에 행 없으면 unwrap_or(true)).
        assert!(list.iter().find(|m| m.id == "hn").unwrap().enabled);
        assert!(list.iter().find(|m| m.id == "geeknews").unwrap().enabled);
        assert!(list.iter().find(|m| m.id == "lobsters").unwrap().enabled);
        // 신규 10개는 0019 마이그레이션에서 enabled=0 시드 → OFF.
        assert!(
            !list
                .iter()
                .find(|m| m.id == "reddit_programming")
                .unwrap()
                .enabled
        );
        assert!(!list.iter().find(|m| m.id == "arxiv_cs_ai").unwrap().enabled);
    }

    #[tokio::test]
    async fn set_then_read_back() {
        let p = pool().await;
        set_enabled(&p, "geeknews", false).await.unwrap();
        let list = list_available(&p).await.unwrap();
        assert!(!list.iter().find(|m| m.id == "geeknews").unwrap().enabled);
        assert!(enabled_ids(&p).await.unwrap().contains(&"hn".to_string()));
        assert!(!enabled_ids(&p)
            .await
            .unwrap()
            .contains(&"geeknews".to_string()));
    }
}
