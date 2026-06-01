# G3-PR2b — Project Skill Copy Vendoring (write path)

- **Date:** 2026-06-01
- **Phase:** G3 (skills-manager full manager, ADR-0006), partial #22
- **Builds on:** G3-PR1 (project workspace view, `SkillWorkspace`), G3-PR2 (divergence
  detection, `trees_equal`), G2-PR1 (external apply / `apply.rs`), G1 (`import.rs` /
  `central_repo.rs` copy primitives)
- **Status:** Spec — approved design, pre-plan

## 1. Purpose

Let a user **vendor** (copy) a central managed skill into a project's skill dir
(`<repo>/.claude/skills/<name>` or `<repo>/.codex/skills/<name>`), creating a real,
committable on-disk copy — unlike a G2 symlink, which is machine-specific and useless
when committed/shared. And **un-vendor** that copy reversibly.

This is the **copy write-path** slice of #22. It reuses G3-PR2's `trees_equal` to make
un-vendor safe (remove only when still byte-identical to central — never destroy user
edits). It also **resolves G3-PR2's deferred query-invalidation** (the vendor/unvendor
mutations invalidate `skillWorkspaces` + `skillDivergences` so markers stay fresh).

The **diverged-resolution** flow — pull central→project, push project→central, diff
view, conflict UI — stays **deferred to G3-PR2c**. This PR only creates and (safely)
removes copies; it never reconciles a diverged copy.

### Why a copy (not a symlink)

G2 symlinks central skills into **agent** dirs (`~/.claude/skills/...`) — drift-free,
they point at central. But **project** skill dirs are typically committed to git, where
a machine-specific symlink into `~/Library/.../skills-library` is dead on another
machine. So vendoring a real copy is the opt-in project mode. A real copy drifts as
either side edits — G3-PR2 detects that; this PR creates/removes it.

## 2. Scope decisions (locked during brainstorm)

| Decision             | Choice                                                  | Consequence                                                                                                              |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Write direction      | **central → project copy** (`copy_dir_shallow`)         | A real, committable dir; drifts → G3-PR2 detects.                                                                        |
| Un-vendor safety     | **remove only if InSync** (reuse `trees_equal`)         | Never destroys user edits. Diverged → refuse with `diverged`, defer to PR2c. Mirrors `apply.rs`'s "never destroy" guard. |
| Re-vendor            | **idempotent if InSync, else collision**                | Re-vendoring an identical copy = no-op success (no audit). A diverged/foreign occupant is never overwritten.             |
| Vendorable providers | **claude, codex only** (mirror `REPO_SKILL_DIRS`)       | The copy is discoverable by PR1 scan + PR2 detection. openclaw/hermes/other → `unsupported_provider`.                    |
| State                | **disk-derived, no table** (#7)                         | Vendored = real dir at the vendor target whose central `(provider,name)` exists. No migration.                          |
| Target dir           | `<repo>/<vendor_subdir(provider)>/<sanitize(name)>`     | `vendor_subdir` in scan.rs is the single source (mirrors `REPO_SKILL_DIRS`, C6).                                         |

## 3. Definitions

- **Vendorable project** — an `enabled` `Provider::Local` repo with a non-empty
  `local_path` (the exact gate `repo_skill_roots` already applies).
- **Vendor target** — `<local_path>/<vendor_subdir(provider)>/<sanitize_segment(name)>`.
- **Vendored copy** — a **real directory** (not a symlink) at the vendor target whose
  central counterpart `(provider, name)` exists (`central_dir/SKILL.md` is a file).

## 4. Backend

New module `src-tauri/src/skills/vendor.rs` (registered in `skills/mod.rs`; commands
re-exported like `apply`).

### 4.1 Reuse (no reinvention)

- `central_skill_dir`, `provider_segment`, `sanitize_segment`, **`copy_dir_shallow`**
  (recursive tree copy) — from `central_repo`.
- **`trees_equal`** — from `divergence.rs`; promote private `fn` → `pub(crate)` so
  un-vendor reuses the exact byte-compare PR2 uses (DRY; one definition of "InSync").
- `audit` — from `audit_log` (detail = `files=N` only, like `import.rs`; never log paths/body — C7).
- `fetch_all_repos` + `Repo` + `Provider` — from `commands::projects` / `models`.
- `central_root(app)` — from `apply.rs` (already `pub(crate)`).

### 4.2 scan.rs addition — `vendor_subdir` (single source for project dir convention, C6)

```rust
/// 프로젝트 vendoring 대상 서브디렉터리(REPO_SKILL_DIRS의 대표 매핑). claude→`.claude/skills`,
/// codex→`.codex/skills`. 그 외 provider는 프로젝트 dir 관례가 없어 None(vendoring 미지원).
/// REPO_SKILL_DIRS와 동치 유지(테스트로 가드): vendoring한 카피가 repo_skill_roots 스캔 +
/// divergence 감지에 즉시 보이도록 같은 dir 관례를 쓴다.
pub(crate) fn vendor_subdir(provider: SkillProvider) -> Option<&'static str> {
    match provider {
        SkillProvider::Claude => Some(".claude/skills"),
        SkillProvider::Codex => Some(".codex/skills"),
        _ => None,
    }
}
```

`REPO_SKILL_DIRS` also maps `.agents/skills`→Codex (a shared discovery dir); the
**primary** Codex project dir for vendoring is `.codex/skills`. A test asserts
`vendor_subdir` returns a subdir that appears in `REPO_SKILL_DIRS` with the same provider.

### 4.3 Error codes (module consts, like `apply.rs`)

```
skills.vendor.no_source            // 중앙 라이브러리에 소스 스킬 없음
skills.vendor.unsupported_provider // 프로젝트 dir 관례 없는 provider(claude/codex 외)
skills.vendor.collision            // 대상에 다른 dir/심링크/변경된 카피 존재 — 덮어쓰지 않음
skills.vendor.diverged             // un-vendor 거부: 카피가 중앙과 다름(→ PR2c)
skills.vendor.not_ours             // un-vendor: 대상이 심링크(vendored 카피 아님)
skills.vendor.no_repo              // repo_id 미존재/비-vendorable(Github/비활성/빈 경로)
```

### 4.4 Cores (hermetic, app-handle-independent → tempdir-testable)

```rust
pub(crate) async fn vendor_core(
    pool: &SqlitePool, central_root: &Path, project_skill_root: &Path,
    provider: SkillProvider, name: &str,
) -> Result<PathBuf, AppError>
```

1. `src = central_skill_dir(central_root, provider_segment(provider), &sanitize_segment(name))`.
   If `!src.join("SKILL.md").is_file()` → `no_source`.
2. `dst = project_skill_root.join(sanitize_segment(name))`.
3. If `symlink_metadata(dst)` is Ok (something exists):
   - if `dst` is a **symlink** → `collision` (not a vendored copy; never touch).
   - else (real dir): `trees_equal(dst, src)` ? **idempotent** `Ok(dst)` (no copy, no audit)
     : `collision` (diverged/foreign — never overwrite).
4. `create_dir_all(project_skill_root)`; `create_dir_all(dst)`; `copy_dir_shallow(src, dst)`.
5. `audit("vendor", "project_dir", dst, Some(src), Some("files=N"))`.
6. `Ok(dst)`.

```rust
pub(crate) async fn unvendor_core(
    pool, central_root, project_skill_root, provider, name,
) -> Result<(), AppError>
```

1. `dst = project_skill_root.join(seg)`. If `symlink_metadata(dst).is_err()` → `Ok(())`
   (absent — idempotent no-op, no audit). _(Mirrors `unapply_core`.)_
2. If `dst` is a symlink → `not_ours`.
3. `src = central dir`; if `!src/SKILL.md.is_file()` → `no_source` (can't verify InSync →
   refuse; conservative, never delete unverifiable).
4. `trees_equal(dst, src)` ? `remove_dir_all(dst)` + `audit("unvendor", …)` : `diverged`.

Conservative throughout: any ambiguity → refuse the destructive op, surface the error.

### 4.5 Command layer

```rust
/// repo_id → 프로젝트 vendoring 루트. Local+enabled+비어있지 않은 local_path 아니면 no_repo.
/// vendor_subdir 없는 provider면 unsupported_provider.
fn vendorable_repo_root(
    repos: &[Repo], repo_id: &str, provider: SkillProvider,
) -> Result<PathBuf, AppError>
```

```rust
#[tauri::command] #[specta::specta]
pub async fn vendor_skill_to_project(
    db, app, repo_id: String, provider: SkillProvider, name: String,
) -> Result<String, AppError>     // vendored dir 경로

#[tauri::command] #[specta::specta]
pub async fn unvendor_skill_from_project(
    db, app, repo_id: String, provider: SkillProvider, name: String,
) -> Result<(), AppError>
```

Both: `central = apply::central_root(&app)?`; `repos = fetch_all_repos(db).await?`;
`root = vendorable_repo_root(&repos, &repo_id, provider)?`; delegate to the core.

### 4.6 bindings

`src/bindings.ts`: **+2 commands** (`vendorSkillToProject`, `unvendorSkillFromProject`),
**0 new types** (args are `String`/`SkillProvider`; returns `String`/`null`). Additive
only — 0 deletions. Regenerated via `cargo test`.

## 5. Front end

### 5.1 Hooks (`src/lib/query/skills.ts`)

```ts
useVendorSkillToProject()      // mutate {repoId, provider, name}
useUnvendorSkillFromProject()  // mutate {repoId, provider, name}
```

Both `onSuccess` invalidate **`["skillWorkspaces"]` + `["skillDivergences"]` +
`["skills"]`** — so the newly vendored copy shows up as a project member with a fresh
divergence marker, and an un-vendored copy disappears. **This closes G3-PR2's known
stale-marker gap** (no mutation existed before to invalidate `skillDivergences`).

### 5.2 Pure helper (`src/lib/skillEnvNav.ts`, sibling to `buildDivergedPathSet`)

```ts
export type VendorState = "absent" | "in_sync" | "diverged";
export interface VendorTarget { repoId: string; label: string; state: VendorState; }

/** managed 스킬 (provider,name)에 대해 vendorable 프로젝트별 vendor 상태를 도출.
 *  divergences(repo_id+provider+name → status)가 단일 출처 — 프런트 경로추론 없음(C6).
 *  divergence 목록에 없는 워크스페이스 = absent. provider가 vendorable 아니면 빈 배열. */
export function buildVendorTargets(
  skill: Skill,
  workspaces: SkillWorkspace[] | undefined,
  divergences: SkillDivergence[] | undefined,
): VendorTarget[]
```

Vendor state per project is derived from `divergences`: a candidate member matching
`(repoId, provider, name)` with `in_sync`/`diverged`; absent from the list ⇒ `absent`.
Vendorable provider gate (claude/codex) lives in a small FE constant mirroring
`vendor_subdir` (documented as the FE twin; the backend is authoritative and rejects
others with `unsupported_provider`). vitest-covered.

### 5.3 Surface (`SkillsView.tsx`)

In the **managed-skill detail sheet** (the `kind === "managed"` branch, where
apply/unapply already live), add a "프로젝트에 복사" panel listing
`buildVendorTargets(...)`:

- `absent` → **복사** button → `vendorSkillToProject`.
- `in_sync` → **복사 해제** button → `unvendorSkillFromProject` (+ "동기화됨").
- `diverged` → "변경됨" disabled, tooltip "해소는 곧(PR2c)" — un-vendor is refused
  server-side anyway; the FE just doesn't offer the destructive action.

Hidden entirely for non-vendorable providers (empty `buildVendorTargets`). No counts,
no headline badge (that's #17 / PR3).

## 6. Tests (TDD — write first)

**Rust (hermetic tempdir, like `apply.rs`/`divergence.rs` tests):**

1. `vendor_core` absent target → copies tree, audits once, `dst` is a real dir
   byte-equal to central (`trees_equal(dst, src)`).
2. `vendor_core` idempotent when `dst` already InSync → `Ok`, **no second audit row**.
3. `vendor_core` collision when `dst` is a foreign/diverged real dir → error, dir untouched.
4. `vendor_core` collision when `dst` is a symlink → error, link untouched.
5. `vendor_core` `no_source` when central missing.
6. `unvendor_core` removes an InSync copy + audits (`unvendor`).
7. `unvendor_core` refuses a diverged copy (`diverged`), dir untouched.
8. `unvendor_core` refuses a symlink target (`not_ours`), link untouched.
9. `unvendor_core` no-op when absent (no audit row).
10. `vendorable_repo_root`: `no_repo` for missing id / Github / disabled / empty path;
    `Ok` for Local+enabled; `unsupported_provider` for a non-claude/codex provider.
11. `vendor_subdir` agrees with `REPO_SKILL_DIRS` (claude/codex present, same provider).

**vitest:**

1. `buildVendorTargets` → `absent`/`in_sync`/`diverged` per workspace from divergences.
2. `buildVendorTargets` → empty for a non-vendorable provider.

## 7. Invariants & known edges

**Invariants respected:**

- **ADR-0006 rail ①** — user-initiated, **reversible** (un-vendor InSync), **audited**
  (every copy/remove). Only skill dirs targeted — no config/secret files. ✓
- **#1/#2** — no job spawn; file copy/remove only. ✓
- **#7** — disk-derived; no new table, no migration. ✓
- **C7** — paths display/match only; audit detail = `files=N` (never body/path). ✓
- **C6** — project dir convention single-sourced in `scan.rs` (`vendor_subdir` mirrors
  `REPO_SKILL_DIRS`); FE matches by `divergences`, no path inference. ✓
- **bindings** — additive only (+2 commands, 0 types). ✓
- **IPC** — tauri-specta generated; no hand-written TS IPC. ✓
- No new DB PK → no specta i64 issue. ✓

**Known edges (noted, not blocking):**

- Vendoring into a **0-skill project** isn't offered (no `SkillWorkspace` exists yet to
  list as a target). Deferred — the 복사 entry point is workspace-driven.
- Per-location attribution (which of N project dirs) — still deferred to PR2c.
- Diverged **resolution** (pull/push/diff/conflict UI) — PR2c.
- `copy_dir_shallow` reads whole files — fine for small skills; no size cap this PR.
- Case-insensitive macOS FS — `trees_equal`'s relative-path-set compare is consistent
  (same FS both sides).

## 8. Out of scope (deferred)

- Diverged resolution: pull central→project, push project→central, diff view, conflict UI (**PR2c**).
- Vendoring into an empty (0-skill) project (**PR2c** or fast-follow).
- Aggregate divergence counts / headline sync badge (**#17 / PR3**).
- 3-way / baseline snapshot (would require persistence → migration).
