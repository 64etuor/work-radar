//! 키워드 필터 CRUD. include/exclude 모드별 행.
//! 빈 keyword는 validation error로 거부.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::Db;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FilterMode {
    Include,
    Exclude,
}

impl FilterMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Include => "include",
            Self::Exclude => "exclude",
        }
    }
    fn parse(s: &str) -> Self {
        if s == "exclude" {
            Self::Exclude
        } else {
            Self::Include
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeywordFilter {
    pub id: i32,
    pub keyword: String,
    pub mode: FilterMode,
}

pub async fn list(db: &Db) -> Result<Vec<KeywordFilter>, AppError> {
    let rows: Vec<(i32, String, String)> =
        sqlx::query_as("SELECT id, keyword, mode FROM news_keyword_filters ORDER BY id")
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, keyword, mode)| KeywordFilter {
            id,
            keyword,
            mode: FilterMode::parse(&mode),
        })
        .collect())
}

pub async fn add(db: &Db, keyword: &str, mode: FilterMode) -> Result<KeywordFilter, AppError> {
    let kw = keyword.trim();
    if kw.is_empty() {
        return Err(AppError::validation("news.filter.empty", "빈 키워드"));
    }
    // 중복(=같은 keyword/mode) 시도는 그냥 통과(idempotent).
    sqlx::query(
        "INSERT INTO news_keyword_filters(keyword, mode) VALUES (?, ?) \
         ON CONFLICT(keyword, mode) DO NOTHING",
    )
    .bind(kw)
    .bind(mode.as_str())
    .execute(db)
    .await?;
    let row: (i32,) =
        sqlx::query_as("SELECT id FROM news_keyword_filters WHERE keyword = ? AND mode = ?")
            .bind(kw)
            .bind(mode.as_str())
            .fetch_one(db)
            .await?;
    Ok(KeywordFilter {
        id: row.0,
        keyword: kw.to_string(),
        mode,
    })
}

pub async fn remove(db: &Db, id: i32) -> Result<(), AppError> {
    sqlx::query("DELETE FROM news_keyword_filters WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
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
    async fn add_list_remove_roundtrip() {
        let p = pool().await;
        let a = add(&p, "AI", FilterMode::Include).await.unwrap();
        let b = add(&p, "crypto", FilterMode::Exclude).await.unwrap();
        let rows = list(&p).await.unwrap();
        assert_eq!(rows.len(), 2);
        remove(&p, a.id).await.unwrap();
        let rows = list(&p).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, b.id);
    }

    #[tokio::test]
    async fn add_dedup_returns_existing_row() {
        let p = pool().await;
        let a = add(&p, "AI", FilterMode::Include).await.unwrap();
        let b = add(&p, "AI", FilterMode::Include).await.unwrap();
        assert_eq!(a.id, b.id, "같은 (keyword, mode)는 같은 row");
        assert_eq!(list(&p).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn add_empty_keyword_validation_err() {
        let p = pool().await;
        assert!(add(&p, "   ", FilterMode::Include).await.is_err());
    }

    #[tokio::test]
    async fn add_trims_whitespace() {
        let p = pool().await;
        let a = add(&p, "  AI  ", FilterMode::Include).await.unwrap();
        assert_eq!(a.keyword, "AI");
    }
}
