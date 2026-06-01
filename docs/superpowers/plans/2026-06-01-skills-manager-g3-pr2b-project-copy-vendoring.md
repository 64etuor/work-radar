# G3-PR2b Project Skill Copy Vendoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user vendor (copy) a central managed skill into a project's skill dir and un-vendor it reversibly (remove only when still byte-identical to central).

**Architecture:** New hermetic Rust module `skills/vendor.rs` mirrors `apply.rs` (single cores + thin commands), reuses `central_repo::copy_dir_shallow` for the copy and `divergence::trees_equal` (promoted to `pub(crate)`) for the InSync safety gate. The project-dir convention is single-sourced in `scan.rs` via a new `vendor_subdir`. FE adds two mutation hooks (invalidating `skillWorkspaces`+`skillDivergences`+`skills`), a pure `buildVendorTargets` helper, and a `VendorPanel` in the managed-skill detail sheet.

**Tech Stack:** Rust (Tauri 2, sqlx, tauri-specta), React + TanStack Query, vitest.

---

## Reference — verified facts (read before starting)

- `central_repo::copy_dir_shallow(src: &Path, dest: &Path) -> Result<(), AppError>` — recursive copy of `src` contents into an **existing** `dest` (it does `create_dir_all` for sub-dirs). `import_to_central` uses `create_dir_all(&dest)?; copy_dir_shallow(src, &dest)?`.
- `central_repo::central_skill_dir(root, provider_str, name) -> PathBuf`; `provider_segment(provider) -> &'static str`; `sanitize_segment(name) -> String`.
- `divergence::trees_equal(a, b) -> bool` is currently **private** — Task 1 promotes it to `pub(crate)`.
- `audit(pool, action, target_kind, target, Some(source), Some(detail)).await? ` — `apply.rs` calls `audit(pool, "apply", "external_dir", &link.to_string_lossy(), Some(&src.to_string_lossy()), Some("symlink"))`. Vendor uses action `"vendor"`/`"unvendor"`, target_kind `"project_dir"`, detail `Some("copy")`. **Detail must never contain file bodies/paths beyond the target (C7).**
- `apply::central_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError>` is `pub(crate)`.
- `commands::projects::fetch_all_repos(db) -> Result<Vec<Repo>, _>`; `Repo { id, project_id, provider: Provider, remote_url, local_path: Option<String>, default_branch, enabled, created_at }`; `Provider::{Github, Local}`.
- `commands::shared::test_support::fresh_db().await -> Db` (deref to `&SqlitePool`).
- `scan.rs` private const `REPO_SKILL_DIRS: [(&str, SkillProvider); 3] = [(".claude/skills", Claude), (".codex/skills", Codex), (".agents/skills", Codex)]`.
- Commands are registered in `lib.rs` `collect_commands![ … ]`; `skills::divergence::list_skill_divergences,` is at ~line 262.
- `ManagedViewer` is `src/components/SkillsView.tsx:1293`; the apply/unapply `<div className="skl-actions">` block ends at line 1395, `<SkillTagsEditor>` is line 1397 — the vendor panel mounts between them.

---

## File Structure

- **Modify** `src-tauri/src/skills/divergence.rs` — `fn trees_equal` → `pub(crate) fn trees_equal`.
- **Modify** `src-tauri/src/skills/scan.rs` — add `pub(crate) fn vendor_subdir` + a `#[cfg(test)] mod` agreement test.
- **Create** `src-tauri/src/skills/vendor.rs` — error codes, `vendor_core`, `unvendor_core`, `vendorable_repo_root`, 2 commands, `#[cfg(test)] mod tests`.
- **Modify** `src-tauri/src/skills/mod.rs` — `pub mod vendor;` + re-export the 2 commands.
- **Modify** `src-tauri/src/lib.rs` — register the 2 commands in `collect_commands!`.
- **Regenerated** `src/bindings.ts` — via `cargo test` (+2 commands, 0 types).
- **Modify** `src/lib/skillEnvNav.ts` — `VendorState`, `VendorTarget`, `buildVendorTargets`.
- **Modify** `src/lib/skillEnvNav.test.ts` — vitest for `buildVendorTargets`.
- **Modify** `src/lib/query/skills.ts` — `useVendorSkillToProject`, `useUnvendorSkillFromProject`.
- **Modify** `src/components/SkillsView.tsx` — `VendorPanel` + mount in `ManagedViewer` + `Copy` import.
- **Modify** `src/components/SkillsView.css` — `.skl-vendor*` styles.

---

## Task 1: Backend foundations — expose `trees_equal`, add `vendor_subdir`

**Files:**
- Modify: `src-tauri/src/skills/divergence.rs:58`
- Modify: `src-tauri/src/skills/scan.rs` (add fn near `REPO_SKILL_DIRS` ~line 70, add test mod at end)

- [ ] **Step 1: Promote `trees_equal`**

In `divergence.rs`, change the signature only:

```rust
/// 두 스킬 디렉터리 트리가 동일한지(상대경로 집합 + 파일별 바이트 + 심링크 타깃). 한쪽이라도 읽기
/// 실패면 false(보수적). G3-PR2b vendor의 InSync 안전 게이트가 재사용 → pub(crate).
pub(crate) fn trees_equal(a: &Path, b: &Path) -> bool {
```

- [ ] **Step 2: Add `vendor_subdir` to `scan.rs`** (immediately after the `repo_skill_roots` fn, ~line 98)

```rust
/// 프로젝트 vendoring 대상 서브디렉터리(REPO_SKILL_DIRS의 대표 매핑). claude→`.claude/skills`,
/// codex→`.codex/skills`. 그 외 provider는 프로젝트 dir 관례가 없어 None(vendoring 미지원). C6: 프로젝트
/// dir 관례 단일 출처. vendoring한 카피가 repo_skill_roots 스캔 + divergence 감지에 즉시 보이도록 같은
/// 관례를 쓴다(아래 테스트가 REPO_SKILL_DIRS와 동치를 가드).
pub(crate) fn vendor_subdir(provider: SkillProvider) -> Option<&'static str> {
    match provider {
        SkillProvider::Claude => Some(".claude/skills"),
        SkillProvider::Codex => Some(".codex/skills"),
        SkillProvider::Openclaw | SkillProvider::Hermes | SkillProvider::Other => None,
    }
}
```

- [ ] **Step 3: Add the agreement test at the end of `scan.rs`**

```rust
#[cfg(test)]
mod vendor_subdir_tests {
    use super::*;

    #[test]
    fn vendor_subdir_agrees_with_repo_skill_dirs() {
        // vendorable provider의 subdir은 REPO_SKILL_DIRS에 같은 provider로 존재해야 한다(C6 동치).
        for p in [SkillProvider::Claude, SkillProvider::Codex] {
            let sub = vendor_subdir(p).expect("claude/codex는 vendorable");
            assert!(
                REPO_SKILL_DIRS.iter().any(|(d, prov)| *d == sub && *prov == p),
                "vendor_subdir({p:?})={sub} 는 같은 provider의 REPO_SKILL_DIRS 항목이어야 한다"
            );
        }
        // 비-vendorable provider는 None.
        assert_eq!(vendor_subdir(SkillProvider::Openclaw), None);
        assert_eq!(vendor_subdir(SkillProvider::Hermes), None);
        assert_eq!(vendor_subdir(SkillProvider::Other), None);
    }
}
```

- [ ] **Step 4: Verify it compiles + the test passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar skills::scan::vendor_subdir_tests -- --nocapture`
Expected: PASS (1 test). (If the package name differs, `cargo test vendor_subdir_agrees`.)

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/divergence.rs src-tauri/src/skills/scan.rs
git commit -m "feat(skills): G3-PR2b expose trees_equal + vendor_subdir convention"
```

---

## Task 2: `vendor_core` (copy central → project, hermetic)

**Files:**
- Create: `src-tauri/src/skills/vendor.rs`
- Modify: `src-tauri/src/skills/mod.rs` (register module)

- [ ] **Step 1: Create `vendor.rs` with module header, imports, error codes, and `vendor_core`**

```rust
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
        AppError::terminal("skills.vendor.mkdir", format!("프로젝트 dir 생성 실패: {e}"))
    })?;
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
        assert!(!std::fs::symlink_metadata(&dst).unwrap().file_type().is_symlink());

        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log WHERE action='vendor'")
            .fetch_one(&*pool)
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
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skill_audit_log WHERE action='vendor'")
            .fetch_one(&*pool)
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
}
```

- [ ] **Step 2: Register the module** in `src-tauri/src/skills/mod.rs` (alphabetical, after `pub mod updater;` / near `pub mod scan;` — keep the existing ordering, add):

```rust
pub mod vendor;
```

- [ ] **Step 3: Run the core tests (expect FAIL → PASS)**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test vendor::tests -- --nocapture`
Expected: PASS (5 tests). If `central_repo::copy_dir_shallow` is not `pub(crate)`, it already is (verified) — no change needed.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/vendor.rs src-tauri/src/skills/mod.rs
git commit -m "feat(skills): G3-PR2b vendor_core (copy central->project, collision-guarded)"
```

---

## Task 3: `unvendor_core` (remove only if InSync)

**Files:**
- Modify: `src-tauri/src/skills/vendor.rs` (add fn after `vendor_core`; tests in same `mod tests`)

- [ ] **Step 1: Add `unvendor_core` after `vendor_core`**

```rust
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
```

- [ ] **Step 2: Add tests inside `mod tests`**

```rust
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
                .fetch_one(&*pool)
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
            .fetch_one(&*pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
```

- [ ] **Step 3: Run (expect PASS)**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test vendor::tests -- --nocapture`
Expected: PASS (9 tests total).

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/vendor.rs
git commit -m "feat(skills): G3-PR2b unvendor_core (remove only when InSync)"
```

---

## Task 4: command layer + registration + bindings

**Files:**
- Modify: `src-tauri/src/skills/vendor.rs` (add `vendorable_repo_root` + 2 commands + tests)
- Modify: `src-tauri/src/skills/mod.rs` (re-export commands)
- Modify: `src-tauri/src/lib.rs` (register in `collect_commands!`)

- [ ] **Step 1: Add `vendorable_repo_root` + commands after `unvendor_core`**

```rust
/// repo_id → 프로젝트 vendoring 루트(`<local_path>/<vendor_subdir>`). Local+enabled+비어있지 않은
/// local_path 아니면 no_repo. vendor_subdir 없는 provider면 unsupported_provider.
fn vendorable_repo_root(
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
```

- [ ] **Step 2: Add `vendorable_repo_root` tests inside `mod tests`**

```rust
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
```

- [ ] **Step 3: Re-export commands** in `src-tauri/src/skills/mod.rs` (near the other `pub use` lines, after `pub use updater::{…}` block):

```rust
pub use vendor::{unvendor_skill_from_project, vendor_skill_to_project};
```

- [ ] **Step 4: Register in `lib.rs` `collect_commands!`** — add right after `skills::divergence::list_skill_divergences,` (line ~262):

```rust
        skills::vendor::vendor_skill_to_project,
        skills::vendor::unvendor_skill_from_project,
```

- [ ] **Step 5: Run full backend tests + regenerate bindings**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test 2>&1 | tail -20`
Expected: all pass; total = prior 493 + 9 (vendor core) + 3 (repo_root) + 1 (vendor_subdir) = **506**. `cargo test` regenerates `src/bindings.ts`.

- [ ] **Step 6: Confirm bindings are additive only**

Run: `cd .. && git diff --stat src/bindings.ts` then `git diff src/bindings.ts | grep -E '^-' | grep -v '^---'`
Expected: only additions (vendorSkillToProject, unvendorSkillFromProject); **zero deletions**.

- [ ] **Step 7: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/vendor.rs src-tauri/src/skills/mod.rs src-tauri/src/lib.rs src/bindings.ts
git commit -m "feat(skills): G3-PR2b vendor commands + bindings (additive)"
```

---

## Task 5: FE pure helper `buildVendorTargets` + vitest

**Files:**
- Modify: `src/lib/skillEnvNav.ts` (append after `buildDivergedPathSet`)
- Modify: `src/lib/skillEnvNav.test.ts`

- [ ] **Step 1: Write the failing vitest** (append to `skillEnvNav.test.ts`; import `buildVendorTargets` + types from `./skillEnvNav`, and `Skill`/`SkillWorkspace`/`SkillDivergence` from `@/bindings` — follow the file's existing import style)

```ts
describe("buildVendorTargets", () => {
  const managed = (provider: SkillProvider, name: string): Skill =>
    ({ id: `managed:${name}`, name, kind: "managed", provider }) as unknown as Skill;
  const ws = (repoId: string, label: string): SkillWorkspace =>
    ({ repoId, label, rootPath: "", skillCount: 0, memberPaths: [] }) as unknown as SkillWorkspace;
  const div = (
    repoId: string,
    provider: SkillProvider,
    name: string,
    status: "in_sync" | "diverged",
  ): SkillDivergence =>
    ({ repoId, provider, name, memberPath: `/p/${name}/SKILL.md`, status }) as unknown as SkillDivergence;

  it("maps absent/in_sync/diverged per workspace from divergences", () => {
    const skill = managed("claude", "foo");
    const workspaces = [ws("r1", "Alpha"), ws("r2", "Beta"), ws("r3", "Gamma")];
    const divs = [
      div("r1", "claude", "foo", "in_sync"),
      div("r2", "claude", "foo", "diverged"),
      div("r3", "claude", "bar", "in_sync"), // 다른 스킬 → r3은 absent
    ];
    const out = buildVendorTargets(skill, workspaces, divs);
    expect(out).toEqual([
      { repoId: "r1", label: "Alpha", state: "in_sync" },
      { repoId: "r2", label: "Beta", state: "diverged" },
      { repoId: "r3", label: "Gamma", state: "absent" },
    ]);
  });

  it("returns empty for a non-vendorable provider", () => {
    const out = buildVendorTargets(managed("hermes", "foo"), [ws("r1", "Alpha")], []);
    expect(out).toEqual([]);
  });

  it("returns empty for a non-managed skill", () => {
    const ext = { id: "ext:/x", name: "foo", kind: "external", provider: "claude" } as unknown as Skill;
    expect(buildVendorTargets(ext, [ws("r1", "Alpha")], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/skillEnvNav.test.ts`
Expected: FAIL ("buildVendorTargets is not a function").

- [ ] **Step 3: Implement `buildVendorTargets`** (append to `skillEnvNav.ts`)

```ts
/** vendoring 대상 provider(프로젝트 dir 관례 있는 것 — 백엔드 vendor_subdir의 FE 트윈). 백엔드가
 *  authoritative이며 그 외 provider는 unsupported_provider로 거부한다. */
const VENDORABLE_PROVIDERS: ReadonlySet<SkillProvider> = new Set<SkillProvider>(["claude", "codex"]);

export type VendorState = "absent" | "in_sync" | "diverged";
export interface VendorTarget {
  repoId: string;
  label: string;
  state: VendorState;
}

/**
 * managed 스킬 (provider,name)에 대해 vendorable 프로젝트(워크스페이스)별 vendor 상태를 도출(G3-PR2b).
 * 상태의 단일 출처는 divergences(repoId+provider+name → status) — 프런트 경로추론 없음(C6). divergence
 * 목록에 없는 워크스페이스 = absent. managed가 아니거나 provider가 vendorable이 아니면 빈 배열(패널 숨김).
 */
export function buildVendorTargets(
  skill: Skill,
  workspaces: SkillWorkspace[] | undefined,
  divergences: SkillDivergence[] | undefined,
): VendorTarget[] {
  if (skill.kind !== "managed" || !skill.provider || !VENDORABLE_PROVIDERS.has(skill.provider)) {
    return [];
  }
  const { provider, name } = skill;
  const stateByRepo = new Map<string, VendorState>();
  for (const d of divergences ?? []) {
    if (d.provider === provider && d.name === name) {
      stateByRepo.set(d.repoId, d.status === "diverged" ? "diverged" : "in_sync");
    }
  }
  return (workspaces ?? []).map((w) => ({
    repoId: w.repoId,
    label: w.label,
    state: stateByRepo.get(w.repoId) ?? "absent",
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/skillEnvNav.test.ts`
Expected: PASS (3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/skillEnvNav.ts src/lib/skillEnvNav.test.ts
git commit -m "feat(skills): G3-PR2b buildVendorTargets pure helper + vitest"
```

---

## Task 6: FE hooks + `VendorPanel`

**Files:**
- Modify: `src/lib/query/skills.ts`
- Modify: `src/components/SkillsView.tsx`
- Modify: `src/components/SkillsView.css`

- [ ] **Step 1: Add mutation hooks** to `src/lib/query/skills.ts` (after `useUnapplyManagedSkills`):

```ts
/**
 * managed 스킬을 프로젝트 스킬 dir에 복사(G3-PR2b, ADR-0006 레일 ① — 복사·가역·감사). 잡 spawn 없음.
 * 성공 시 워크스페이스 + divergence + 스킬 목록 무효화(새 카피가 멤버 + 마커로 즉시 반영 — PR2 유예된
 * invalidation을 여기서 해소).
 */
export function useVendorSkillToProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { repoId: string; provider: SkillProvider; name: string }) =>
      unwrap(commands.vendorSkillToProject(args.repoId, args.provider, args.name)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skillWorkspaces"] });
      qc.invalidateQueries({ queryKey: ["skillDivergences"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

/**
 * 프로젝트 vendored 카피 제거 — 중앙과 InSync일 때만(사용자 편집 무손실). 성공 시 워크스페이스 +
 * divergence + 스킬 목록 무효화.
 */
export function useUnvendorSkillFromProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { repoId: string; provider: SkillProvider; name: string }) =>
      unwrap(commands.unvendorSkillFromProject(args.repoId, args.provider, args.name)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skillWorkspaces"] });
      qc.invalidateQueries({ queryKey: ["skillDivergences"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
```

- [ ] **Step 2: Add the `Copy` icon import** in `SkillsView.tsx` (the lucide-react import already includes `Unlink`, `Link2`, `Trash2`, `Library` — add `Copy`):

Find the lucide-react import line and add `Copy,` alphabetically.

- [ ] **Step 3: Add `useSkillWorkspaces`, `useSkillDivergences`, `useVendorSkillToProject`, `useUnvendorSkillFromProject`, `buildVendorTargets` to the existing imports** in `SkillsView.tsx` (the query hooks + `skillEnvNav` import blocks already exist — add the new names; `useSkillWorkspaces`/`useSkillDivergences`/`buildVendorTargets` are already imported at the top per current file).

Add to the `@/lib/query/skills` import: `useVendorSkillToProject`, `useUnvendorSkillFromProject`. (`useSkillWorkspaces`, `useSkillDivergences` are already imported.)

- [ ] **Step 4: Add the `VendorPanel` component** immediately before `ManagedViewer` (i.e., before line 1290):

```tsx
/** managed 스킬을 프로젝트 스킬 dir에 복사/해제(G3-PR2b, ADR-0006 레일 ① — 복사·가역·감사). vendorable
 *  프로젝트별 현재 상태: absent→복사, in_sync→복사 해제, diverged→변경됨(해소는 PR2c). 상태는
 *  divergences가 단일 출처(C6). vendorable provider(claude/codex) 아니거나 대상 프로젝트 없으면 숨김. */
function VendorPanel({ skill }: { skill: Skill }) {
  const workspaces = useSkillWorkspaces();
  const divergences = useSkillDivergences();
  const vendor = useVendorSkillToProject();
  const unvendor = useUnvendorSkillFromProject();
  const [note, setNote] = useState<string | null>(null);
  const targets = useMemo(
    () => buildVendorTargets(skill, workspaces.data, divergences.data),
    [skill, workspaces.data, divergences.data],
  );
  if (!skill.provider || targets.length === 0) return null;
  const provider = skill.provider;
  const busy = vendor.isPending || unvendor.isPending;

  const doVendor = (repoId: string) => {
    if (busy) return;
    setNote(null);
    vendor.mutate(
      { repoId, provider, name: skill.name },
      {
        onSuccess: (path) => setNote(`복사됨 → ${path}`),
        onError: (e) => setNote(`복사 실패: ${(e as Error).message}`),
      },
    );
  };
  const doUnvendor = (repoId: string) => {
    if (busy) return;
    setNote(null);
    unvendor.mutate(
      { repoId, provider, name: skill.name },
      {
        onSuccess: () => setNote("복사 해제됨 (프로젝트 카피 제거 · 중앙 무손상)"),
        onError: (e) => setNote(`해제 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-vendor">
      <div className="skl-vendor-label">프로젝트에 복사</div>
      {targets.map((t) => (
        <div key={t.repoId} className="skl-vendor-row">
          <span className="skl-vendor-proj" title={t.repoId}>
            {t.label}
          </span>
          {t.state === "absent" && (
            <Button
              variant="outline"
              className="gap-1.5 rounded-full"
              onClick={() => doVendor(t.repoId)}
              disabled={busy}
            >
              <Copy className="size-4" />
              복사
            </Button>
          )}
          {t.state === "in_sync" && (
            <Button
              variant="outline"
              className="gap-1.5 rounded-full"
              onClick={() => doUnvendor(t.repoId)}
              disabled={busy}
            >
              <Unlink className="size-4" />
              복사 해제
            </Button>
          )}
          {t.state === "diverged" && (
            <span className="skl-vendor-diverged" title="중앙과 다름 — 해소는 곧(PR2c)">
              변경됨
            </span>
          )}
        </div>
      ))}
      {note && <div className="skl-note">{note}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Mount `VendorPanel` in `ManagedViewer`** — between the `</div>` that closes `skl-actions` (line 1395) and `<SkillTagsEditor skill={skill} />` (line 1397):

```tsx
      </div>

      <VendorPanel skill={skill} />

      <SkillTagsEditor skill={skill} />
```

- [ ] **Step 6: Add CSS** to `src/components/SkillsView.css` (append near the `.skl-actions` rules):

```css
.skl-vendor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.75rem;
}
.skl-vendor-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted-foreground, #6b7280);
}
.skl-vendor-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.skl-vendor-proj {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skl-vendor-diverged {
  font-size: 0.75rem;
  color: var(--destructive, #b91c1c);
}
```

- [ ] **Step 7: Typecheck + lint + build the FE**

Run: `pnpm typecheck && pnpm lint 2>&1 | grep -iE "error" | tail -5`
Expected: typecheck 0 errors; lint 0 errors (pre-existing warnings OK).

- [ ] **Step 8: Commit**

```bash
git add src/lib/query/skills.ts src/components/SkillsView.tsx src/components/SkillsView.css
git commit -m "feat(skills): G3-PR2b vendor panel in managed skill sheet"
```

---

## Task 7: Full gates + final verification

**Files:** none (verification only)

- [ ] **Step 1: Rust gates**

Run:
```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH"
cargo test 2>&1 | tail -5
cargo clippy --all-targets -- -D warnings 2>&1 | tail -5
cargo fmt --check
```
Expected: tests pass (~506), clippy 0 warnings, fmt clean.

- [ ] **Step 2: FE gates**

Run:
```bash
cd .. && pnpm typecheck && pnpm lint 2>&1 | grep -iE "error|problem" | tail -3 && pnpm vitest run 2>&1 | grep -E "Tests |Test Files" | tail -2
```
Expected: typecheck 0; lint 0 errors; vitest ~274 pass.

- [ ] **Step 3: bindings drift check (additive only)**

Run: `git diff --exit-code src/bindings.ts; echo "exit=$?"`
Expected: exit=0 (already committed in Task 4; no uncommitted drift).

- [ ] **Step 4: git state sanity**

Run: `git status --short && git log --oneline -8`
Expected: clean tree; 6 PR2b code commits + the earlier spec/plan commits.

- [ ] **Step 5: Independent critic review (separate opus pass — NOT self-approve)**

Dispatch the `oh-my-claudecode:critic` agent on the full PR2b diff (`git diff 240a311..HEAD` plus the spec). Must return ACCEPT with 0 blockers before PR2b is "done". Address any blocker, re-run gates, re-critic.

---

## Self-Review (completed)

- **Spec coverage:** §4.2 vendor_subdir→T1; §4.4 vendor_core→T2, unvendor_core→T3; §4.5 vendorable_repo_root+commands→T4; §4.6 bindings→T4; §5.1 hooks→T6; §5.2 buildVendorTargets→T5; §5.3 VendorPanel→T6; §6 all tests mapped (Rust T2/T3/T4/T1, vitest T5). ✓
- **Placeholder scan:** none — every code step has full content. ✓
- **Type consistency:** `vendor_core`/`unvendor_core`/`vendorable_repo_root` signatures identical across tasks; error-code consts reused by name; `VendorState`/`VendorTarget`/`buildVendorTargets` consistent T5↔T6; command names `vendorSkillToProject`/`unvendorSkillFromProject` consistent backend↔FE. ✓
- **Known deferrals (in spec §8):** 0-skill-project vendoring, diverged resolution (pull/push/diff), per-location attribution, health badge — all PR2c/PR3. ✓
