//! 프로젝트 divergence 해소(G3-PR2c, ADR-0006 레일 ① — #22 substantive write) — diverged 프로젝트
//! 카피를 양방향 중 하나로 해소.
//!
//! - **diff**: diverged 카피와 중앙의 트리 차이(added/removed/changed). 표시 전용(읽기).
//! - **pull**: 중앙 내용으로 프로젝트 카피 덮어쓰기(프로젝트 편집 버림). git-tracked 카피 = 사용자 git이 undo.
//! - **push**: 프로젝트 편집을 중앙에 반영(중앙 덮어쓰기). 중앙은 git-untracked(app_data)이므로 **덮어쓰기
//!   전에 중앙을 backup 스냅샷**으로 떠서 가역(레일 ①). UI는 diverged에서만 노출.
//!
//! whole-tree 단위(per-file 선택/3-way merge 아님 — PR2의 2-way·no-baseline 모델과 일관). 경로 의미는
//! vendor.rs·divergence.rs와 **동일 헬퍼**(C6 단일 출처). **#1/#2 불변**: 파일 복사/제거 + DB뿐, 잡 spawn
//! 없음. 상태는 디스크 유도(표/마이그레이션 없음 — #7). 경로/내용은 표시·매칭 전용 — 로그 금지(C7).
#![allow(clippy::result_large_err)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tauri::State;

use crate::commands::projects::fetch_all_repos;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{ChangedFile, SkillDiff, SkillProvider};
use crate::skills::audit_log::audit;
use crate::skills::backup::{backup_library_core, backups_root, new_snapshot_id};
use crate::skills::central_repo::{
    central_skill_dir, copy_dir_shallow, provider_segment, sanitize_segment,
};
use crate::skills::divergence::{collect_tree, trees_equal, TreeEntry};
use crate::skills::vendor::vendorable_repo_root;

pub(crate) const CODE_NO_SOURCE: &str = "skills.resolve.no_source";
pub(crate) const CODE_NOT_OURS: &str = "skills.resolve.not_ours";
pub(crate) const CODE_NOT_VENDORED: &str = "skills.resolve.not_vendored";
pub(crate) const CODE_READ: &str = "skills.resolve.read";

/// 트리 항목을 표시용 텍스트로(diff 라인). File=UTF-8 lossy, Symlink=타깃 경로, Dir=빈 문자열.
/// (프로젝트 카피·중앙은 구성상 심링크-free라 현실적으로 File 변경 + dir add/remove만 발생 — 타입
/// mismatch는 한쪽 텍스트가 비어 라인 diff에서 전체 추가/삭제로 자연 표현.)
fn entry_text(e: &TreeEntry) -> String {
    match e {
        TreeEntry::File(b) => String::from_utf8_lossy(b).into_owned(),
        TreeEntry::Symlink(p) => p.to_string_lossy().into_owned(),
        TreeEntry::Dir => String::new(),
    }
}

/// core: 중앙 스킬 dir ↔ 프로젝트 카피 dir 트리 차이(표시 전용). 한쪽이라도 읽기 실패 → CODE_READ.
/// added=프로젝트에만, removed=중앙에만, changed=양쪽에 있으나 다른 항목. 키 합집합은 정렬(BTreeSet) → 결정적.
pub(crate) fn diff_core(central_dir: &Path, project_dir: &Path) -> Result<SkillDiff, AppError> {
    let central = collect_tree(central_dir)
        .ok_or_else(|| AppError::terminal(CODE_READ, "중앙 트리를 읽지 못했습니다.".to_string()))?;
    let project = collect_tree(project_dir).ok_or_else(|| {
        AppError::terminal(
            CODE_READ,
            "프로젝트 카피 트리를 읽지 못했습니다.".to_string(),
        )
    })?;

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let keys: BTreeSet<&PathBuf> = central.keys().chain(project.keys()).collect();
    for k in keys {
        let rel = k.to_string_lossy().into_owned();
        match (central.get(k), project.get(k)) {
            (Some(_), None) => removed.push(rel),
            (None, Some(_)) => added.push(rel),
            (Some(c), Some(p)) => {
                if c != p {
                    changed.push(ChangedFile {
                        rel_path: rel,
                        central_text: entry_text(c),
                        project_text: entry_text(p),
                    });
                }
            }
            (None, None) => unreachable!("키는 두 맵 중 하나엔 반드시 존재"),
        }
    }
    Ok(SkillDiff {
        added,
        removed,
        changed,
    })
}

/// core: 중앙 → 프로젝트 카피 덮어쓰기(프로젝트 편집 버림). 중앙 원본 없음=거부(가져올 게 없음),
/// 심링크=거부(사용자 심링크 안 건드림), 부재=생성, InSync=멱등 no-op. 가역(git-tracked 카피).
pub(crate) async fn pull_core(
    pool: &SqlitePool,
    central_root: &Path,
    project_skill_root: &Path,
    provider: SkillProvider,
    name: &str,
) -> Result<(), AppError> {
    let seg = sanitize_segment(name);
    let src = central_skill_dir(central_root, provider_segment(provider), &seg);
    if !src.join("SKILL.md").is_file() {
        return Err(AppError::terminal(
            CODE_NO_SOURCE,
            "중앙 원본이 없어 가져올 수 없습니다.".to_string(),
        ));
    }
    let dst = project_skill_root.join(&seg);
    if let Ok(meta) = std::fs::symlink_metadata(&dst) {
        if meta.file_type().is_symlink() {
            return Err(AppError::terminal(
                CODE_NOT_OURS,
                "대상이 심링크입니다(vendored 카피 아님 — 덮어쓰지 않음).".to_string(),
            ));
        }
        if trees_equal(&dst, &src) {
            return Ok(()); // 멱등 no-op(audit 안 함).
        }
        std::fs::remove_dir_all(&dst).map_err(|e| {
            AppError::terminal(
                "skills.resolve.rmdir",
                format!("프로젝트 카피 제거 실패: {e}"),
            )
        })?;
    }
    std::fs::create_dir_all(&dst).map_err(|e| {
        AppError::terminal(
            "skills.resolve.mkdir",
            format!("프로젝트 dir 생성 실패: {e}"),
        )
    })?;
    copy_dir_shallow(&src, &dst)?;
    audit(
        pool,
        "pull",
        "project_dir",
        &dst.to_string_lossy(),
        Some(&src.to_string_lossy()),
        Some("copy"),
    )
    .await?;
    Ok(())
}

/// core: 프로젝트 카피 → 중앙 덮어쓰기 — **덮어쓰기 전에 중앙을 backup 스냅샷**으로 떠 가역(레일 ①).
/// 검증(심링크/부재/no_source)은 백업 **전에** 수행해 잉여 스냅샷을 막는다. InSync=백업/덮어쓰기 모두
/// 건너뜀(멱등). `snapshot_id`는 호출자(커맨드)가 UTC로 생성 주입(hermetic 테스트 — backup.rs와 동일).
pub(crate) async fn push_with_backup_core(
    pool: &SqlitePool,
    central_root: &Path,
    backups_root: &Path,
    project_skill_root: &Path,
    provider: SkillProvider,
    name: &str,
    snapshot_id: &str,
) -> Result<(), AppError> {
    let seg = sanitize_segment(name);
    let dst = project_skill_root.join(&seg);
    let Ok(meta) = std::fs::symlink_metadata(&dst) else {
        return Err(AppError::terminal(
            CODE_NOT_VENDORED,
            "프로젝트에 vendored 카피가 없어 반영할 게 없습니다.".to_string(),
        ));
    };
    if meta.file_type().is_symlink() {
        return Err(AppError::terminal(
            CODE_NOT_OURS,
            "대상이 심링크입니다(vendored 카피 아님 — 반영하지 않음).".to_string(),
        ));
    }
    let central = central_skill_dir(central_root, provider_segment(provider), &seg);
    if !central.join("SKILL.md").is_file() {
        return Err(AppError::terminal(
            CODE_NO_SOURCE,
            "중앙에 managed 원본이 없어 반영하지 않습니다(신규 생성 아님).".to_string(),
        ));
    }
    if trees_equal(&dst, &central) {
        return Ok(()); // 멱등 no-op — 백업/덮어쓰기 모두 건너뜀.
    }
    // 가역(레일 ①): 중앙 덮어쓰기 전에 사전 스냅샷(복원 패널에서 되돌림).
    backup_library_core(pool, central_root, backups_root, snapshot_id).await?;
    std::fs::remove_dir_all(&central).map_err(|e| {
        AppError::terminal("skills.resolve.rmdir", format!("중앙 카피 제거 실패: {e}"))
    })?;
    std::fs::create_dir_all(&central).map_err(|e| {
        AppError::terminal("skills.resolve.mkdir", format!("중앙 dir 생성 실패: {e}"))
    })?;
    copy_dir_shallow(&dst, &central)?;
    audit(
        pool,
        "push",
        "skill_library",
        &central.to_string_lossy(),
        Some(&dst.to_string_lossy()),
        Some("copy"),
    )
    .await?;
    Ok(())
}

/// 프로젝트 카피 ↔ 중앙 트리 차이(G3-PR2c, #22 — 표시 전용). 읽기 전용: 외부 dir 쓰기/네트워크/잡
/// spawn 없음(#1/#2/#7).
#[tauri::command]
#[specta::specta]
pub async fn list_skill_diff(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    repo_id: String,
    provider: SkillProvider,
    name: String,
) -> Result<SkillDiff, AppError> {
    let central = crate::skills::apply::central_root(&app)?;
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let root = vendorable_repo_root(&repos, &repo_id, provider)?;
    let seg = sanitize_segment(&name);
    let central_dir = central_skill_dir(&central, provider_segment(provider), &seg);
    diff_core(&central_dir, &root.join(&seg))
}

/// 중앙 내용으로 프로젝트 카피 덮어쓰기(G3-PR2c, 레일 ① — 사용자 발동·가역·감사). 프로젝트 편집을
/// 버린다(git-tracked 카피라 사용자 git이 undo). 잡 spawn 없음(#1/#2 — 파일 복사).
#[tauri::command]
#[specta::specta]
pub async fn pull_divergence(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    repo_id: String,
    provider: SkillProvider,
    name: String,
) -> Result<(), AppError> {
    let central = crate::skills::apply::central_root(&app)?;
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let root = vendorable_repo_root(&repos, &repo_id, provider)?;
    pull_core(&db, &central, &root, provider, &name).await
}

/// 프로젝트 편집을 중앙에 반영(G3-PR2c, 레일 ① — 사용자 발동·가역·감사). 중앙을 덮어쓰기 전에 backup
/// 스냅샷으로 떠 가역(중앙은 git-untracked). 잡 spawn 없음(#1/#2 — 파일 복사 + 스냅샷).
#[tauri::command]
#[specta::specta]
pub async fn push_divergence(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    repo_id: String,
    provider: SkillProvider,
    name: String,
) -> Result<(), AppError> {
    let central = crate::skills::apply::central_root(&app)?;
    let backups = backups_root(&app)?;
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let root = vendorable_repo_root(&repos, &repo_id, provider)?;
    push_with_backup_core(
        &db,
        &central,
        &backups,
        &root,
        provider,
        &name,
        &new_snapshot_id(),
    )
    .await
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

    // ── diff_core ──────────────────────────────────────────────────────────

    #[test]
    fn diff_reports_changed_file() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("c/foo");
        let project = tmp.path().join("p/foo");
        write(&central.join("SKILL.md"), "CENTRAL");
        write(&project.join("SKILL.md"), "PROJECT");

        let d = diff_core(&central, &project).unwrap();
        assert!(d.added.is_empty());
        assert!(d.removed.is_empty());
        assert_eq!(d.changed.len(), 1);
        assert_eq!(d.changed[0].rel_path, "SKILL.md");
        assert_eq!(d.changed[0].central_text, "CENTRAL");
        assert_eq!(d.changed[0].project_text, "PROJECT");
    }

    #[test]
    fn diff_reports_added_and_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("c/foo");
        let project = tmp.path().join("p/foo");
        write(&central.join("SKILL.md"), "SAME");
        write(&central.join("only_central.txt"), "x"); // 프로젝트가 지움 → removed
        write(&project.join("SKILL.md"), "SAME");
        write(&project.join("only_project.txt"), "y"); // 프로젝트가 추가 → added

        let d = diff_core(&central, &project).unwrap();
        assert_eq!(d.added, vec!["only_project.txt"]);
        assert_eq!(d.removed, vec!["only_central.txt"]);
        assert!(d.changed.is_empty(), "SKILL.md 동일이라 changed 없음");
    }

    #[test]
    fn diff_empty_for_identical() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("c/foo");
        let project = tmp.path().join("p/foo");
        for root in [&central, &project] {
            write(&root.join("SKILL.md"), "BODY");
            write(&root.join("sub/extra.txt"), "hello");
        }
        let d = diff_core(&central, &project).unwrap();
        assert!(d.added.is_empty() && d.removed.is_empty() && d.changed.is_empty());
    }

    #[test]
    fn diff_read_error_when_project_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("c/foo");
        write(&central.join("SKILL.md"), "BODY");
        let err = diff_core(&central, &tmp.path().join("nonexistent")).unwrap_err();
        assert_eq!(err.code, CODE_READ);
    }

    // ── pull_core ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn pull_overwrites_diverged_copy_with_central_and_audits() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let src = make_central(&central, "claude", "foo", "CENTRAL");
        let proj_root = tmp.path().join("proj/.claude/skills");
        // 프로젝트 쪽이 편집된 카피(diverged) + 프로젝트 전용 파일.
        write(&proj_root.join("foo/SKILL.md"), "PROJECT-EDIT");
        write(&proj_root.join("foo/extra.txt"), "p");

        pull_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("pull");
        let dst = proj_root.join("foo");
        assert!(trees_equal(&dst, &src)); // 중앙과 바이트 동일.
        assert!(!dst.join("extra.txt").exists()); // 프로젝트 전용 파일도 사라짐(whole-tree).
        let last: String =
            sqlx::query_scalar("SELECT action FROM skill_audit_log ORDER BY id DESC LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(last, "pull");
    }

    #[tokio::test]
    async fn pull_idempotent_on_in_sync_no_audit() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        write(&proj_root.join("foo/SKILL.md"), "BODY");
        write(&proj_root.join("foo/aux.txt"), "aux"); // 중앙과 동일.

        pull_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("in-sync pull");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "InSync pull은 audit 행을 만들지 않는다");
    }

    #[tokio::test]
    async fn pull_creates_when_absent() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let src = make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills"); // 카피 부재.

        pull_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .expect("pull creates");
        assert!(trees_equal(&proj_root.join("foo"), &src));
    }

    #[tokio::test]
    async fn pull_refuses_symlink_target() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let src = make_central(&central, "claude", "foo", "BODY");
        let proj_root = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(&proj_root).unwrap();
        std::os::unix::fs::symlink(&src, proj_root.join("foo")).unwrap();
        let err = pull_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_NOT_OURS);
        assert!(std::fs::symlink_metadata(proj_root.join("foo"))
            .unwrap()
            .file_type()
            .is_symlink()); // 무손상.
    }

    #[tokio::test]
    async fn pull_no_source_when_central_missing() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library"); // 비어 있음.
        let proj_root = tmp.path().join("proj/.claude/skills");
        write(&proj_root.join("foo/SKILL.md"), "PROJECT");
        let err = pull_core(&pool, &central, &proj_root, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, CODE_NO_SOURCE);
        assert!(proj_root.join("foo/SKILL.md").exists()); // 무손상.
    }

    // ── push_with_backup_core ──────────────────────────────────────────────

    #[tokio::test]
    async fn push_overwrites_central_with_project_snapshots_and_audits() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let central_dir = make_central(&central, "claude", "foo", "CENTRAL");
        let backups = tmp.path().join("skills-backups");
        let proj_root = tmp.path().join("proj/.claude/skills");
        // 프로젝트 편집(diverged).
        write(&proj_root.join("foo/SKILL.md"), "PROJECT-EDIT");
        write(&proj_root.join("foo/aux.txt"), "aux");

        push_with_backup_core(
            &pool,
            &central,
            &backups,
            &proj_root,
            SkillProvider::Claude,
            "foo",
            "20260601T000000Z",
        )
        .await
        .expect("push");

        // 중앙이 프로젝트 내용으로 교체됨.
        assert!(trees_equal(&central_dir, &proj_root.join("foo")));
        assert_eq!(
            std::fs::read_to_string(central_dir.join("SKILL.md")).unwrap(),
            "PROJECT-EDIT"
        );
        // 사전 스냅샷이 백업 루트에 생김(중앙 덮어쓰기 전 상태).
        assert!(backups
            .join("20260601T000000Z")
            .join("claude/foo/SKILL.md")
            .exists());
        // audit: backup 행 + push 행, 마지막이 push.
        let last: String =
            sqlx::query_scalar("SELECT action FROM skill_audit_log ORDER BY id DESC LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(last, "push");
    }

    #[tokio::test]
    async fn push_idempotent_on_in_sync_no_backup_no_audit() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let backups = tmp.path().join("skills-backups");
        let proj_root = tmp.path().join("proj/.claude/skills");
        write(&proj_root.join("foo/SKILL.md"), "BODY");
        write(&proj_root.join("foo/aux.txt"), "aux"); // 중앙과 동일.

        push_with_backup_core(
            &pool,
            &central,
            &backups,
            &proj_root,
            SkillProvider::Claude,
            "foo",
            "20260601T000000Z",
        )
        .await
        .expect("in-sync push");
        assert!(!backups.exists(), "InSync push는 스냅샷을 만들지 않는다");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "InSync push는 audit 행을 만들지 않는다");
    }

    #[tokio::test]
    async fn push_not_vendored_when_project_absent() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let backups = tmp.path().join("skills-backups");
        let proj_root = tmp.path().join("proj/.claude/skills"); // 카피 부재.
        let err = push_with_backup_core(
            &pool,
            &central,
            &backups,
            &proj_root,
            SkillProvider::Claude,
            "foo",
            "20260601T000000Z",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, CODE_NOT_VENDORED);
        assert!(!backups.exists()); // 백업 안 함.
    }

    #[tokio::test]
    async fn push_refuses_symlink_no_backup() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let central_dir = make_central(&central, "claude", "foo", "BODY");
        let backups = tmp.path().join("skills-backups");
        let proj_root = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(&proj_root).unwrap();
        std::os::unix::fs::symlink(&central_dir, proj_root.join("foo")).unwrap();
        let err = push_with_backup_core(
            &pool,
            &central,
            &backups,
            &proj_root,
            SkillProvider::Claude,
            "foo",
            "20260601T000000Z",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, CODE_NOT_OURS);
        assert!(!backups.exists());
    }

    #[tokio::test]
    async fn push_no_source_when_central_missing_no_backup() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library"); // 비어 있음(managed 아님).
        let backups = tmp.path().join("skills-backups");
        let proj_root = tmp.path().join("proj/.claude/skills");
        write(&proj_root.join("foo/SKILL.md"), "PROJECT");
        let err = push_with_backup_core(
            &pool,
            &central,
            &backups,
            &proj_root,
            SkillProvider::Claude,
            "foo",
            "20260601T000000Z",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, CODE_NO_SOURCE);
        assert!(!backups.exists());
    }
}
