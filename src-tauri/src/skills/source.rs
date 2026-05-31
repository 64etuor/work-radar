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

/// `(provider, name)` provenance 행 조회(없으면 None).
#[cfg_attr(not(test), allow(dead_code))] // G1.5-PR3(updater)가 프로덕션 첫 호출자. PR1은 테스트에서 사용.
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
