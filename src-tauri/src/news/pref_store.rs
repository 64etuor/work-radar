//! 소스별 on/off pref. registry()에 없는 소스 행이 DB에 있으면 그냥 무시(미래 호환).
//! DB에 행이 없는 소스는 `NewsSource::default_enabled()`(소스별 코드 기본값)로 합성된다.

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
        // 행 없음 = 소스별 코드 기본값(NewsSource::default_enabled). 범용화: 신규 설치는
        // hn/lobsters만 ON. 기존 설치는 0072가 explicit 행을 심어 구 동작(3개 ON) 보존.
        let enabled = saved.get(&id).copied().unwrap_or(src.default_enabled());
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
    async fn fresh_install_defaults_hn_lobsters_on_geeknews_off() {
        // 신규 설치(빈 news_items → 0072 no-op) = 소스별 코드 기본값.
        let p = pool().await;
        let list = list_available(&p).await.unwrap();
        // registry는 13개 소스.
        assert_eq!(list.len(), 13);
        assert!(list.iter().find(|m| m.id == "hn").unwrap().enabled);
        assert!(list.iter().find(|m| m.id == "lobsters").unwrap().enabled);
        // 범용화: 한국 특화 geeknews는 신규 설치 기본 OFF (설정에서 켤 수 있음).
        assert!(!list.iter().find(|m| m.id == "geeknews").unwrap().enabled);
        // 확장 10개는 0019 마이그레이션에서 enabled=0 시드 → OFF.
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
    async fn legacy_install_seed_preserves_old_defaults() {
        // 기존 설치 시뮬레이션: news_items에 행이 있는 DB에 0072 SQL을 적용하면
        // 구 기본값(3개 ON)이 explicit 행으로 고정된다. 사용자가 끈 소스는 보존.
        let p = pool().await;
        sqlx::query(
            "INSERT INTO news_items (source, external_id, title, url, posted_at, fetched_at) \
             VALUES ('hn', '1', 't', 'https://example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .execute(&p)
        .await
        .unwrap();
        // 사용자가 lobsters를 명시적으로 꺼둔 상태.
        set_enabled(&p, "lobsters", false).await.unwrap();
        sqlx::query(include_str!(
            "../../migrations/0072_news_legacy_default_on.sql"
        ))
        .execute(&p)
        .await
        .unwrap();
        let list = list_available(&p).await.unwrap();
        assert!(list.iter().find(|m| m.id == "hn").unwrap().enabled);
        assert!(
            list.iter().find(|m| m.id == "geeknews").unwrap().enabled,
            "뉴스를 쓰던 기존 설치는 geeknews ON 유지"
        );
        assert!(
            !list.iter().find(|m| m.id == "lobsters").unwrap().enabled,
            "사용자 명시 OFF는 seed가 덮지 않음(ON CONFLICT DO NOTHING)"
        );
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
