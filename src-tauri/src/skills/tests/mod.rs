//! 스킬 모듈 테스트 — 섹션별 서브모듈로 분할(G1-PR1 단순 이동, 행동 불변).
//! 공용 헬퍼/import는 이 mod.rs에, 섹션별 테스트는 각 서브모듈에.

mod installer;
mod recursion;
mod roots;
mod scan;
mod tags;
mod workspace;

// ── 공용 import (서브모듈이 super::* 또는 개별 import로 쓴다) ──
pub(super) use crate::commands::agents::BATCH_ENRICH_PROMPT;
pub(super) use crate::commands::nav::set_config;
pub(super) use crate::commands::shared::test_support::fresh_db;
pub(super) use crate::db::Db;
pub(super) use crate::error::AppError;
pub(super) use crate::models::{Provider, Repo, Skill, SkillProvider, UserSkillRoot};
pub(super) use crate::skills::registry::*;
pub(super) use crate::skills::scan::*;
pub(super) use crate::skills::seed::*;
pub(super) use crate::skills::tags::*;
pub(super) use std::path::PathBuf;
pub(super) use tempfile::TempDir;

/// tempdir 루트에 `<root>/<dir>/SKILL.md`를 frontmatter와 함께 만든다(hermetic 헬퍼).
pub(super) fn make_skill(root: &std::path::Path, dir: &str, frontmatter: &str) {
    let d = root.join(dir);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("SKILL.md"), frontmatter).unwrap();
}

// ── 테스트 코어(State 래퍼 없이 직접 호출) ──
pub(super) async fn create_skill_core(
    db: &Db,
    name: &str,
    prompt: &str,
    binding: Option<&str>,
) -> Result<Skill, String> {
    if let Some(b) = binding {
        if fallback_prompt(b).is_none() {
            return Err(format!("알 수 없는 binding '{b}'"));
        }
    }
    let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query_as::<_, Skill>(
        "INSERT INTO skills (id, name, kind, prompt, binding, rail, enabled) \
         VALUES (?1, ?2, 'in_app_prompt', ?3, ?4, 'suggestion', 1) \
         RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
    )
    .bind(&id.0)
    .bind(name)
    .bind(prompt)
    .bind(binding)
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())
}

pub(super) async fn update_skill_core(
    db: &Db,
    id: &str,
    prompt: Option<&str>,
    name: Option<&str>,
    enabled: Option<bool>,
) -> Result<Skill, String> {
    if id.starts_with("ext:") {
        return Err("외부 스킬은 수정 불가".into());
    }
    sqlx::query_as::<_, Skill>(
        "UPDATE skills SET prompt = COALESCE(?2, prompt), name = COALESCE(?3, name), \
            enabled = COALESCE(?4, enabled), updated_at = datetime('now') \
         WHERE id = ?1 AND kind = 'in_app_prompt' \
         RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
    )
    .bind(id)
    .bind(prompt)
    .bind(name)
    .bind(enabled)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "없음".to_string())
}

pub(super) async fn delete_skill_core(db: &Db, id: &str) -> Result<(), String> {
    if id.starts_with("ext:") {
        return Err("외부 스킬은 삭제 불가".into());
    }
    let res = sqlx::query("DELETE FROM skills WHERE id = ?1 AND kind = 'in_app_prompt'")
        .bind(id)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    if res.rows_affected() == 0 {
        return Err("없음".into());
    }
    // 명령 경로와 동일하게 태그도 정리(orphan 방지).
    let _ = sqlx::query("DELETE FROM skill_tags WHERE skill_key = ?1")
        .bind(id)
        .execute(db)
        .await;
    Ok(())
}

/// 커맨드 본문과 동일 경로(normalize → serialize → set_config)로 영속하는 테스트 헬퍼(State 없이).
pub(super) async fn set_user_roots_core(
    db: &Db,
    roots: Vec<UserSkillRoot>,
) -> Result<(), AppError> {
    let cleaned = normalize_user_skill_roots(roots)?;
    let json = serde_json::to_string(&cleaned).unwrap();
    set_config(db, KEY_USER_SKILL_ROOTS, &json)
        .await
        .map_err(AppError::from)
}

pub(super) fn root(path: &str) -> UserSkillRoot {
    UserSkillRoot {
        path: path.to_string(),
    }
}
