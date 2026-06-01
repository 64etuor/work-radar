# G3-PR2 — Project Skill Divergence Detection (read-only)

- **Date:** 2026-06-01
- **Phase:** G3 (skills-manager full manager, ADR-0006), partial #22
- **Builds on:** G3-PR1 (project workspace view, `SkillWorkspace`), G2-PR1/PR2 (external apply / `apply.rs`)
- **Status:** Spec — approved design, pre-plan

## 1. Purpose

Detect when a project's **vendored copy** of a managed skill has drifted from the
central library, and surface a subtle per-skill "diverged" marker in the existing
프로젝트 sidebar section.

This is the **detection-only** slice of #22 (the bidirectional sync engine). It is
**pure read-only**: no writes to any directory, no migration, no network, no job
spawn. The write paths — copy-apply (vendoring a central skill into a project dir)
and resolution (pull central→project / push project→central) — are **explicitly
deferred** to later PRs (G3-PR2b / G3-PR2c). Naming those PRs here is intent, not a
commitment to scope.

### Why "copy" divergence exists at all

G2 apply symlinks central skills into **agent** dirs (`~/.claude/skills/...`).
Symlinks are drift-free — they point at central. But **project** skill dirs
(`<repo>/.claude/skills`, `<repo>/.agents/skills`, ...) are often committed to git,
where a machine-specific symlink into `~/Library/.../skills-library` is useless when
checked in or shared. So vendoring a skill (a real copy) is the opt-in mode, and a
real copy drifts as either side edits. This PR only **detects** that drift; it does
not create copies and does not resolve them.

## 2. Scope decisions (locked during brainstorm)

| Decision               | Choice                                | Consequence                                                                                                                                                        |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR scope               | **Detection only**                    | No copy-apply write, no resolution write. Read-only.                                                                                                               |
| Comparison granularity | **Whole skill directory tree**        | Relative-path set + per-file byte content. A false `InSync` is the worst failure, so correctness wins over cheapness.                                              |
| Divergence model       | **2-way** (no stored baseline)        | `central-now` vs `project-now`. Cannot label _who_ edited → status is binary. Honors INVARIANT #7 (no new table, no migration).                                    |
| UI extent              | **Minimal per-skill indicator**       | A subtle marker on `Diverged` members only. No counts, no workspace rollup — the headline badge stays for #17.                                                     |
| Detection location     | **Rust core** (Design B, mirrors PR1) | File I/O + central paths stay in Rust (C7); hermetically testable. The FE-compare alternative would leak central absolute paths to the renderer and duplicate I/O. |

## 3. Definitions

**Candidate** — a project-workspace member skill that is **both**:

1. a **real directory** on disk — _not_ a symlink (our symlinks and any user
   symlinks are drift-free by construction → omitted), **and**
2. a match for a **central managed skill** by `(provider, name)` — i.e.
   `central_skill_dir(central_root, provider, name)/SKILL.md` exists.

Members that match nothing in central are project-only → omitted (nothing to compare
against). Members that are symlinks → omitted.

**Status** — binary:

- `InSync` — project tree is byte-identical to the central tree (same relative-path
  set, every file equal).
- `Diverged` — any difference: a file added, removed, or changed; or any read error /
  ambiguous symlinked inner entry (conservative — surface, never hide).

No third state (`CentralMissing`, etc.) is exposed: by the candidate definition,
central always exists for a candidate.

## 4. Backend

New module: `src-tauri/src/skills/divergence.rs` (registered in `skills/mod.rs`).

### 4.1 Types

`SkillDivergence` and `DivergenceStatus` live in `src-tauri/src/models/skills.rs`
(alongside `SkillWorkspace` from PR1, for consistency). `ProjectMember` (§4.2) is
crate-internal (`pub(crate)`) and lives in `divergence.rs` — it never crosses the IPC
boundary, so it is not `Type`-derived.

```rust
/// 프로젝트 vendored 카피의 중앙 라이브러리 대비 드리프트 1건(디스크 유도, 비영속 — #7).
/// 읽기 전용. member_path/는 표시·매칭 전용 — 로그 금지(C7).
pub struct SkillDivergence {
    pub repo_id: String,          // 워크스페이스(repos.id) — String이라 specta i64 이슈 없음
    pub provider: SkillProvider,
    pub name: String,             // 표시 이름(frontmatter name 우선) — PR1/registry와 동일 도출
    pub member_path: String,      // PR1 SkillWorkspace.member_paths 와 **동일 문자열**(FE Set-lookup, C6)
    pub status: DivergenceStatus,
}

pub enum DivergenceStatus { InSync, Diverged }  // #[serde(rename_all="snake_case")]
```

`member_path` MUST equal the exact string PR1 placed in `SkillWorkspace.member_paths`
for that member, so the FE matches by Set/Map lookup with **no path inference** (C6).

### 4.2 Core (pure, app-handle-independent → tempdir-hermetic, infallible)

```rust
/// 입력 멤버 1건 — 명령 레이어가 PR1 집계에서 도출해 넘긴다.
pub(crate) struct ProjectMember {
    pub repo_id: String,
    pub provider: SkillProvider,
    pub name: String,
    pub member_path: String,   // PR1 member_paths 엔트리(절대경로; SKILL.md 파일 또는 dir)
    pub dir_path: PathBuf,     // 비교 대상 스킬 디렉터리
}

// dir_path 도출 규칙(명령 레이어): member_path가 `SKILL.md`로 끝나면 그 부모 디렉터리,
// 아니면 member_path 자체를 스킬 디렉터리로 본다. (PR1 source_path 는 둘 다 가능.)

pub(crate) fn detect_divergence_core(
    central_root: &Path,
    members: &[ProjectMember],
) -> Vec<SkillDivergence>
```

Per member:

1. If `dir_path` is a symlink (`symlink_metadata(...).is_symlink()`) → skip (not a copy).
2. `central_dir = central_skill_dir(central_root, provider_segment(provider), sanitize_segment(name))`
   (reuse `central_repo` helpers). If `central_dir/SKILL.md` is not a file → skip (not managed).
3. `status = if trees_equal(&dir_path, &central_dir) { InSync } else { Diverged }`.
4. Push `SkillDivergence { repo_id, provider, name, member_path, status }`.

Conservative on uncertainty: any I/O error during the walk → that member is `Diverged`.

### 4.3 Tree comparison helper

```rust
fn trees_equal(a: &Path, b: &Path) -> bool
```

- Recursively walk both directories; build the set of **relative paths** under each.
- Equal iff: relative-path sets are equal **and** for every path the entries match:
  - regular file ↔ regular file: byte-identical content;
  - symlink ↔ symlink: identical `read_link` target;
  - dir ↔ dir: (structure already covered by the path set);
  - any type mismatch → not equal.
- Does **not** follow symlinks out of the tree (compare the link itself).
- On any read error → return `false` (caller maps to `Diverged`).
- No persisted hashes; computed on demand. Skills are small (text + a few files); no
  size cap in this PR (noted as a known edge, §7).

### 4.4 Command

```rust
#[tauri::command] #[specta::specta]
pub async fn list_skill_divergences(
    db: State<'_, Db>,
    app: tauri::AppHandle,
) -> Result<Vec<SkillDivergence>, AppError>
```

- Gather project members via the **same aggregation PR1 uses** for
  `list_skill_workspaces` (reuse, do not re-implement scanning). Derive each
  `ProjectMember { repo_id, provider, name, member_path, dir_path }`.
- Resolve `central_root` (the `app_data_dir/skills-library` helper, as in `apply.rs`).
- Return `detect_divergence_core(&central_root, &members)`.
- DB-read failure surfaces as `AppError` (mirrors PR1's `list_skill_workspaces`); the
  core itself is infallible (per-item conservative).

### 4.5 bindings

`src/bindings.ts`: **+1 command** (`listSkillDivergences`), **+2 types**
(`SkillDivergence`, `DivergenceStatus`). Additive only — 0 deletions. Regenerated via
`cargo test` (no GUI needed). New types carry no DB PK → no specta i64 concern.

## 5. Front end

- `useSkillDivergences()` query hook in `src/lib/query/skills.ts` (calls
  `commands.listSkillDivergences`).
- Pure helper (sibling to `skillEnvNav.ts`, e.g. `skillDivergence.ts` +
  `.test.ts`): build `Map<memberPath, DivergenceStatus>` from the result and expose a
  lookup. No path inference (C6).
- `SkillsView.tsx` 프로젝트 section: for each rendered member skill, look up its
  `memberPath`; if `Diverged`, render a subtle inline marker (small dot or "·다름"
  label). `InSync` / absent → render nothing (no noise). No counts, no rollup.

## 6. Tests (TDD — write first)

**Rust (hermetic tempdir, like `apply.rs` tests):**

1. Identical central + project tree (SKILL.md + one aux file) → `InSync`.
2. Project edits `SKILL.md` body → `Diverged`.
3. Project adds an extra file → `Diverged`.
4. Project removes a file present in central → `Diverged`.
5. Nested subdirectory, identical on both sides → `InSync`.
6. Member dir is a symlink → omitted from output.
7. Member with no matching central skill → omitted from output.

**vitest:**

1. Index builder maps `memberPath` → status.
2. Lookup returns `Diverged` for a diverged member and `undefined` for an unknown
   path.

## 7. Invariants & known edges

**Invariants respected:**

- **#7** — disk-derived, no new table, no migration. ✓
- **#1/#2** — no job spawn; file reads only. ✓
- **Read-only** — pure comparison; writes to no directory. ✓
- **C7** — `member_path` / paths are display+match only, never logged. ✓
- **Network** — none. ✓
- **bindings** — additive only. ✓
- **IPC** — tauri-specta generated types; no hand-written TS IPC. ✓
- No new DB PK → no specta i64 issue. ✓

**Known edges (noted, not blocking):**

- Byte-compare reads whole files — fine for small skills; no size cap this PR.
- Case-insensitive macOS FS — both sides share FS semantics; relative-path set
  comparison is consistent.
- Cross-volume central vs project — out of scope.
- A skill whose central counterpart was renamed/removed → simply not a candidate
  (omitted), not surfaced as an error in this PR.

## 8. Out of scope (deferred)

- Copy-apply (vendoring central → project dir).
- Resolution writes (pull central→project, push project→central), diff view,
  user-confirmation flow.
- Aggregate divergence counts / headline badge (#17).
- 3-way / baseline snapshot (would require persistence → migration).
