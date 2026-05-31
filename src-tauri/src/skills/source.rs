//! 네트워크 설치 managed 스킬의 provenance(`skill_source` 표, G1.5-PR1, ADR-0006 레일 ③/④).
//!
//! managed 스킬 콘텐츠는 디스크(skills-library)가 SSOT이고, 이 표는 그 위의 관리 메타데이터
//! (출처 URL/ref/commit + per-skill auto-update opt-in + staging 상태)다. 순수 DB 접근 —
//! 네트워크/시크릿 비취급. `audit_log`와 동일하게 `&SqlitePool`로 동작(앱 핸들 비의존 → hermetic 테스트).
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use crate::error::AppError;

/// provenance 1행 읽기 모델. specta는 i64(BigInt) export 금지 → id는 i32(audit_log·PendingWrite 관례).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub id: i32,
    pub provider: String,
    pub name: String,
    pub source_url: String,
    pub source_ref: Option<String>,
    pub subpath: Option<String>,
    pub installed_commit: String,
    pub auto_update: bool,
    pub staged_commit: Option<String>,
    pub last_checked_at: Option<String>,
}

/// provenance 행 upsert 파라미터.
pub struct NewSkillSource<'a> {
    pub provider: &'a str,
    pub name: &'a str,
    pub source_url: &'a str,
    pub source_ref: Option<&'a str>,
    pub subpath: Option<&'a str>,
    pub installed_commit: &'a str,
}

/// `(provider, name)` 키로 provenance 행 upsert. `auto_update`는 보존(재설치가 opt-in을 끄지 않음).
/// 재설치 시 staged_commit은 무효화(새 콘텐츠 기준).
pub(crate) async fn upsert_skill_source(
    pool: &SqlitePool,
    s: NewSkillSource<'_>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO skill_source \
            (provider, name, source_url, source_ref, subpath, installed_commit, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, datetime('now')) \
         ON CONFLICT(provider, name) DO UPDATE SET \
            source_url = excluded.source_url, \
            source_ref = excluded.source_ref, \
            subpath = excluded.subpath, \
            installed_commit = excluded.installed_commit, \
            staged_commit = NULL, \
            updated_at = datetime('now')",
    )
    .bind(s.provider)
    .bind(s.name)
    .bind(s.source_url)
    .bind(s.source_ref)
    .bind(s.subpath)
    .bind(s.installed_commit)
    .execute(pool)
    .await?;
    Ok(())
}

/// `(provider, name)` provenance 행 조회(없으면 None). G1.5-PR3 updater(apply)가 프로덕션 첫 호출자.
pub(crate) async fn get_skill_source(
    pool: &SqlitePool,
    provider: &str,
    name: &str,
) -> Result<Option<SkillSource>, AppError> {
    let row = sqlx::query_as::<
        _,
        (
            i32,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            i64,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT id, provider, name, source_url, source_ref, subpath, installed_commit, \
                auto_update, staged_commit, last_checked_at \
         FROM skill_source WHERE provider = ? AND name = ?",
    )
    .bind(provider)
    .bind(name)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| SkillSource {
        id: r.0,
        provider: r.1,
        name: r.2,
        source_url: r.3,
        source_ref: r.4,
        subpath: r.5,
        installed_commit: r.6,
        auto_update: r.7 != 0,
        staged_commit: r.8,
        last_checked_at: r.9,
    }))
}

/// 모든 provenance 행의 `(provider, name)` 키. 복원 후 고아 행 화해(reconcile)에 쓴다.
pub(crate) async fn all_skill_source_keys(
    pool: &SqlitePool,
) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query_as::<_, (String, String)>("SELECT provider, name FROM skill_source")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// `(provider, name)` provenance 행 삭제(복원으로 사라진 managed 스킬의 고아 메타 정리).
pub(crate) async fn delete_skill_source(
    pool: &SqlitePool,
    provider: &str,
    name: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM skill_source WHERE provider = ? AND name = ?")
        .bind(provider)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// per-skill auto-update opt-in 토글(G1.5-PR3).
pub(crate) async fn set_auto_update(
    pool: &SqlitePool,
    provider: &str,
    name: &str,
    enabled: bool,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE skill_source SET auto_update = ?, updated_at = datetime('now') \
         WHERE provider = ? AND name = ?",
    )
    .bind(enabled as i32)
    .bind(provider)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}

/// 업데이트 확인 결과 기록: staged_commit(None=최신/비움, Some=새 버전 staging) + last_checked_at.
pub(crate) async fn record_update_check(
    pool: &SqlitePool,
    provider: &str,
    name: &str,
    staged: Option<&str>,
    checked_at: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE skill_source SET staged_commit = ?, last_checked_at = ?, updated_at = datetime('now') \
         WHERE provider = ? AND name = ?",
    )
    .bind(staged)
    .bind(checked_at)
    .bind(provider)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}

/// apply: installed_commit를 새 값으로 승격 + staged_commit 비움.
pub(crate) async fn promote_staged_commit(
    pool: &SqlitePool,
    provider: &str,
    name: &str,
    new_installed: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE skill_source SET installed_commit = ?, staged_commit = NULL, updated_at = datetime('now') \
         WHERE provider = ? AND name = ?",
    )
    .bind(new_installed)
    .bind(provider)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}

/// auto_update=1인 (provider, name) 키(on-launch 대상).
pub(crate) async fn auto_update_keys(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT provider, name FROM skill_source WHERE auto_update = 1 ORDER BY provider, name",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// 모든 provenance 행(상태 표시 + check-all 대상). `get_skill_source`의 select 컬럼/매핑을 재사용.
pub(crate) async fn list_all_sources(pool: &SqlitePool) -> Result<Vec<SkillSource>, AppError> {
    let rows = sqlx::query_as::<
        _,
        (
            i32,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            i64,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT id, provider, name, source_url, source_ref, subpath, installed_commit, \
                auto_update, staged_commit, last_checked_at FROM skill_source \
         ORDER BY provider, name",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| SkillSource {
            id: r.0,
            provider: r.1,
            name: r.2,
            source_url: r.3,
            source_ref: r.4,
            subpath: r.5,
            installed_commit: r.6,
            auto_update: r.7 != 0,
            staged_commit: r.8,
            last_checked_at: r.9,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    async fn seed(pool: &SqlitePool, name: &str, commit: &str) {
        upsert_skill_source(
            pool,
            NewSkillSource {
                provider: "claude",
                name,
                source_url: "github.com/o/r",
                source_ref: None,
                subpath: None,
                installed_commit: commit,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn auto_update_toggle_and_keys() {
        let pool = fresh_db().await;
        seed(&pool, "foo", "c1").await;
        seed(&pool, "bar", "c1").await;
        set_auto_update(&pool, "claude", "foo", true).await.unwrap();
        let keys = auto_update_keys(&pool).await.unwrap();
        assert_eq!(keys, vec![("claude".to_string(), "foo".to_string())]); // bar opt-out
        set_auto_update(&pool, "claude", "foo", false)
            .await
            .unwrap();
        assert!(auto_update_keys(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn record_check_then_promote() {
        let pool = fresh_db().await;
        seed(&pool, "foo", "c1").await;
        record_update_check(&pool, "claude", "foo", Some("c2"), "2026-06-01T00:00:00Z")
            .await
            .unwrap();
        let s = get_skill_source(&pool, "claude", "foo")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(s.staged_commit.as_deref(), Some("c2"));
        assert_eq!(s.last_checked_at.as_deref(), Some("2026-06-01T00:00:00Z"));
        assert_eq!(s.installed_commit, "c1"); // 아직 적용 전

        promote_staged_commit(&pool, "claude", "foo", "c2")
            .await
            .unwrap();
        let s = get_skill_source(&pool, "claude", "foo")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(s.installed_commit, "c2"); // 승격됨
        assert_eq!(s.staged_commit, None); // staging 비움

        // "최신" 확인(같은 commit) → staged None 기록.
        record_update_check(&pool, "claude", "foo", None, "2026-06-01T01:00:00Z")
            .await
            .unwrap();
        let s = get_skill_source(&pool, "claude", "foo")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(s.staged_commit, None);
        assert_eq!(s.last_checked_at.as_deref(), Some("2026-06-01T01:00:00Z"));
    }

    #[tokio::test]
    async fn list_all_sources_returns_rows() {
        let pool = fresh_db().await;
        seed(&pool, "foo", "c1").await;
        seed(&pool, "bar", "c1").await;
        let all = list_all_sources(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
    }
}
