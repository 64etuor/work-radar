//! 프로젝트 카피 vendoring(G3-PR2b, ADR-0006 레일 ① — 복사) — 중앙 managed 스킬 → 프로젝트 스킬 dir.
//!
//! vendor는 `<repo>/.claude|.codex/skills/<name>`에 중앙 카피를 **복사**한다(심링크 아님 — 커밋·공유
//! 가능). unvendor는 카피가 중앙과 **바이트 동일(InSync)일 때만** 제거한다(사용자 편집 무손실 — 다르면
//! 거부, 해소는 PR2c). 충돌(다른/변경된 dir·심링크)은 덮어쓰지 않는다. 매 쓰기를 `audit()`로 기록한다.
//! **#1/#2 불변**: 파일 복사/제거일 뿐 잡을 spawn하지 않는다. 상태는 디스크에서 유도(표/마이그레이션
//! 없음 — #7). 경로는 표시·매칭 전용 — 로그 금지(C7). 적용 상태/관례는 scan.rs vendor_subdir이 단일 출처.
#![allow(clippy::result_large_err)]

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tauri::State;

use crate::commands::projects::fetch_all_repos;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{Provider, Repo, SkillProvider};
use crate::skills::audit_log::audit;
use crate::skills::central_repo::{
    central_skill_dir, copy_dir_shallow, provider_segment, sanitize_segment,
};
use crate::skills::divergence::trees_equal;
use crate::skills::scan::vendor_subdir;

pub(crate) const CODE_NO_SOURCE: &str = "skills.vendor.no_source";
pub(crate) const CODE_UNSUPPORTED_PROVIDER: &str = "skills.vendor.unsupported_provider";
pub(crate) const CODE_COLLISION: &str = "skills.vendor.collision";
pub(crate) const CODE_DIVERGED: &str = "skills.vendor.diverged";
pub(crate) const CODE_NOT_OURS: &str = "skills.vendor.not_ours";
pub(crate) const CODE_NO_REPO: &str = "skills.vendor.no_repo";

/// core: 중앙 managed 스킬을 프로젝트 스킬 dir에 복사. 앱 핸들 비의존(tempdir hermetic). 반환 = 복사된
/// dir. 이미 InSync 카피면 멱등 no-op(audit 안 함). 심링크/변경된 dir = 충돌 거부(덮어쓰지 않음).
pub(crate) async fn vendor_core(
    pool: &SqlitePool,
    central_root: &Path,
    project_skill_root: &Path,
    provider: SkillProvider,
    name: &str,
) -> Result<PathBuf, AppError> {
    let seg = sanitize_segment(name);
    let src = central_skill_dir(central_root, provider_segment(provider), &seg);
    if !src.join("SKILL.md").is_file() {
        return Err(AppError::not_found(
            CODE_NO_SOURCE,
            "중앙 라이브러리에 해당 스킬이 없습니다.".to_string(),
        ));
    }
    let dst = project_skill_root.join(&seg);
    if let Ok(meta) = std::fs::symlink_metadata(&dst) {
        if meta.file_type().is_symlink() {
            return Err(AppError::terminal(
                CODE_COLLISION,
                "대상 경로가 심링크입니다(덮어쓰지 않음).".to_string(),
            ));
        }
        // 실제 dir: 이미 동일하면 멱등 성공, 다르면 충돌(절대 덮어쓰지 않음).
        if trees_equal(&dst, &src) {
            return Ok(dst);
        }
        return Err(AppError::terminal(
            CODE_COLLISION,
            "대상에 다른/변경된 카피가 이미 있습니다(덮어쓰지 않음).".to_string(),
        ));
    }
    std::fs::create_dir_all(&dst).map_err(|e| {
        AppError::terminal(
            "skills.vendor.mkdir",
            format!("프로젝트 dir 생성 실패: {e}"),
        )
    })?;
    // 중앙 라이브러리는 **구성상 심링크가 없다**: 모든 central 라이터(import_to_central·installer·
    // updater·backup 복원)가 심링크를 건너뛰는 copy_dir_shallow를 거친다. 따라서 카피(copy_dir_shallow는
    // 심링크 스킵)와 InSync 판정(trees_equal은 심링크 타깃 기록)이 항상 일치 → 갓-vendored 카피는 즉시
    // InSync다(unvendor 가역성 보존). 향후 심링크를 보존하는 central 라이터를 추가하면 이 가정을 재검토할 것.
    copy_dir_shallow(&src, &dst)?;
    audit(
        pool,
        "vendor",
        "project_dir",
        &dst.to_string_lossy(),
        Some(&src.to_string_lossy()),
        Some("copy"),
    )
    .await?;
    Ok(dst)
}

/// core: vendored 카피 제거 — **중앙과 InSync일 때만**(사용자 편집 무손실). 부재=멱등 no-op, 심링크=거부
/// (vendored 카피 아님), 중앙 원본 없음=거부(동기화 확인 불가), 다름=거부(해소는 PR2c). 가역(레일 ①).
pub(crate) async fn unvendor_core(
    pool: &SqlitePool,
    central_root: &Path,
    project_skill_root: &Path,
    provider: SkillProvider,
    name: &str,
) -> Result<(), AppError> {
    let seg = sanitize_segment(name);
    let dst = project_skill_root.join(&seg);
    let Ok(meta) = std::fs::symlink_metadata(&dst) else {
        return Ok(()); // 부재 → 멱등 no-op(audit 안 함).
    };
    if meta.file_type().is_symlink() {
        return Err(AppError::terminal(
            CODE_NOT_OURS,
            "대상이 심링크입니다(vendored 카피 아님 — 제거하지 않음).".to_string(),
        ));
    }
    let src = central_skill_dir(central_root, provider_segment(provider), &seg);
    if !src.join("SKILL.md").is_file() {
        return Err(AppError::terminal(
            CODE_NO_SOURCE,
            "중앙 원본이 없어 동기화 여부를 확인할 수 없습니다(제거하지 않음).".to_string(),
        ));
    }
    if !trees_equal(&dst, &src) {
        return Err(AppError::terminal(
            CODE_DIVERGED,
            "카피가 중앙 라이브러리와 달라 제거하지 않습니다(해소는 후속 PR).".to_string(),
        ));
    }
    std::fs::remove_dir_all(&dst)
        .map_err(|e| AppError::terminal("skills.vendor.rmdir", format!("카피 제거 실패: {e}")))?;
    audit(
        pool,
        "unvendor",
        "project_dir",
        &dst.to_string_lossy(),
        Some(&src.to_string_lossy()),
        Some("copy"),
    )
    .await?;
    Ok(())
}

/// repo_id → 프로젝트 vendoring 루트(`<local_path>/<vendor_subdir>`). Local+enabled+비어있지 않은
/// local_path 아니면 no_repo. vendor_subdir 없는 provider면 unsupported_provider. G3-PR2c
/// resolve.rs(diff/pull/push)가 같은 프로젝트 dir 도출에 재사용 → pub(crate).
pub(crate) fn vendorable_repo_root(
    repos: &[Repo],
    repo_id: &str,
    provider: SkillProvider,
) -> Result<PathBuf, AppError> {
    let subdir = vendor_subdir(provider).ok_or_else(|| {
        AppError::validation(
            CODE_UNSUPPORTED_PROVIDER,
            "이 provider는 프로젝트 복사 대상이 아닙니다.".to_string(),
        )
    })?;
    let repo = repos.iter().find(|r| r.id == repo_id).ok_or_else(|| {
        AppError::not_found(CODE_NO_REPO, "프로젝트를 찾을 수 없습니다.".to_string())
    })?;
    if repo.provider != Provider::Local || !repo.enabled {
        return Err(AppError::validation(
            CODE_NO_REPO,
            "복사 가능한 로컬 프로젝트가 아닙니다.".to_string(),
        ));
    }
    let base = repo
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            AppError::validation(CODE_NO_REPO, "프로젝트 로컬 경로가 없습니다.".to_string())
        })?;
    Ok(Path::new(base).join(subdir))
}

/// managed 스킬을 프로젝트 스킬 dir에 복사(G3-PR2b, ADR-0006 레일 ① — 사용자 발동·가역·감사). 잡 spawn
/// 없음(#1/#2 — 파일 복사). 충돌은 덮어쓰지 않는다. 반환 = 복사된 dir 경로.
#[tauri::command]
#[specta::specta]
pub async fn vendor_skill_to_project(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    repo_id: String,
    provider: SkillProvider,
    name: String,
) -> Result<String, AppError> {
    let central = crate::skills::apply::central_root(&app)?;
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let root = vendorable_repo_root(&repos, &repo_id, provider)?;
    let dst = vendor_core(&db, &central, &root, provider, &name).await?;
    Ok(dst.to_string_lossy().into_owned())
}

/// 프로젝트에서 vendored 카피 제거 — 중앙과 InSync일 때만(사용자 편집 무손실). 가역의 반대편(레일 ①).
#[tauri::command]
#[specta::specta]
pub async fn unvendor_skill_from_project(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    repo_id: String,
    provider: SkillProvider,
    name: String,
) -> Result<(), AppError> {
    let central = crate::skills::apply::central_root(&app)?;
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let root = vendorable_repo_root(&repos, &repo_id, provider)?;
    unvendor_core(&db, &central, &root, provider, &name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// central에 managed 스킬 `<provider>/<name>/SKILL.md`(+aux) 생성. 스킬 dir 반환.
    fn make_central(central: &Path, provider: &str, name: &str, body: &str) -> PathBuf {
        let dir = central.join(provider).join(name);
        write(&dir.join("SKILL.md"), body);
        write(&dir.join("aux.txt"), "aux");
        dir
    }

    fn repo(id: &str, provider: Provider, local_path: Option<&str>, enabled: bool) -> Repo {
        Repo {
            id: id.into(),
            project_id: "proj".into(),
            provider,
            remote_url: None,
            local_path: local_path.map(str::to_string),
            default_branch: "main".into(),
            enabled,
            created_at: "2026-06-01T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn vendor_copies_tree_and_audits_once() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let src = make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");

        let dst = vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("vendor");
        assert_eq!(dst, proj_root.join("foo"));
        assert!(trees_equal(&dst, &src)); // 바이트 동일 카피.
        assert!(!std::fs::symlink_metadata(&dst)
            .unwrap()
            .file_type()
            .is_symlink());

        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log WHERE action='vendor'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn vendor_idempotent_on_in_sync_copy_no_second_audit() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap();
        // 재vendor: 멱등 성공, 새 audit 없음.
        vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("idempotent");
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log WHERE action='vendor'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n, 1, "멱등 재vendor는 새 audit 행을 만들지 않는다");
    }

    #[tokio::test]
    async fn vendor_collision_on_diverged_dir_untouched() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "CENTRAL");
        let proj_root = tmp.path().join("proj/.claude/skills");
        // 사용자가 같은 이름의 다른 내용 dir을 이미 둠.
        write(&proj_root.join("foo/SKILL.md"), "USER-EDIT");
        let err = vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_COLLISION);
        assert_eq!(
            std::fs::read_to_string(proj_root.join("foo/SKILL.md")).unwrap(),
            "USER-EDIT" // 무손상.
        );
    }

    #[tokio::test]
    async fn vendor_collision_on_preexisting_empty_dir() {
        // 빈 실제 dir이 대상에 미리 있으면 trees_equal(empty, src+SKILL.md)=false → 충돌(덮어쓰지 않음).
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(proj_root.join("foo")).unwrap(); // 빈 dir.
        let err = vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_COLLISION);
        assert!(!proj_root.join("foo/SKILL.md").exists()); // 복사되지 않음(덮어쓰기 없음).
    }

    #[tokio::test]
    async fn vendor_collision_on_symlink_untouched() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let src = make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(&proj_root).unwrap();
        std::os::unix::fs::symlink(&src, proj_root.join("foo")).unwrap();
        let err = vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_COLLISION);
        assert!(std::fs::symlink_metadata(proj_root.join("foo"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[tokio::test]
    async fn vendor_no_source_when_central_missing() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library"); // 비어 있음
        let proj_root = tmp.path().join("proj/.claude/skills");
        let err = vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "ghost")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_NO_SOURCE);
    }

    #[tokio::test]
    async fn unvendor_removes_in_sync_copy_and_audits() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        let dst = vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap();
        unvendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("unvendor in-sync");
        assert!(std::fs::symlink_metadata(&dst).is_err()); // 제거됨.
        let last: String =
            sqlx::query_scalar("SELECT action FROM skill_audit_log ORDER BY id DESC LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(last, "unvendor");
    }

    #[tokio::test]
    async fn unvendor_refuses_diverged_copy_untouched() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "CENTRAL");
        let proj_root = tmp.path().join("proj/.claude/skills");
        vendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap();
        // 프로젝트 쪽 편집 → diverged.
        std::fs::write(proj_root.join("foo/SKILL.md"), "EDITED").unwrap();
        let err = unvendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_DIVERGED);
        assert!(proj_root.join("foo/SKILL.md").exists()); // 무손상.
    }

    #[tokio::test]
    async fn unvendor_refuses_symlink_target() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let src = make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(&proj_root).unwrap();
        std::os::unix::fs::symlink(&src, proj_root.join("foo")).unwrap();
        let err = unvendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_NOT_OURS);
        assert!(std::fs::symlink_metadata(proj_root.join("foo"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[tokio::test]
    async fn unvendor_noop_when_absent_no_audit() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        unvendor_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("absent no-op");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn vendorable_repo_root_ok_for_local_enabled() {
        let repos = vec![repo("r1", Provider::Local, Some("/tmp/repo"), true)];
        let root = vendorable_repo_root(&repos, "r1", SkillProvider::Claude).unwrap();
        assert_eq!(root, Path::new("/tmp/repo/.claude/skills"));
        let root = vendorable_repo_root(&repos, "r1", SkillProvider::Codex).unwrap();
        assert_eq!(root, Path::new("/tmp/repo/.codex/skills"));
    }

    #[test]
    fn vendorable_repo_root_unsupported_provider() {
        let repos = vec![repo("r1", Provider::Local, Some("/tmp/repo"), true)];
        let err = vendorable_repo_root(&repos, "r1", SkillProvider::Hermes).unwrap_err();
        assert_eq!(err.code, CODE_UNSUPPORTED_PROVIDER);
    }

    #[test]
    fn vendorable_repo_root_no_repo_cases() {
        let repos = vec![
            repo("gh", Provider::Github, Some("/tmp/gh"), true),
            repo("off", Provider::Local, Some("/tmp/off"), false),
            repo("empty", Provider::Local, Some("  "), true),
            repo("none", Provider::Local, None, true),
        ];
        for id in ["missing", "gh", "off", "empty", "none"] {
            let err = vendorable_repo_root(&repos, id, SkillProvider::Claude).unwrap_err();
            assert_eq!(err.code, CODE_NO_REPO, "id={id} 는 no_repo여야 한다");
        }
    }
}
