# G3-PR2 Project Skill Divergence Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a project's vendored copy of a managed skill has drifted from the central library, and show a subtle per-skill "diverged" marker in the 프로젝트 sidebar view — fully read-only.

**Architecture:** A pure Rust core (`divergence.rs`) walks each project-workspace member skill that is a real directory (not a symlink) and matches a central managed skill by `(provider, name)`, byte-compares the two directory trees, and returns `InSync`/`Diverged`. A Tauri command reuses PR1's repo→roots→scan primitives to build the member list. The front end keys a `Set<memberPath>` of diverged copies and renders a marker on matching skill cards. No writes, no migration, no network, no job spawn.

**Tech Stack:** Rust (std::fs, sqlx, tauri-specta), TypeScript/React (TanStack Query, vitest), Tailwind v4 CSS.

**Spec:** `docs/superpowers/specs/2026-06-01-skills-manager-g3-pr2-project-divergence-detection-design.md`

---

## File Structure

- **Create** `src-tauri/src/skills/divergence.rs` — the whole backend concern: tree comparison, `ProjectMember`, `detect_divergence_core`, `collect_project_members`, the `list_skill_divergences` command, inline hermetic tests.
- **Modify** `src-tauri/src/models/skills.rs` — add `SkillDivergence` + `DivergenceStatus` (auto-exported via `models.rs:33 pub use skills::*`).
- **Modify** `src-tauri/src/skills/mod.rs` — `pub mod divergence;`.
- **Modify** `src-tauri/src/skills/apply.rs:300` — bump `central_root` to `pub(crate)` (reuse, no behavior change).
- **Modify** `src-tauri/src/lib.rs` — register the command in `collect_commands!`.
- **Regenerated** `src/bindings.ts` — additive (+1 command, +2 types) via `cargo test`.
- **Modify** `src/lib/query/skills.ts` — `useSkillDivergences()` hook.
- **Modify** `src/lib/skillEnvNav.ts` — `buildDivergedPathSet()` pure helper.
- **Modify** `src/lib/skillEnvNav.test.ts` — vitest for the helper.
- **Modify** `src/components/SkillsView.tsx` — wire the hook + render the marker.
- **Modify** `src/components/SkillsView.css` — `.skl-card-diverged` rule + `position: relative` on `.skl-card-wrap`.

**Reused as-is (do not modify):** `central_repo::{central_skill_dir, provider_segment, sanitize_segment}`, `scan::{repo_skill_roots, scan_external_skills_core}`, `commands::projects::fetch_all_repos`.

**Gate prelude (every Rust step):** `export PATH="$HOME/.cargo/bin:$PATH"` then run `cargo` from `src-tauri/`.

---

## Task 1: Tree-comparison helper (`trees_equal`)

**Files:**

- Create: `src-tauri/src/skills/divergence.rs`
- Modify: `src-tauri/src/skills/mod.rs`

- [ ] **Step 1: Register the new module**

In `src-tauri/src/skills/mod.rs`, add after the `pub mod central_repo;` line:

```rust
pub mod divergence;
```

- [ ] **Step 2: Write the module skeleton + failing tests for `trees_equal`**

Create `src-tauri/src/skills/divergence.rs`:

```rust
//! 프로젝트 vendored 카피 드리프트 감지(G3-PR2, ADR-0006 #22 부분 — 감지 전용).
//!
//! 프로젝트 스킬 dir(`<repo>/.claude/skills/<name>` 등)이 중앙 managed 카피와 바이트 동일한지
//! 디스크에서 비교한다. **읽기 전용**: 어떤 dir에도 쓰지 않고, 마이그레이션/네트워크/잡 spawn 없음
//! (#1/#2/#7). 적용/해소(복사·pull/push)는 후속 PR. 심링크 멤버는 드리프트 불가라 후보 제외.
//! 경로는 표시·매칭 전용 — 로그 금지(C7).
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 트리 비교용 항목 표현(파일 내용 / 심링크 타깃 / 디렉터리 마커).
#[derive(PartialEq, Eq)]
enum TreeEntry {
    File(Vec<u8>),
    Symlink(PathBuf),
    Dir,
}

/// `root` 아래를 재귀 수집해 (상대경로 → 항목) 맵을 만든다. 심링크는 따라가지 않는다(트리 밖 비교
/// 차단). IO 오류는 None(호출자가 Diverged로 매핑 — 보수적).
fn collect_tree(root: &Path) -> Option<BTreeMap<PathBuf, TreeEntry>> {
    let mut map = BTreeMap::new();
    walk_tree(root, root, &mut map)?;
    Some(map)
}

fn walk_tree(root: &Path, dir: &Path, map: &mut BTreeMap<PathBuf, TreeEntry>) -> Option<()> {
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        let rel = path.strip_prefix(root).ok()?.to_path_buf();
        let ft = entry.file_type().ok()?;
        if ft.is_symlink() {
            map.insert(rel, TreeEntry::Symlink(std::fs::read_link(&path).ok()?));
        } else if ft.is_dir() {
            map.insert(rel, TreeEntry::Dir);
            walk_tree(root, &path, map)?;
        } else if ft.is_file() {
            map.insert(rel, TreeEntry::File(std::fs::read(&path).ok()?));
        }
        // 기타 타입(fifo 등)은 스킬에 없음 — 무시.
    }
    Some(())
}

/// 두 스킬 디렉터리 트리가 동일한지(상대경로 집합 + 파일별 바이트 + 심링크 타깃). 한쪽이라도 읽기
/// 실패면 false(보수적).
fn trees_equal(a: &Path, b: &Path) -> bool {
    match (collect_tree(a), collect_tree(b)) {
        (Some(ta), Some(tb)) => ta == tb,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn trees_equal_true_for_identical_with_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        for root in [&a, &b] {
            write(&root.join("SKILL.md"), "---\nname: x\n---\nbody");
            write(&root.join("sub/extra.txt"), "hello");
        }
        assert!(trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_edited_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "one");
        write(&b.join("SKILL.md"), "two");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_extra_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "same");
        write(&b.join("SKILL.md"), "same");
        write(&b.join("extra.txt"), "x");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "same");
        write(&a.join("gone.txt"), "y");
        write(&b.join("SKILL.md"), "same");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_when_one_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        write(&a.join("SKILL.md"), "same");
        assert!(!trees_equal(&a, &tmp.path().join("nonexistent")));
    }
}
```

- [ ] **Step 3: Run the tests — verify they pass (helper is fully implemented)**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test divergence 2>&1 | tail -15`
Expected: the 5 `trees_equal_*` tests PASS. (This task ships the helper and its tests together; there is no red phase because the helper has no external dependency to stub.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/skills/divergence.rs src-tauri/src/skills/mod.rs
git commit -m "feat(skills): G3-PR2 tree-comparison helper for divergence detection"
```

---

## Task 2: Types + `detect_divergence_core`

**Files:**

- Modify: `src-tauri/src/models/skills.rs`
- Modify: `src-tauri/src/skills/divergence.rs`

- [ ] **Step 1: Add the IPC types**

In `src-tauri/src/models/skills.rs`, append after the `SkillWorkspace` struct (around line 129):

```rust
/// 프로젝트 vendored 카피의 중앙 라이브러리 대비 드리프트 1건(G3-PR2, #22 부분). 디스크 유도·비영속
/// (#7). 읽기 전용. `member_path`는 표시·매칭 전용 — 로그 금지(C7).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDivergence {
    /// repos.id — 워크스페이스 귀속(String이라 specta i64 이슈 없음).
    pub repo_id: String,
    /// 멤버 스킬의 provider(스캔 루트 귀속).
    pub provider: SkillProvider,
    /// 표시 이름(frontmatter name 우선, dir 폴백) — registry/PR1과 동일 도출.
    pub name: String,
    /// PR1 `SkillWorkspace.member_paths` 와 **동일 문자열**(스킬 SKILL.md 경로) — FE Set-lookup용(C6).
    pub member_path: String,
    /// 비교 결과.
    pub status: DivergenceStatus,
}

/// 2-way 드리프트 상태(베이스라인 없음 — 누가 편집했는지는 표시 안 함). snake_case 방출.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceStatus {
    InSync,
    Diverged,
}
```

- [ ] **Step 2: Write the failing test for `detect_divergence_core`**

In `src-tauri/src/skills/divergence.rs`, inside `mod tests` (which already has `use super::*;`, so no new `use` lines are needed — `ProjectMember`, `DivergenceStatus`, `SkillProvider`, `detect_divergence_core` all resolve through it once Step 4 lands), add a helper to build a fake central skill and these four tests:

```rust
    /// 중앙 managed 스킬 dir 생성(`<central>/<provider>/<name>/SKILL.md` + 본문).
    fn make_central(central: &Path, provider: &str, name: &str, body: &str) -> PathBuf {
        let dir = central.join(provider).join(name);
        write(&dir.join("SKILL.md"), body);
        dir
    }

    fn member(repo: &str, name: &str, dir: &Path) -> ProjectMember {
        ProjectMember {
            repo_id: repo.to_string(),
            provider: SkillProvider::Claude,
            name: name.to_string(),
            member_path: dir.join("SKILL.md").to_string_lossy().into_owned(),
            dir_path: dir.to_path_buf(),
        }
    }

    #[test]
    fn detect_reports_in_sync_for_identical_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj = tmp.path().join("proj/.claude/skills/foo");
        write(&proj.join("SKILL.md"), "BODY");

        let out = detect_divergence_core(&central, &[member("r1", "foo", &proj)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, DivergenceStatus::InSync);
        assert_eq!(out[0].member_path, proj.join("SKILL.md").to_string_lossy());
    }

    #[test]
    fn detect_reports_diverged_for_edited_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "CENTRAL");
        let proj = tmp.path().join("proj/.claude/skills/foo");
        write(&proj.join("SKILL.md"), "EDITED");

        let out = detect_divergence_core(&central, &[member("r1", "foo", &proj)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, DivergenceStatus::Diverged);
    }

    #[test]
    fn detect_omits_symlinked_member() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let central_dir = make_central(&central, "claude", "foo", "BODY");
        // 프로젝트 멤버가 중앙으로 가는 심링크 → 카피 아님 → 제외.
        let proj_parent = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(&proj_parent).unwrap();
        let link = proj_parent.join("foo");
        std::os::unix::fs::symlink(&central_dir, &link).unwrap();

        let out = detect_divergence_core(&central, &[member("r1", "foo", &link)]);
        assert!(out.is_empty());
    }

    #[test]
    fn detect_omits_member_with_no_central_match() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library"); // 비어 있음
        let proj = tmp.path().join("proj/.claude/skills/orphan");
        write(&proj.join("SKILL.md"), "BODY");

        let out = detect_divergence_core(&central, &[member("r1", "orphan", &proj)]);
        assert!(out.is_empty());
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test divergence 2>&1 | tail -20`
Expected: FAIL to compile — `ProjectMember`, `detect_divergence_core` not found.

- [ ] **Step 4: Implement `ProjectMember` + `detect_divergence_core`**

In `src-tauri/src/skills/divergence.rs`, add above the `#[cfg(test)]` block. First add these imports at the top of the file (below the existing `use std::...` lines):

```rust
use crate::models::{DivergenceStatus, SkillDivergence, SkillProvider};
use crate::skills::central_repo::{central_skill_dir, provider_segment, sanitize_segment};
```

Then add the member struct and core:

```rust
/// 감지 코어 입력 1건 — 명령 레이어가 PR1 스캔 결과에서 도출(IPC 미경계 → Type 불필요).
pub(crate) struct ProjectMember {
    pub repo_id: String,
    pub provider: SkillProvider,
    pub name: String,
    pub member_path: String, // 스킬 SKILL.md 경로(PR1 member_paths 엔트리).
    pub dir_path: PathBuf,   // 비교 대상 스킬 디렉터리(member_path의 부모).
}

/// 코어: 각 프로젝트 멤버가 중앙 managed 카피와 드리프트했는지 판정(앱 핸들 비의존 → hermetic).
/// 심링크 멤버(드리프트 불가) / 중앙 미매칭(managed 아님)은 결과에서 제외한다. infallible.
pub(crate) fn detect_divergence_core(
    central_root: &Path,
    members: &[ProjectMember],
) -> Vec<SkillDivergence> {
    let mut out = Vec::new();
    for m in members {
        // 1. 멤버 dir이 심링크면 vendored 카피 아님 → 제외(부재/접근불가도 제외).
        let Ok(meta) = std::fs::symlink_metadata(&m.dir_path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        // 2. 중앙 managed 매칭? (provider, name) → central dir에 SKILL.md 존재해야 후보.
        let central_dir = central_skill_dir(
            central_root,
            provider_segment(m.provider),
            &sanitize_segment(&m.name),
        );
        if !central_dir.join("SKILL.md").is_file() {
            continue;
        }
        // 3. 트리 비교(읽기 오류 → Diverged, 보수적).
        let status = if trees_equal(&m.dir_path, &central_dir) {
            DivergenceStatus::InSync
        } else {
            DivergenceStatus::Diverged
        };
        out.push(SkillDivergence {
            repo_id: m.repo_id.clone(),
            provider: m.provider,
            name: m.name.clone(),
            member_path: m.member_path.clone(),
            status,
        });
    }
    out
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test divergence 2>&1 | tail -20`
Expected: all `trees_equal_*` and `detect_*` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/models/skills.rs src-tauri/src/skills/divergence.rs
git commit -m "feat(skills): G3-PR2 divergence types + detect_divergence_core"
```

---

## Task 3: Command + member collection + bindings

**Files:**

- Modify: `src-tauri/src/skills/divergence.rs`
- Modify: `src-tauri/src/skills/apply.rs:300`
- Modify: `src-tauri/src/lib.rs`
- Regenerated: `src/bindings.ts`

- [ ] **Step 1: Make `central_root` reusable**

In `src-tauri/src/skills/apply.rs`, change line 300 from:

```rust
fn central_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
```

to:

```rust
pub(crate) fn central_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
```

- [ ] **Step 2: Add `collect_project_members` + the command**

In `src-tauri/src/skills/divergence.rs`, extend the top imports:

```rust
use tauri::State;

use crate::commands::projects::fetch_all_repos;
use crate::db::Db;
use crate::error::AppError;
use crate::models::Repo;
use crate::skills::scan::{repo_skill_roots, scan_external_skills_core};
```

Then add (above `#[cfg(test)]`):

```rust
/// PR1과 동일한 repo→roots→scan 프리미티브로 프로젝트 멤버를 수집(경로 의미 단일 출처 C6).
/// `repo_skill_roots`가 이미 `Provider::Local && enabled && non-empty local_path` 필터다.
pub(crate) fn collect_project_members(repos: &[Repo]) -> Vec<ProjectMember> {
    let mut out = Vec::new();
    for repo in repos {
        let roots = repo_skill_roots(std::slice::from_ref(repo));
        if roots.is_empty() {
            continue;
        }
        for skill in scan_external_skills_core(&roots) {
            // scan_external_skills_core는 `path = <skill_dir>/SKILL.md` 를 보장(scan.rs:528).
            let dir_path = Path::new(&skill.path)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&skill.path));
            out.push(ProjectMember {
                repo_id: repo.id.clone(),
                provider: skill.provider,
                name: skill.name,
                member_path: skill.path,
                dir_path,
            });
        }
    }
    out
}

/// 프로젝트 스킬 드리프트 목록(G3-PR2, #22 부분 — 감지 전용). 읽기 전용: 외부 dir 쓰기/네트워크/잡
/// spawn 없음(#1/#2/#7). 레포 DB read 실패는 노출(PR1 list_skill_workspaces와 동일 — 조용한 degrade
/// 금지). 코어는 infallible(건별 보수적).
#[tauri::command]
#[specta::specta]
pub async fn list_skill_divergences(
    db: State<'_, Db>,
    app: tauri::AppHandle,
) -> Result<Vec<SkillDivergence>, AppError> {
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let central = crate::skills::apply::central_root(&app)?;
    let members = collect_project_members(&repos);
    Ok(detect_divergence_core(&central, &members))
}
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, add inside `collect_commands!` after `skills::apply::unapply_managed_skills,` (line 261):

```rust
        skills::divergence::list_skill_divergences,
```

- [ ] **Step 4: Build + regenerate bindings via cargo test**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test 2>&1 | tail -20`
Expected: PASS (the bindings-export test writes `src/bindings.ts`).

- [ ] **Step 5: Verify bindings drift is additive only**

Run: `cd /Users/davidpark/private_project/work-radar/.claude/worktrees/skills-mgr-migration && git diff --stat src/bindings.ts && git diff src/bindings.ts | grep -E '^-' | grep -vE '^---' | head`
Expected: only additions — `listSkillDivergences`, `SkillDivergence`, `DivergenceStatus`. **Zero deletions** (the second command prints nothing).

- [ ] **Step 6: Full Rust gate**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo clippy --all-targets -- -D warnings 2>&1 | tail -5 && cargo fmt --check && echo GATE_OK`
Expected: `GATE_OK`, no clippy warnings, fmt clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/skills/divergence.rs src-tauri/src/skills/apply.rs src-tauri/src/lib.rs src/bindings.ts
git commit -m "feat(skills): G3-PR2 list_skill_divergences command + bindings"
```

---

## Task 4: FE query hook + `buildDivergedPathSet` helper

**Files:**

- Modify: `src/lib/query/skills.ts`
- Modify: `src/lib/skillEnvNav.ts`
- Test: `src/lib/skillEnvNav.test.ts`

- [ ] **Step 1: Write the failing vitest for the helper**

In `src/lib/skillEnvNav.test.ts`, add the import for the new type to line 3 (it imports types from `@/bindings`) — change it to include `SkillDivergence`:

```ts
import type { Skill, SkillDivergence, SkillEnvironment, SkillWorkspace } from "@/bindings";
```

And ensure the helper is imported from the module under test (add `buildDivergedPathSet` to the existing `import { ... } from "./skillEnvNav"` block at the top). Then append a new describe block:

```ts
describe("buildDivergedPathSet", () => {
  const rows: SkillDivergence[] = [
    {
      repoId: "r1",
      provider: "claude",
      name: "a",
      memberPath: "/p/a/SKILL.md",
      status: "diverged",
    },
    { repoId: "r1", provider: "claude", name: "b", memberPath: "/p/b/SKILL.md", status: "in_sync" },
  ];

  it("includes only diverged memberPaths", () => {
    const set = buildDivergedPathSet(rows);
    expect(set.has("/p/a/SKILL.md")).toBe(true);
    expect(set.has("/p/b/SKILL.md")).toBe(false);
  });

  it("returns an empty set for undefined", () => {
    expect(buildDivergedPathSet(undefined).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/skillEnvNav.test.ts 2>&1 | tail -15`
Expected: FAIL — `buildDivergedPathSet` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/lib/skillEnvNav.ts`, change the top import (line 1) to add `SkillDivergence`:

```ts
import type {
  Skill,
  SkillDivergence,
  SkillEnvironment,
  SkillProvider,
  SkillWorkspace,
} from "@/bindings";
```

Append at the end of the file:

```ts
/**
 * Diverged 멤버 스킬의 `memberPath` Set. 카드 렌더가 `skill.sourcePath` 로 O(1) lookup 한다 —
 * 프런트 경로추론 없음(C6, divergence.rs가 경로/매칭의 단일 출처). `in_sync`/미수록은 마커 없음.
 */
export function buildDivergedPathSet(divergences: SkillDivergence[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const d of divergences ?? []) {
    if (d.status === "diverged") out.add(d.memberPath);
  }
  return out;
}
```

- [ ] **Step 4: Add the query hook**

In `src/lib/query/skills.ts`, add `SkillDivergence` to the `@/bindings` import block, then add after `useSkillWorkspaces` (around line 37):

```ts
export function useSkillDivergences() {
  return useQuery<SkillDivergence[]>({
    queryKey: ["skillDivergences"],
    queryFn: () => unwrap(commands.listSkillDivergences()),
  });
}
```

- [ ] **Step 5: Run to verify the helper test passes**

Run: `pnpm vitest run src/lib/skillEnvNav.test.ts 2>&1 | tail -15`
Expected: PASS (both new tests + all existing).

- [ ] **Step 6: Commit**

```bash
git add src/lib/query/skills.ts src/lib/skillEnvNav.ts src/lib/skillEnvNav.test.ts
git commit -m "feat(skills): G3-PR2 divergence query hook + path-set helper"
```

---

## Task 5: Divergence marker in SkillsView

**Files:**

- Modify: `src/components/SkillsView.tsx`
- Modify: `src/components/SkillsView.css`

- [ ] **Step 1: Wire the hook + derived set**

In `src/components/SkillsView.tsx`:

1. Add `useSkillDivergences` to the `@/lib/query/skills` import block (near `useSkillWorkspaces`, line ~70).
2. Add `buildDivergedPathSet` to the `@/lib/skillEnvNav` import block (near `buildSkillWorkspaceNav`, line ~94).
3. After `const workspaces = useSkillWorkspaces();` (line 131), add:

```tsx
const divergences = useSkillDivergences();
```

4. After the `workspaceNav` memo (line 201), add:

```tsx
const divergedPaths = useMemo(() => buildDivergedPathSet(divergences.data), [divergences.data]);
```

- [ ] **Step 2: Render the marker on diverged cards**

In `src/components/SkillsView.tsx`, in the card map (line 653), insert the marker as the first child of the wrapper:

```tsx
                    <div key={s.id} className={cn("skl-card-wrap", groupSelected && "selected")}>
                      {s.sourcePath != null && divergedPaths.has(s.sourcePath) && (
                        <span className="skl-card-diverged" title="중앙 라이브러리와 다름">
                          ·다름
                        </span>
                      )}
                      <input
                        type="checkbox"
                        className="skl-card-check"
```

- [ ] **Step 3: Add the CSS**

In `src/components/SkillsView.css`, change the `.skl-card-wrap` rule (line 539) to add `position: relative;`:

```css
.skl-card-wrap {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  position: relative;
}
```

Then add a new rule after the `.skl-card-wrap.selected .skl-card` rule (line 560-563):

```css
.skl-card-diverged {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 999px;
  color: var(--color-wr-accent);
  background: var(--color-wr-surface);
  border: 1px solid var(--color-wr-accent);
  pointer-events: none;
}
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `cd /Users/davidpark/private_project/work-radar/.claude/worktrees/skills-mgr-migration && pnpm typecheck 2>&1 | tail -5 && pnpm lint 2>&1 | grep -iE "error|problems" | tail -5; echo LINT_DONE`
Expected: typecheck clean; no new lint errors (2 pre-existing set-state-in-effect warnings unrelated to this change are acceptable).

- [ ] **Step 5: Commit**

```bash
git add src/components/SkillsView.tsx src/components/SkillsView.css
git commit -m "feat(skills): G3-PR2 per-skill divergence marker in project view"
```

---

## Task 6: Decisions breadcrumb + full gate sweep

**Files:**

- Modify: `docs/decisions.md`

- [ ] **Step 1: Append the breadcrumb**

Add a one-line entry to `docs/decisions.md` (follow the existing format of the last entry):

```markdown
- **G3-PR2 (#22 부분, 감지 전용):** 프로젝트 vendored 스킬 카피 ↔ 중앙 managed 드리프트 감지.
  `divergence.rs` 코어가 멤버 dir(심링크 제외) vs `central_skill_dir` 트리를 바이트 비교 → 2-way
  `InSync`/`Diverged`(베이스라인 없음 — 마이그레이션/표 0, #7). `list_skill_divergences` 커맨드는
  PR1 repo→roots→scan 프리미티브 재사용(C6). FE는 `memberPath` Set으로 카드에 ·다름 마커. **읽기
  전용**(외부 dir 쓰기/네트워크/잡 spawn 0, #1/#2). 복사·해소(pull/push)·집계 배지(#17)는 후속.
  trade-off: whole-tree 바이트 비교(false InSync 회피) · 마커는 g.skill 대표경로만(다중 location은
  대표 1건).
```

- [ ] **Step 2: Full gate sweep (Rust + FE)**

Run:

```bash
cd /Users/davidpark/private_project/work-radar/.claude/worktrees/skills-mgr-migration
export PATH="$HOME/.cargo/bin:$PATH"
( cd src-tauri && cargo test 2>&1 | grep -E "test result" | tail -3 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check && echo RUST_OK )
pnpm typecheck 2>&1 | tail -3
pnpm lint 2>&1 | grep -iE "error|problems" | tail -3; echo "LINT_DONE"
pnpm vitest run 2>&1 | grep -E "Tests |Test Files" | tail -3
git diff --exit-code src/bindings.ts && echo "BINDINGS_CLEAN (committed)"
```

Expected: `RUST_OK`; typecheck clean; no lint errors; vitest all pass; `BINDINGS_CLEAN`.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions.md
git commit -m "docs(decisions): G3-PR2 breadcrumb (project divergence detection)"
```

---

## Done criteria

- [ ] `cargo test` green (Task 1 + Task 2 tests included); clippy `-D warnings` clean; `cargo fmt --check` clean.
- [ ] `pnpm typecheck` clean; `pnpm lint` no new errors; `pnpm vitest run` green (helper tests included).
- [ ] `src/bindings.ts` drift additive only: +`listSkillDivergences`, +`SkillDivergence`, +`DivergenceStatus`, 0 deletions.
- [ ] No migration, no network call, no job spawn, no write to any external/project directory (read-only).
- [ ] Marker renders only on `Diverged` cards; `InSync`/unknown render nothing.
- [ ] Independent opus critic ACCEPT (separate review pass — no self-approve) before the work is called done.
- [ ] Committed locally on `feat/skills-mgr-migration`. **Do not push** (standing policy — push only on explicit user request).

## Self-review notes (author)

- **Spec coverage:** §4.2 core → Task 2; §4.3 `trees_equal` → Task 1; §4.4 command + member collection → Task 3; §4.5 bindings → Task 3 Step 4-5; §5 FE hook/helper/marker → Tasks 4-5; §6 tests → Tasks 1-2 (Rust) + Task 4 (vitest); §7 invariants → Task 6 done criteria. All covered.
- **Known limitation (carried from spec §7):** a grouped card uses `g.skill.sourcePath`; if one skill name maps to multiple project locations with mixed status, only the representative path drives the marker. Acceptable for a minimal indicator; noted in the breadcrumb.
- **Type consistency:** `DivergenceStatus` serializes snake_case → TS `"in_sync" | "diverged"`; FE compares `"diverged"` (Task 4 Step 3) — consistent. `member_path`/`memberPath` is the exact PR1 `member_paths` string throughout.
