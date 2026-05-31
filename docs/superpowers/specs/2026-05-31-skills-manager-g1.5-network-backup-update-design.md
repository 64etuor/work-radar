# G1.5 — Network Install + Git Backup + Auto-Updater (design)

- Date: 2026-05-31
- Phase: **G1.5** of the skills-manager migration (`docs/plans/2026-05-29-skills-manager-migration.md`)
- Builds on: **G1 foundation** (central library + reversible import + audit_log), landed on dev @ `af40077`
- Rails: **ADR-0006** (`docs/adr/0006-skills-registry-full-manager.md`) — rails 3 (network install) & 4 (auto-update)
- Status: design — pending user review → `writing-plans`

## 1. Problem & goal

G1 gave work-radar a central managed-skill library (`app_data_dir()/skills-library/<provider>/<name>/`)
with reversible local **import** and an append-only **audit_log**. The library can only be filled from
skills already on disk. G1.5 adds the three remaining ADR-0006 capabilities, each strictly inside its rail:

1. **Network install** — pull a skill from a remote git repository into the central library. (Rail 3)
2. **Backup / restore** — versioned, reversible snapshots of the central library. (reversibility rail)
3. **Auto-updater** — opt-in, bounded, **fetch-only** upstream update checks. (Rail 4)

Non-goals (hard): writing to external agent dirs (that is **G2**), bidirectional sync (**G3**),
auto-applying or auto-running skills/jobs (**permanent** — INVARIANT #1/#2).

## 2. Decisions locked during brainstorming

| #   | Decision                                                                              | Rationale                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **HTTP tarball, no git crate / no system git**                                        | reqwest+octocrab already present, rustls-consistent (Cargo deliberately avoids openssl/system-git); desktop-distribution friendly. |
| D2  | **Install source = git repos, GitHub first**                                          | octocrab already wired with auth + tarball + retry. GitLab/Gitea/self-hosted + skills.sh marketplace = a later follow-up.          |
| D3  | **Auto-update trigger = both** manual check **and** an opt-in bounded on-launch check | user-configurable; manual is the always-on path, on-launch is a setting.                                                           |
| D4  | **Provenance lives in a DB table** (`migration 0040_skill_source`)                    | queryable (list updatable/opted-in), keeps fs skill dirs pristine; restore reconciles.                                             |
| D5  | **Backup = local on-disk versioned snapshots**                                        | direct consequence of D1 (no git); reversible via pre-restore safety snapshot.                                                     |

## 3. Reused infrastructure (no reinvention)

- `src-tauri/src/retry.rs::with_retry(max_attempts, base_delay, op)` + `Retryable` trait — all network
  calls are bounded (exponential backoff + jitter, terminal failure surfaced). Errors self-classify.
- `src-tauri/src/keychain.rs::{get,set,has,delete}_token(credential_ref, TokenKind)` — GitHub token for
  private-repo fetches. **Tokens never cross the IPC boundary.**
- `src-tauri/src/error.rs` `AppError` — single envelope; `ErrorKind` = `Transient`/`Terminal`/`NotFound`/
  `Forbidden`/`Cancelled` (constructors `transient`/`terminal`/`not_found`/`forbidden`). New domain errors
  get one `From` arm each.
- `src-tauri/src/skills/central_repo.rs` — `skills-library/<provider>/<name>/` layout + `sanitize_segment`
  path-traversal defense (reused for tar extraction).
- `src-tauri/src/skills/import.rs` — `import_external_skill(path, provider)` copy-into-central + suppress
  discovered + audit. **Network install reuses this pipeline verbatim** with a temp dir as the source.
- `src-tauri/src/skills/audit_log.rs::audit(&app, action, target_kind, target_ref, source_ref, detail)` —
  (takes `AppHandle`, reads the `Db` pool from managed state) extended with new actions; **path/size/action
  only, no secrets**.
- `src-tauri/src/skills/registry.rs` — managed-supersedes-discovered identity (name+provider).

New deps (both pure-Rust, lightweight, no system/openssl impact): **`flate2`** + **`tar`** for `.tar.gz`
extraction. (GitHub codeload / octocrab tarballs are gzip tarballs.)

## 4. Module layout (new files under `src-tauri/src/skills/`)

- **`remote.rs`** — remote source plumbing.
  - `parse_source(url) -> RemoteSource { owner, repo, git_ref: Option<String>, subpath: Option<String> }`
    accepts `github.com/owner/repo`, `https://github.com/owner/repo`, `owner/repo`, optional `@ref`,
    optional `#subpath` (install one skill from a monorepo).
  - `fetch_tarball(source, token: Option<&str>) -> Result<TempDir, RemoteFetchError>` — octocrab
    `download_tarball` for github.com (auth-capable), wrapped in `with_retry`; gzip-untar into a temp dir
    via `flate2`+`tar` with `sanitize_segment` on every entry (tar-slip defense); resolve the requested
    `subpath`; record the **resolved commit SHA**.
  - `RemoteFetchError: Retryable` — 429/5xx/network = `Transient`; 404 = `NotFound`; 403 = `Forbidden`;
    invalid archive / not-a-skill / 4xx = `Terminal`. `From<RemoteFetchError> for AppError`.
- **`installer.rs`** — orchestration + IPC.
  - command `install_skill_from_git(url, provider) -> Result<Skill, AppError>`: read GitHub token from
    keychain (if any) → `remote::fetch_tarball` → validate frontmatter (`SKILL.md`/`*.md` present) →
    hand temp dir to the **import pipeline** (copy into central, suppress discovered) → write provenance
    row → `audit(action="install", target_ref=central, source_ref=url, detail="files=N,commit=<sha>")`.
- **`backup.rs`** — `app_data_dir()/skills-backups/<utc-ts>/`.
  - `backup_skill_library() -> Result<BackupMeta, AppError>` — copy the whole `skills-library` tree into a
    new timestamped snapshot dir; audit(action="backup").
  - `list_skill_backups() -> Result<Vec<BackupMeta>, AppError>` — id (ts), created_at, skill count, bytes.
  - `restore_skill_library(id) -> Result<(), AppError>` — **take a pre-restore safety snapshot first**,
    then replace `skills-library` content from the chosen snapshot; reconcile `skill_source` rows
    (prune orphans, leave content-without-row as plain managed); audit(action="restore").
- **`updater.rs`** — staging at `app_data_dir()/skills-staging/<provider>/<name>/`.
  - `set_skill_auto_update(provider, name, enabled)` — toggles the per-skill opt-in (provenance row).
  - `check_skill_updates(scope) -> Result<Vec<UpdateStatus>, AppError>` — for the requested scope
    (one skill or all tracked), re-resolve upstream latest commit (bounded), and if newer than the
    recorded commit, fetch into staging and flag `update_available`; audit(action="update_check"/"update_stage").
  - `apply_skill_update(provider, name) -> Result<Skill, AppError>` — **back up the prior version first**,
    replace the central copy from staging, bump recorded commit; audit(action="update_apply"). Never runs anything.
  - on-launch hook: if the global setting is enabled, run **one bounded pass** of `check_skill_updates(all)`
    for opted-in skills at startup. Not a poll loop.

## 5. Data model — `migration 0040_skill_source.sql`

```sql
CREATE TABLE skill_source (
  id               INTEGER PRIMARY KEY AUTOINCREMENT, -- exposed to TS as i32 (specta: no i64/BigInt)
  provider         TEXT NOT NULL,
  name             TEXT NOT NULL,
  source_url       TEXT NOT NULL,        -- canonical repo ref the user installed
  source_ref       TEXT,                 -- requested ref/branch/tag (NULL = default branch)
  subpath          TEXT,                 -- monorepo subdir, if any
  installed_commit TEXT NOT NULL,        -- resolved SHA at install/apply time
  auto_update      INTEGER NOT NULL DEFAULT 0,  -- per-skill opt-in
  staged_commit    TEXT,                 -- SHA fetched into staging, awaiting apply (NULL = none)
  last_checked_at  TEXT,                 -- ISO8601 UTC of last upstream check
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(provider, name)
);
```

Global "check on launch" flag = an app **setting** (existing settings store), not this table.

## 6. IPC surface (tauri-specta → `src/bindings.ts`)

New commands (all `Result<_, AppError>`; ids surfaced as **i32**):
`install_skill_from_git`, `backup_skill_library`, `list_skill_backups`, `restore_skill_library`,
`set_skill_auto_update`, `check_skill_updates`, `apply_skill_update`.
New types: `BackupMeta`, `UpdateStatus`, `SkillSource` (or fields folded into the existing managed `Skill`
shape — decided in PR1). `bindings.ts` drift is an intentional, reviewed diff per PR.

## 7. Frontend (SkillsView)

- PR1: "Install from URL" action (input → `install_skill_from_git`), error surfaced via `AppError.action`.
- PR2: backup list + "Back up now" + "Restore…" (confirm dialog; restore is reversible but disruptive).
- PR3: per-skill "auto-update" toggle, library-wide "Check for updates", "update available" badge +
  "Apply" on managed cards, and the "check on launch" setting.

## 8. Error handling & bounded guarantees (ADR-0006 confirmation tests)

- **Bounded retry**: an always-`Transient` op stops after `max_attempts` and surfaces a terminal
  `AppError` — no infinite retry. (`with_retry` test.)
- **No poll loop**: on-launch check runs exactly one pass per opted-in skill. (updater test asserts call
  count, no loop.)
- **#1/#2 hard invariant**: install/update/restore touch only fs + DB + audit; **no codex job spawn**.
  Existing job-gating guard tests stay green; a new test asserts the install/apply path never reaches a
  spawn.
- **No token leakage**: tokens read from keychain inside Rust; IPC returns `Result<_, AppError>` only;
  reviewer grep confirms no token in command return types or logs.
- **Audit completeness**: every install / backup / restore / update_stage / update_apply writes an audit
  row. (per-action tests.)
- **Tar-slip defense**: extraction rejects entries that escape the temp root (`sanitize_segment`). (test
  with a crafted `../` entry.)

## 9. Reversibility (ADR-0006 reversibility rail)

- **Install** → reversible by the existing `remove_managed_skill` (deletes the central copy only; external
  files untouched) + provenance row cleanup.
- **Backup/restore** → restore writes a pre-restore safety snapshot, so any restore is itself undoable.
- **Update apply** → backs up the prior version before replacing, so an apply is undoable.

## 10. PR breakdown (one concern each)

Each PR: TDD (watch RED→GREEN) → full gates (`cargo test`/`clippy -D warnings`/`fmt --check`;
`pnpm typecheck`/`lint`/`vitest`; `bindings.ts` drift reviewed) → **independent opus critic ACCEPT**
(no self-approve) → `docs/decisions.md` breadcrumb → commit (cargo PATH for husky) → push `dev` →
verify `ls-remote(wire) == HEAD` + `HEAD~1 == known parent`.

- **G1.5-PR1 — network install (GitHub tarball).** `remote.rs` + `installer.rs`, `flate2`/`tar` deps,
  `0040_skill_source`, `install_skill_from_git`, FE "Install from URL". Reuses import pipeline + audit.
- **G1.5-PR2 — backup / restore.** `backup.rs`, `backup_skill_library`/`list_skill_backups`/
  `restore_skill_library`, pre-restore safety snapshot, FE backup/restore UI.
- **G1.5-PR3 — auto-updater.** `updater.rs`, `set_skill_auto_update`/`check_skill_updates`/
  `apply_skill_update`, staging area, opt-in toggle + on-launch setting + bounded launch check, FE
  badge/toggle/setting.

## 11. Out of scope (explicit deferrals)

- skills.sh marketplace API client; GitLab/Gitea/self-hosted hosts (next network round).
- External agent-dir apply / symlink (G2); presets (G2).
- Project workspaces, bidirectional sync, sync health badges (G3).
- Backup to a remote (local snapshots only this round).
