# Skills Manager G1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a work-radar–owned central skill library with reversible import-from-external and an audit log, on top of a refactored `skills/` backend module — ADR-0006 G1 foundation only (no network, no external-dir writes).

**Architecture:** Three sequential PRs. PR1 splits the 89KB `commands/skills.rs` into a `src-tauri/src/skills/` module dir (zero behavior change). PR2 adds an append-only `skill_audit_log` SQLite table + `audit()` writer + `list_skill_audit` reader. PR3 adds `app_data_dir()/skills-library/<provider>/<name>/` as the managed-skill SSOT, with `import_external_skill` / `remove_managed_skill` (every write audited), and makes `list_skills` surface managed skills while suppressing the matching discovered entry (identity = name+provider, reusing P5 `groupCrossToolSkills`).

**Tech Stack:** Rust (Tauri 2, sqlx 0.8 SQLite, specta/tauri-specta bindings, AppError envelope), React/TS frontend, vitest, cargo test.

---

## Conventions (read once, applies to every task)

- **cargo PATH for every commit/cargo cmd:** `export PATH="$HOME/.cargo/bin:$PATH"` (husky pre-commit runs cargo fmt + lint-staged).
- **Gates (정본 `docs/reference/commands.md`):**
  - Rust: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`
  - Bindings drift: regenerate `src/bindings.ts` (it is produced by a `cargo test`), then `git diff --exit-code src/bindings.ts` must be **0** for PR1 and **only the intended commands** for PR2/PR3.
  - Frontend: `pnpm typecheck`, `pnpm lint` (0 errors; 2 pre-existing react-hooks warnings are known — do NOT "fix"), `pnpm vitest run`
  - Esc smoke (cmux/Playwright) only if a Sheet/overlay component is touched (PR3 frontend).
- **Tool reliability:** rtk-wrapped cargo output can be wrong → verify with `rtk proxy cargo …` or direct binary. After every push: `L=$(/usr/bin/git rev-parse HEAD); R=$(/usr/bin/git ls-remote origin refs/heads/dev | cut -f1); [ "$L" = "$R" ] && echo MATCH`.
- **Push policy:** push `dev` only (main is PR-only). One PR = one concern. No self-approve — each PR gets a separate critic (opus, THOROUGH) pass before commit, per AGENTS.md.
- **Rails (ADR-0006 / decision-rails):** no network and no external-dir writes in G1. Import only ever **copies** external→central and deletes the **central** copy on remove — the original external file is never written. audit `detail` carries path/action/size only — **no frontmatter body, no tokens**. Importing a skill spawns/runs no codex job (#1/#2 unchanged).
- **Decisions log:** after each PR merges, append a one-line breadcrumb to the **bottom** of `docs/decisions.md`.

---

## PR1 — Refactor: split `commands/skills.rs` into `skills/` module (zero behavior change)

**Why:** The G1 features (central_repo, import, audit_log) must land as focused sibling modules, not appended to an 89KB file. This PR moves code **verbatim** — no logic change — so the proof of correctness is "all existing tests still pass + bindings drift 0".

### File structure (target)

> **Refinement vs spec §2 (verified against the real file):** the 118-line **model stays in `crate::models::skills`** — do NOT move it. It is part of `crate::models` (it uses `super::AgentReasoningEffort` and is imported crate-wide via `use crate::models::{Skill, …}`); moving it would touch every import site for zero benefit. The 89KB problem is the **command** file only. So PR1 splits `commands/skills.rs` and the new `skills/` modules import the model via `use crate::models::{…}`. (Names below are the **actual** symbols in `commands/skills.rs`, confirmed by reading it.)

```
src-tauri/src/skills/               (NEW — split out of commands/skills.rs; model NOT moved)
  mod.rs        — `pub mod` decls + re-exports of the #[tauri::command] fns (kept pub)
  seed.rs       — binding consts (BINDING_*), FAST_CODEX_MODEL, WORKTREE_REVIEW_PROMPT,
                  WORKTREE_CLEANUP_PROMPT, KEY_USER_SKILL_ROOTS, seed_defs(), fallback_prompt(),
                  seed_in_app_skills(), resolve_prompt(), resolve_agent_prompt_runtime()
  scan.rs       — RECURSIVE_MAX_DEPTH; SkillRoot (struct + flat()/recursive() impls);
                  REPO_SKILL_DIRS, repo_skill_roots(), is_ignored_dir(); SkillRootEnv (+ from_process());
                  resolve_skill_roots(), skill_roots_db(), read_user_skill_roots(),
                  normalize_user_skill_roots(), user_skill_roots(); parse_frontmatter(), unquote(),
                  skill_id_from_path(), scan_external_skills_core(), scan_root();
                  detect_skill_environments_core(); commands: detect_skill_environments,
                  get_skill_user_roots, set_skill_user_roots, scan_external_skills,
                  read_external_skill, write_external_skill; ensure_within_skills_dir_roots()
  tags.rs       — MAX_TAG_LEN, normalize_tags(), set_skill_tags_core(); command: set_skill_tags
  registry.rs   — list_skills_core(), load_tags_by_key(); commands: list_skills, update_skill,
                  create_skill, delete_skill (and the UpdateSkillInput type if it is defined in
                  commands/skills.rs — check; if it lives in models, leave it there)
```

> `fetch_all_repos` is **not** moved — it lives in `crate::commands::projects`; scan.rs keeps importing it via `use crate::commands::projects::fetch_all_repos`.
> `skill_id_from_path` is used in `list_skills_core` (registry) and defined among the scan helpers — make it `pub(crate)` in scan.rs so registry can call it.
> The current `#[cfg(test)] mod tests` block at the end of `commands/skills.rs` moves **with the functions it exercises** (scan/root/path-guard/frontmatter tests → `scan.rs`; tag tests → `tags.rs`; list/crud/resolve/fallback tests → `registry.rs`; resolve/seed tests → `seed.rs`). Keep every existing test; do not rename or delete any. Test-only helpers (`create_skill_core`/`update_skill_core`/`delete_skill_core`/`set_user_roots_core`/`make_skill`/`make_repo`/`root`) move with their tests.

**Files:**

- Create: `src-tauri/src/skills/mod.rs`, `skills/seed.rs`, `skills/scan.rs`, `skills/tags.rs`, `skills/registry.rs`
- Delete: `src-tauri/src/commands/skills.rs` (its content is split into the four files above)
- Keep (do NOT move): `src-tauri/src/models/skills.rs` and `src-tauri/src/models/mod.rs` — the model stays in `crate::models`.
- Modify: `src-tauri/src/commands/mod.rs` (remove `pub mod skills;`), `src-tauri/src/lib.rs` (add `pub mod skills;` at crate root + change command registration paths `commands::skills::X` → `skills::X`), and any `use crate::commands::skills::…` import sites across the crate (grep below). `use crate::models::…` sites are unchanged.

- [ ] **Step 1: Capture the green baseline (so the refactor can be proven behavior-neutral)**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test 2>&1 | tail -5   # record the pass count, e.g. "test result: ok. N passed"
cd .. && pnpm vitest run 2>&1 | tail -3      # record N pass
git rev-parse HEAD:src/bindings.ts           # record the bindings blob hash
```

Expected: all green. Write the numbers down — they must be unchanged at Step 7.

- [ ] **Step 2: Read the real shape before moving (tool-flakiness guard)**

The earlier survey was partial. Before moving anything, open `src-tauri/src/commands/skills.rs` and `src-tauri/src/models/skills.rs` and confirm: (a) the full `use` header, (b) every symbol from the File-structure map exists at the listed name, (c) which test fns reference which functions. If a symbol differs, update the map — do not invent.

- [ ] **Step 3: (model is NOT moved — skip)**

The model stays in `crate::models::skills`. The new `skills/` modules import it via `use crate::models::{Skill, ExternalSkill, SkillProvider, SkillEnvironment, UserSkillRoot, CreateSkillInput, Provider, Repo}` (mirror the exact `use crate::models::{…}` list currently at the top of `commands/skills.rs`).

- [ ] **Step 4: Create the four logic modules by moving functions verbatim**

For each of `seed.rs`, `scan.rs`, `tags.rs`, `registry.rs`: move the functions listed in the File-structure map **byte-for-byte**. Add a per-file `use` header importing exactly what that file references (start from the current `commands/skills.rs` header: `use tauri::State; use crate::db::Db; use crate::error::AppError; use crate::models::{…}; use std::path::{Path, PathBuf};` plus `use crate::commands::agents::{BATCH_ENRICH_PROMPT, CI_TRIAGE_PROMPT, PR_SELFCHECK_PROMPT};` in seed.rs, `use crate::commands::nav::{get_config, set_config};` + `use crate::commands::projects::fetch_all_repos;` in scan.rs). Cross-module callees become `pub(crate)` — confirmed list: `seed_defs`, `fallback_prompt`, `resolve_prompt`, `resolve_agent_prompt_runtime`, the `BINDING_*` consts, `FAST_CODEX_MODEL` (seed.rs); `RECURSIVE_MAX_DEPTH`, `SkillRoot`, `skill_roots_db`, `resolve_skill_roots`, `parse_frontmatter`, `skill_id_from_path`, `scan_external_skills_core`, `ensure_within_skills_dir_roots`, `detect_skill_environments_core` (scan.rs); `normalize_tags`, `set_skill_tags_core`, `load_tags_by_key`, `list_skills_core` (tags/registry). Move each `#[cfg(test)] mod tests` fn next to the code it tests (one `#[cfg(test)] mod tests` block per module). NOTE: the in-source ordering means a single grep pass after the move (`cargo build`) will name every still-private symbol that needs widening — fix them iteratively until it compiles.

- [ ] **Step 5: Write `skills/mod.rs` (decls + re-exports)**

```rust
//! 스킬 레지스트리 — 뷰어(A–F) + 풀 매니저(G, ADR-0006). 모듈 분할(G1-PR1, 무행동변경).
//! 레일(불변): 외부 토큰 keychain, 로그 시크릿 금지, codex 잡 자동실행 금지(#1/#2),
//! 외부 파일은 사용자 명시 액션으로만 쓰기(경로 가드).
pub mod registry;
pub mod scan;
pub mod seed;
pub mod tags;

// 기존 호출부(lib.rs invoke_handler, 다른 모듈)가 경로 변경 없이 쓰도록 커맨드/헬퍼 re-export.
pub use registry::{create_skill, delete_skill, list_skills, list_skills_core, update_skill};
pub use scan::{
    detect_skill_environments, get_skill_user_roots, read_external_skill, scan_external_skills,
    set_skill_user_roots, write_external_skill,
};
pub use seed::{resolve_agent_prompt_runtime, resolve_prompt, seed_in_app_skills};
pub use tags::set_skill_tags;
```

> If any other module imported a now-private helper directly (e.g. `commands::skills::resolve_prompt`), keep that path working via the re-export above, or update the import site in Step 6.

- [ ] **Step 6: Rewire module tree + import sites**
  - In `src-tauri/src/commands/mod.rs`: remove `pub mod skills;`.
  - In `src-tauri/src/models/mod.rs`: remove `pub mod skills;`.
  - In `src-tauri/src/lib.rs`: add `pub mod skills;` at crate root; update command registration from `commands::skills::X` → `skills::X` (or `crate::skills::X`).
  - Grep and fix every other reference: `grep -rn "commands::skills" src-tauri/src; grep -rn "models::skills" src-tauri/src` → rewrite to `crate::skills::` / `crate::skills::model::`.
  - Delete `src-tauri/src/commands/skills.rs` and `src-tauri/src/models/skills.rs`.

- [ ] **Step 7: Verify behavior-neutral (the whole point of this PR)**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test 2>&1 | tail -5
cd .. && pnpm typecheck && pnpm lint && pnpm vitest run 2>&1 | tail -3
git diff --exit-code src/bindings.ts && echo "BINDINGS DRIFT 0 ✅"
```

Expected: cargo test pass count **identical** to Step 1; vitest identical; clippy 0; fmt clean; **bindings drift 0** (proves the IPC surface is byte-identical). If the pass count dropped, a test got lost in the move — find it before continuing.

- [ ] **Step 8: Critic pass (separate context) → then commit + push**

Dispatch `oh-my-claudecode:critic` (opus, THOROUGH): "Verify this is a pure move refactor — no logic/behavior change, no lost test, no widened visibility beyond what cross-module calls require. Check INVARIANTs untouched." Require ACCEPT (0 blocking).

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add -A
git commit -m "refactor(skills): commands/skills.rs → skills/ 모듈 분할 (무행동변경, G1-PR1)"
git push origin HEAD:dev
L=$(/usr/bin/git rev-parse HEAD); R=$(/usr/bin/git ls-remote origin refs/heads/dev | cut -f1); [ "$L" = "$R" ] && echo MATCH
```

Then append a `docs/decisions.md` breadcrumb (bottom).

---

## PR2 — `skill_audit_log` table + `audit()` writer + `list_skill_audit` reader

**Why:** Every managed-store write (PR3) must be auditable (ADR-0006 rail ①). Land the audit substrate first so PR3 can call `audit()` from day one.

**Files:**

- Create: `src-tauri/migrations/0039_skill_audit_log.sql`
- Create: `src-tauri/src/skills/audit_log.rs`
- Modify: `src-tauri/src/skills/mod.rs` (add `pub mod audit_log;` + re-export `list_skill_audit`), `src-tauri/src/lib.rs` (register `list_skill_audit` in the specta/invoke handler)

- [ ] **Step 1: Write the migration**

Create `src-tauri/migrations/0039_skill_audit_log.sql`:

```sql
-- Work Radar — schema v39 (G1: 스킬 매니저 감사 로그)
-- 스키마 변경은 새 마이그레이션으로만(임의 ALTER 금지 — INVARIANT).
--
-- 왜: ADR-0006 레일 ① — 중앙 라이브러리에 대한 모든 쓰기(import/remove/…)는 가역·감사 가능해야 한다.
-- append-only 기록. PII/시크릿 금지: detail에는 경로/action/크기만, frontmatter 본문·토큰 절대 금지.
PRAGMA foreign_keys = ON;

CREATE TABLE skill_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,                       -- "import" | "remove" (G1.5에서 install/update 등 추가)
  target_kind TEXT NOT NULL,                       -- "managed_skill"
  target_ref  TEXT NOT NULL,                       -- 중앙 스토어 경로(시크릿 아님)
  source_ref  TEXT,                                -- 원본 외부 경로(import 시) — nullable
  detail      TEXT,                                -- 비밀-free 메모(예: "files=3,bytes=1024") — nullable
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 시간순 조회 핫패스(최근 먼저).
CREATE INDEX idx_skill_audit_created ON skill_audit_log (created_at DESC);
```

- [ ] **Step 2: Write the failing test for `audit()` + `list_skill_audit_core`**

In `src-tauri/src/skills/audit_log.rs`, add a `#[cfg(test)] mod tests`. Use the repo's existing hermetic DB helper pattern (see `db.rs` tests: a tempdir sqlite + `sqlx::migrate!`). Confirm the helper name in `db.rs`/test utils before writing; if there's a shared `test_db()`/`init_db(temp)` use it.

```rust
#[tokio::test]
async fn audit_appends_and_lists_newest_first() {
    let pool = test_pool().await; // hermetic: tempdir db with migrations applied
    audit(&pool, "import", "managed_skill", "/lib/claude/foo", Some("/home/.claude/skills/foo"), Some("files=2,bytes=10"))
        .await
        .expect("audit import");
    audit(&pool, "remove", "managed_skill", "/lib/claude/foo", None, None)
        .await
        .expect("audit remove");
    let rows = list_skill_audit_core(&pool).await.expect("list");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].action, "remove"); // newest first
    assert_eq!(rows[1].action, "import");
    assert_eq!(rows[1].source_ref.as_deref(), Some("/home/.claude/skills/foo"));
}

#[tokio::test]
async fn audit_detail_carries_no_secret_body() {
    // detail은 호출자가 비밀-free로 구성한다는 계약을 문서화/잠금하는 가드.
    let pool = test_pool().await;
    audit(&pool, "import", "managed_skill", "/lib/x", None, Some("files=1,bytes=5")).await.unwrap();
    let rows = list_skill_audit_core(&pool).await.unwrap();
    assert!(!rows[0].detail.as_deref().unwrap_or("").contains("SKILL"));
}
```

- [ ] **Step 3: Run the test, expect FAIL**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib skills::audit_log 2>&1 | tail -8
```

Expected: FAIL (function not defined / type not found).

- [ ] **Step 4: Implement `audit_log.rs`**

```rust
//! 스킬 매니저 감사 로그(G1, ADR-0006 레일 ①). append-only. detail은 비밀-free.
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::db::Db;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillAuditEntry {
    pub id: i64,
    pub action: String,
    pub target_kind: String,
    pub target_ref: String,
    pub source_ref: Option<String>,
    pub detail: Option<String>,
    pub created_at: String,
}

/// 중앙 스토어 쓰기 1건 기록. 호출자는 target_ref/source_ref/detail에 **시크릿/PII 금지**.
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

pub(crate) async fn list_skill_audit_core(pool: &SqlitePool) -> Result<Vec<SkillAuditEntry>, AppError> {
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
    list_skill_audit_core(&db).await
}
```

> `SkillAuditEntry` needs `#[derive(sqlx::FromRow)]` if the repo's `query_as` uses it — match how `Skill`/`ExternalSkill` derive row mapping (check `model.rs`). If they use `#[derive(... )]` with sqlx, add `sqlx::FromRow`. Column order in the SELECT matches struct field order.

- [ ] **Step 5: Wire module + command registration**
  - `skills/mod.rs`: add `pub mod audit_log;` and `pub use audit_log::list_skill_audit;`.
  - `lib.rs`: add `list_skill_audit` to the specta `collect_commands!`/`invoke_handler` list (same place the other skills commands are registered).

- [ ] **Step 6: Run tests + regenerate bindings**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib skills::audit_log 2>&1 | tail -8 && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && git --no-pager diff --stat src/bindings.ts
```

Expected: audit tests PASS; clippy 0; bindings diff shows **only** the new `listSkillAudit` command + `SkillAuditEntry` type.

- [ ] **Step 7: Critic → commit + push + decisions breadcrumb**

Critic (opus, THOROUGH): "Audit table append-only? detail/target_ref free of secrets by contract? bindings drift = intended only?" Require ACCEPT.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add -A
git commit -m "feat(skills): skill_audit_log 테이블 + audit() + list_skill_audit (G1-PR2)"
git push origin HEAD:dev
L=$(/usr/bin/git rev-parse HEAD); R=$(/usr/bin/git ls-remote origin refs/heads/dev | cut -f1); [ "$L" = "$R" ] && echo MATCH
```

---

## PR3 — Central library + import round-trip (managed supersedes discovered)

**Why:** The core G1 value — a work-radar–owned managed store with reversible import (ADR-0006 rail ②), every write audited (rail ①).

**Files:**

- Create: `src-tauri/src/skills/central_repo.rs` (pure-ish fs ops, tempdir-testable)
- Create: `src-tauri/src/skills/import.rs` (`#[tauri::command]` import/remove wiring central_repo + audit)
- Modify: `src-tauri/src/skills/registry.rs` (`list_skills_core`: include managed + suppress discovered dup)
- Modify: `src-tauri/src/skills/mod.rs`, `src-tauri/src/lib.rs` (register `import_external_skill`, `remove_managed_skill`)
- Modify (frontend): `src/components/SkillsView.tsx` (Import action + managed badge), reuse `src/lib/skillDedup.ts`
- Test: hermetic Rust tests in `central_repo.rs` / `import.rs`; frontend pure-helper test if logic added

### Managed-skill contract (locks naming used below)

- Central store root: `central_root(app) = app.path().app_data_dir()?.join("skills-library")`.
- A managed skill lives at `central_root/<provider>/<name>/` and always contains `SKILL.md` (+ any sibling files copied from source).
- In `list_skills`, a managed skill is a `Skill` built **exactly like the external branch of `list_skills_core`** (confirmed shape, registry.rs ~L196–213): `kind = "managed"`, `provider = Some(<provider>)`, `id = format!("managed:{}", <central SKILL.md abs path>)`, `prompt = Some(description)`, `binding = None`, `rail = None`, `enabled = true`, `model = None`, `reasoning_effort = None`, `fast_mode = false`, `source_path = Some(<central SKILL.md path>)`, `tags = Vec::new()` (then filled by `load_tags_by_key` like others), `fallback_prompt = None`, `created_at`/`updated_at = String::new()`, `name`/`description` from `parse_frontmatter`.
- **Suppression:** when a managed skill exists with the same `(name, provider)` as a discovered external skill, the discovered one is omitted from `list_skills`. Build a `HashSet<(String /*name lower+trim*/, SkillProvider)>` from managed skills and skip discovered externals whose `(name, provider)` is in it. This mirrors the P5 frontend identity in `src/lib/skillDedup.ts:groupCrossToolSkills` (name, case/trim-insensitive).

> Building block (confirmed real names): there is **no** `parse_external_skill` function. To turn a single `SKILL.md` into name/description, read the file and call `parse_frontmatter(&content) -> (Option<String>, Option<String>)` (scan.rs ~L777; name falls back to the dir name, description to ""). The external→`Skill` construction lives inline in `list_skills_core` (registry.rs) — the managed branch copies that struct literal with `kind="managed"`.

- [ ] **Step 1: Failing test — central copy + remove round-trip (hermetic)**

In `central_repo.rs` `#[cfg(test)] mod tests`:

```rust
#[test]
fn import_copies_then_remove_deletes_central_only_external_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    // fake external skill
    let ext = tmp.path().join("ext/.claude/skills/foo");
    std::fs::create_dir_all(&ext).unwrap();
    let ext_md = ext.join("SKILL.md");
    std::fs::write(&ext_md, "---\nname: foo\n---\nbody").unwrap();
    // fake central root
    let central = tmp.path().join("skills-library");

    let dest = import_to_central(&central, "claude", "foo", &ext).expect("import");
    assert!(dest.join("SKILL.md").exists());
    assert_eq!(std::fs::read_to_string(dest.join("SKILL.md")).unwrap(),
               std::fs::read_to_string(&ext_md).unwrap()); // content matches

    remove_from_central(&central, "claude", "foo").expect("remove");
    assert!(!dest.exists());                 // central copy gone
    assert!(ext_md.exists());                // EXTERNAL FILE UNTOUCHED (rail ②)
}
```

> Confirm `tempfile` is already a dev-dependency (it's used in db.rs tests pattern — if those use `std::env::temp_dir()` instead, follow that style and clean up the dir).

- [ ] **Step 2: Run, expect FAIL**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib skills::central_repo 2>&1 | tail -8
```

Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement `central_repo.rs`**

```rust
//! 중앙 라이브러리(G1, ADR-0006 레일 ②) — work-radar 소유 managed 스킬 스토어.
//! managed 스킬 = app_data_dir/skills-library/<provider>/<name>/. 디스크가 managed SSOT.
use crate::error::AppError;
use std::path::{Path, PathBuf};

/// <central>/<provider>/<name>
pub(crate) fn central_skill_dir(central_root: &Path, provider: &str, name: &str) -> PathBuf {
    central_root.join(provider).join(name)
}

/// 외부 스킬 dir(src_dir, SKILL.md 포함)을 중앙으로 복사. dest dir 반환.
/// 기존 dest가 있으면 덮어쓰기 전에 제거(재import 멱등). 외부(src)는 읽기만 한다.
pub(crate) fn import_to_central(
    central_root: &Path,
    provider: &str,
    name: &str,
    src_dir: &Path,
) -> Result<PathBuf, AppError> {
    let dest = central_skill_dir(central_root, provider, name);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    std::fs::create_dir_all(&dest)?;
    copy_dir_shallow(src_dir, &dest)?; // SKILL.md + 형제 파일 복사(서브디렉터리 포함)
    Ok(dest)
}

/// 중앙 복사본만 삭제(가역). 외부 파일은 절대 건드리지 않는다.
pub(crate) fn remove_from_central(central_root: &Path, provider: &str, name: &str) -> Result<(), AppError> {
    let dest = central_skill_dir(central_root, provider, name);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    Ok(())
}

/// 디렉터리 재귀 복사(파일 + 서브디렉터리). 심링크는 따라가지 않고 건너뛴다(외부 dir 안전).
fn copy_dir_shallow(src: &Path, dest: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if ft.is_symlink() {
            continue;
        } else if ft.is_dir() {
            std::fs::create_dir_all(&to)?;
            copy_dir_shallow(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
```

> If `AppError` has no `From<std::io::Error>`, add it next to the other `From` impls in `src-tauri/src/error.rs` (one line: `#[from] std::io::Error` variant or a manual `impl`). Check first — it likely already exists since the codebase does fs I/O.

- [ ] **Step 4: Run central_repo test, expect PASS**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib skills::central_repo 2>&1 | tail -8
```

Expected: PASS.

- [ ] **Step 5: Failing test — `import_external_skill` writes audit + is idempotent**

In `import.rs` tests (hermetic: needs both a pool and an app_data dir; if `app_data_dir()` is hard to fake in tests, factor the command body into `import_external_skill_core(pool, central_root, ext_path)` and test the core with a tempdir central_root + tempdir external skill, exactly like central_repo's test). Test:

```rust
#[tokio::test]
async fn import_core_copies_and_audits() {
    let pool = test_pool().await;
    let tmp = tempfile::tempdir().unwrap();
    let central = tmp.path().join("skills-library");
    let ext = tmp.path().join(".claude/skills/foo");
    std::fs::create_dir_all(&ext).unwrap();
    std::fs::write(ext.join("SKILL.md"), "---\nname: foo\n---\nbody").unwrap();

    let skill = import_external_skill_core(&pool, &central, &ext.join("SKILL.md"), "claude").await.expect("import");
    assert_eq!(skill.kind, "managed");
    let audit = crate::skills::audit_log::list_skill_audit_core(&pool).await.unwrap();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].action, "import");
    assert!(audit[0].detail.as_deref().map_or(true, |d| !d.contains("body"))); // no body in audit
}
```

- [ ] **Step 6: Run, expect FAIL; then implement `import.rs`**

```rust
//! 스킬 import(G1, ADR-0006 레일 ①②) — 발견 외부 스킬 → 중앙 복사(가역, 감사).
use crate::db::Db;
use crate::error::AppError;
use crate::skills::audit_log::audit;
use crate::skills::central_repo::{central_skill_dir, import_to_central, remove_from_central};
use crate::models::{Skill, SkillProvider};
use crate::skills::scan::parse_frontmatter; // (Option<name>, Option<description>)
use sqlx::SqlitePool;
use std::path::Path;
use tauri::{Manager, State};

/// core: 테스트 가능(앱 핸들 비의존). central_root + 외부 SKILL.md 경로 + provider.
pub(crate) async fn import_external_skill_core(
    pool: &SqlitePool,
    central_root: &Path,
    ext_skill_md: &Path,
    provider: SkillProvider,
) -> Result<Skill, AppError> {
    let src_dir = ext_skill_md
        .parent()
        .ok_or_else(|| AppError::validation("skills.import", "bad skill path"))?;
    let content = std::fs::read_to_string(ext_skill_md)
        .map_err(|e| AppError::terminal("skills.import_read", format!("SKILL.md 읽기 실패: {e}")))?;
    let (fm_name, fm_desc) = parse_frontmatter(&content);
    // name = frontmatter name 또는 src dir 이름 폴백(경로 세그먼트로 안전화).
    let name = sanitize_segment(&fm_name.unwrap_or_else(|| dir_name(src_dir)));
    let provider_str = provider_segment(provider); // "claude"/"codex"/...
    let dest = import_to_central(central_root, provider_str, &name, src_dir)?;
    let detail = format!("files={}", count_files(&dest));
    audit(
        pool,
        "import",
        "managed_skill",
        &dest.to_string_lossy(),
        Some(&ext_skill_md.to_string_lossy()),
        Some(&detail),
    )
    .await?;
    // managed Skill 생성: list_skills_core의 external 분기 struct 리터럴을 kind="managed"로 복제.
    let md_path = dest.join("SKILL.md");
    Ok(Skill {
        id: format!("managed:{}", md_path.to_string_lossy()),
        name,
        kind: "managed".into(),
        prompt: Some(fm_desc.unwrap_or_default()),
        binding: None,
        rail: None,
        enabled: true,
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        source_path: Some(md_path.to_string_lossy().into_owned()),
        provider: Some(provider),
        tags: Vec::new(),
        fallback_prompt: None,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn import_external_skill(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    path: String,
    provider: SkillProvider,
) -> Result<Skill, AppError> {
    let central = app.path().app_data_dir()?.join("skills-library");
    import_external_skill_core(&db, &central, Path::new(&path), provider).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_managed_skill(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    provider: SkillProvider,
    name: String,
) -> Result<(), AppError> {
    let central = app.path().app_data_dir()?.join("skills-library");
    let provider_str = provider_segment(provider);
    let dest = central_skill_dir(&central, provider_str, &name);
    remove_from_central(&central, provider_str, &name)?;
    audit(&db, "remove", "managed_skill", &dest.to_string_lossy(), None, None).await
}
```

> Helpers to write in `import.rs`: `dir_name(p: &Path) -> String` (`p.file_name()` lossy, fallback `"skill"`); `sanitize_segment(s: &str) -> String` (trim + strip `/`, `\`, `..` → one safe path segment so import can never escape `<central>/<provider>/`); `provider_segment(p: SkillProvider) -> &'static str` (match → `"claude"|"codex"|"openclaw"|"hermes"|"other"`, matching `#[serde(rename_all="lowercase")]` on `SkillProvider`); `count_files(dir: &Path) -> usize` (shallow file count for the audit detail — never reads contents). Confirmed real error constructors (from `commands/skills.rs`): `AppError::validation(code, msg)` and `AppError::terminal(code, msg)` — use those (NOT `AppError::Validation`). The managed `Skill` literal is the one in the §contract above (copied from `list_skills_core`'s external branch).

- [ ] **Step 7: Implement managed inclusion + discovered suppression in `registry.rs`**

In `list_skills_core`, after assembling in-app + discovered-external skills, also scan the central store and merge:

```rust
// managed 스킬 스캔(중앙 라이브러리 = managed SSOT). list_skills_core는 현재 (db, &[SkillRoot])를
// 받으므로, central_root를 받는 inner를 추가: list_skills_core_with(db, roots, central_root).
// 커맨드 list_skills는 app_data_dir/skills-library를 구해 inner에 넘긴다(테스트는 tempdir 전달).
// 1) central_root/<provider>/<name>/SKILL.md 마다: read_to_string → parse_frontmatter(&content)
//    → kind="managed" Skill 리터럴(위 §contract 그대로) push. (없으면 managed 0개 = no-op.)
// 2) managed_keys: HashSet<(name.trim().to_lowercase(), provider)> 구성.
// 3) external 분기에서 (name,provider)가 managed_keys에 있으면 push 스킵(suppress).
```

Write a hermetic test in `registry.rs`: create one external skill + import it into a tempdir central, then assert `list_skills_core_with_roots(...)` returns exactly one entry for that (name, provider) and its `kind == "managed"`.

> Because `list_skills_core` currently takes `&SqlitePool` (and derives roots via `skill_roots_db`), add a testable inner `list_skills_core_with(pool, roots, central_root)` and have both `list_skills` (command) and the existing core delegate to it. Keep the existing public signature working (re-export) so PR1's wiring stays valid.

- [ ] **Step 8: Wire module + commands + bindings**
  - `skills/mod.rs`: `pub mod central_repo; pub mod import;` + `pub use import::{import_external_skill, remove_managed_skill};`
  - `lib.rs`: register `import_external_skill`, `remove_managed_skill` in the command list.
  - Run: `cd src-tauri && cargo test 2>&1 | tail -5 && cargo clippy --all-targets -- -D warnings && cargo fmt --check; cd .. && pnpm typecheck && git --no-pager diff --stat src/bindings.ts`
  - Expected: all green; bindings diff = `importExternalSkill`, `removeManagedSkill`, `listSkillAudit` (from PR2 already merged) — confirm only intended additions, plus `kind:"managed"` is just a string (no type change).

- [ ] **Step 9: Frontend — Import action + managed badge (SkillsView)**
  - In `SkillsView.tsx`, on a discovered external skill card/Sheet, add an **"라이브러리로 import"** action calling a new `useImportExternalSkill` hook → `commands.importExternalSkill(path, provider)`; invalidate the skills query so the list refetches.
  - Managed skills (`kind === "managed"`) render with a **"managed" badge** (extend `src/lib/skillBadges.ts:skillCardBadges` — add a managed badge branch; keep the pure-function + unit-test pattern from P3-PR-C) and a provenance note ("imported from …" — the source path is shown only if available; managed `Skill` carries the central path, so phrase it as "라이브러리 관리 중").
  - On a managed card, add **"라이브러리에서 제거"** → `commands.removeManagedSkill(provider, name)` (window.confirm), invalidate.
  - Suppression of the discovered duplicate is already done on the backend (Step 7); the frontend just renders what `list_skills` returns. Do NOT also dedup on the frontend for this (avoid double-suppression) — but `groupCrossToolSkills` still runs for cross-tool grouping of the remaining items, which is fine.
  - If the Import/remove UI lives inside the Sheet, run the **Esc smoke** (cmux/Playwright) per shadcn-migration Esc contract.

- [ ] **Step 10: Frontend gates**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run 2>&1 | tail -3
```

Expected: 0 errors (2 known warnings), vitest green incl. new skillBadges managed test.

- [ ] **Step 11: Critic → commit + push + decisions breadcrumb**

Critic (opus, THOROUGH): "Import only copies (external file never written)? remove deletes central only? every write audited, no secrets in audit? managed suppresses discovered by (name,provider)? #1/#2 unchanged (no job spawned on import)? bindings drift intended only? Esc contract held if Sheet touched?" Require ACCEPT.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add -A
git commit -m "feat(skills): 중앙 라이브러리 + import round-trip (managed supersedes discovered, G1-PR3)"
git push origin HEAD:dev
L=$(/usr/bin/git rev-parse HEAD); R=$(/usr/bin/git ls-remote origin refs/heads/dev | cut -f1); [ "$L" = "$R" ] && echo MATCH
```

Append `docs/decisions.md` breadcrumb. G1 foundation complete → next round is G1.5 (network/backup/auto-update) or G2 (external-dir apply).

---

## Self-Review (against the spec)

**Spec coverage (§1–§7 of the design spec):**

- §2 module layout → PR1 (File structure) ✅
- §3 PR1 refactor / PR2 audit_log / PR3 central+import → three PR sections ✅
- §3 central store at `app_data_dir/skills-library/<provider>/<name>/` → PR3 central_repo contract ✅
- §3 import identity name+provider, managed suppresses discovered → PR3 Step 7 ✅ (reuses skillDedup identity)
- §3 audit_log = SQLite table 0039, path/action/size only → PR2 ✅
- §4 data flow (import → managed; remove → central only) → PR3 Steps 3/6 ✅
- §5 rails: AppError envelope, reversible, no secrets, #1/#2 → enforced in each critic step ✅
- §6 tests: round-trip, dedup, audit, #1/#2 guard → PR3 Steps 1/5/7 + critic ✅
- §7 Done-criteria → covered across PR1–PR3 gates ✅

**Placeholder scan:** No "TBD/TODO". The `>` callouts are explicit "confirm-the-current-shape" instructions made necessary by the worktree read-flakiness — they name exactly what to verify, not vague "handle edge cases". Acceptable.

**Type consistency:** `import_to_central`/`remove_from_central`/`central_skill_dir` (central_repo) ↔ used identically in import.rs. `audit()`/`list_skill_audit_core`/`SkillAuditEntry` consistent PR2↔PR3. `import_external_skill_core` ↔ command `import_external_skill`. Managed `Skill { kind:"managed", id:"managed:"+path }` consistent across PR3 Steps 6/7/9.

**Verified against source (2026-05-31):** the symbol map, the external→`Skill` literal (registry.rs `list_skills_core` L196–213), `parse_frontmatter`/`scan_root`/`scan_external_skills_core`/`ensure_within_skills_dir_roots`, and the real error constructors (`AppError::validation(code,msg)` / `AppError::terminal(code,msg)`) were all read from `commands/skills.rs` and the plan corrected to match (no `parse_external_skill` — it doesn't exist; model stays in `crate::models`). Remaining "confirm" notes (UpdateSkillInput location, `From<std::io::Error>` presence, exact `commands::skills::` import sites) are genuine local checks, not fabricated names. NOTE: this worktree's Read/Edit tools intermittently returned stale/hallucinated snapshots during authoring — the executor should trust `cargo build` errors over any single file read, and re-verify with plain `git`/`grep` if a read looks off.
