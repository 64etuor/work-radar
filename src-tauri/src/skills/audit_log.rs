//! 스킬 매니저 감사 로그(G1, ADR-0006 레일 ①). append-only. detail은 비밀-free.
//!
//! 중앙 라이브러리(PR3+)에 대한 모든 쓰기(import/remove/…)는 가역·감사 가능해야 한다. 이 모듈은
//! 그 감사 substrate다: `audit()`가 쓰기 1건을 append-only로 기록하고, `list_skill_audit`가 최근
//! 먼저 읽는다. 호출자는 `target_ref`/`source_ref`/`detail`에 **시크릿/PII를 넣지 않는다**(경로·action·
//! 크기만). 자동 실행/적용과 무관 — 단순 기록이라 결정 레일을 건드리지 않는다(INVARIANT #1).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::db::Db;

/// 감사 로그 1행. snake_case 컬럼은 `sqlx::FromRow`가 필드명으로 매핑하고, 프런트로는
/// `serde(rename_all = "camelCase")`로 직렬화한다(`Skill`과 동일 관례).
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SkillAuditEntry {
    // specta는 i64(BigInt) export를 금지한다(정밀도 손실 가드). DB는 INTEGER PK AUTOINCREMENT지만
    // 프런트 노출 id는 i32로 매핑한다 — `PendingWrite.id`(pending_calendar_writes)와 동일 관례.
    pub id: i32,
    pub action: String,
    pub target_kind: String,
    pub target_ref: String,
    pub source_ref: Option<String>,
    pub detail: Option<String>,
    pub created_at: String,
}

/// 중앙 스토어 쓰기 1건 기록. 호출자는 target_ref/source_ref/detail에 **시크릿/PII 금지**.
/// append-only: UPDATE/DELETE 경로 없음. created_at은 DB 기본값(`datetime('now')`).
// PR3(import_external_skill/remove_managed_skill)가 첫 호출자 — substrate를 먼저 랜딩하는 plan 순서상
// PR2 프로덕션 빌드에선 아직 미사용. 테스트에선 사용하므로 not(test)에서만 dead_code 허용(scan/seed 관례).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn audit(
    pool: &SqlitePool,
    action: &str,
    target_kind: &str,
    target_ref: &str,
    source_ref: Option<&str>,
    detail: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO skill_audit_log (action, target_kind, target_ref, source_ref, detail) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(action)
    .bind(target_kind)
    .bind(target_ref)
    .bind(source_ref)
    .bind(detail)
    .execute(pool)
    .await?;
    Ok(())
}

/// 최근 먼저(created_at DESC, 동시각 tie-break은 id DESC).
pub(crate) async fn list_skill_audit_core(
    pool: &SqlitePool,
) -> Result<Vec<SkillAuditEntry>, AppError> {
    let rows = sqlx::query_as::<_, SkillAuditEntry>(
        "SELECT id, action, target_kind, target_ref, source_ref, detail, created_at \
         FROM skill_audit_log ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[tauri::command]
#[specta::specta]
pub async fn list_skill_audit(db: State<'_, Db>) -> Result<Vec<SkillAuditEntry>, AppError> {
    list_skill_audit_core(db.inner()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn audit_appends_and_lists_newest_first() {
        let pool = fresh_db().await; // hermetic: tempdir db with migrations applied
        audit(
            &pool,
            "import",
            "managed_skill",
            "/lib/claude/foo",
            Some("/home/.claude/skills/foo"),
            Some("files=2,bytes=10"),
        )
        .await
        .expect("audit import");
        audit(
            &pool,
            "remove",
            "managed_skill",
            "/lib/claude/foo",
            None,
            None,
        )
        .await
        .expect("audit remove");
        let rows = list_skill_audit_core(&pool).await.expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, "remove"); // newest first
        assert_eq!(rows[1].action, "import");
        assert_eq!(
            rows[1].source_ref.as_deref(),
            Some("/home/.claude/skills/foo")
        );
    }

    #[tokio::test]
    async fn audit_detail_carries_no_secret_body() {
        // detail은 호출자가 비밀-free로 구성한다는 계약을 문서화/잠그는 가드.
        let pool = fresh_db().await;
        audit(
            &pool,
            "import",
            "managed_skill",
            "/lib/x",
            None,
            Some("files=1,bytes=5"),
        )
        .await
        .unwrap();
        let rows = list_skill_audit_core(&pool).await.unwrap();
        assert!(!rows[0].detail.as_deref().unwrap_or("").contains("SKILL"));
    }
}
