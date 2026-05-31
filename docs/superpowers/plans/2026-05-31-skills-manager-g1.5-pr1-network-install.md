# G1.5-PR1 — Network Install (GitHub tarball) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-initiated `install_skill_from_git` command that downloads a skill from a GitHub repo (as a tarball, no git binary), copies it into the central managed library, records provenance + an audit row, and never spawns a codex job.

**Architecture:** Reuse the G1 foundation. A new `remote.rs` parses a repo ref and fetches+extracts a `.tar.gz` (reqwest + flate2 + tar, tar-slip-safe via the existing `sanitize_segment`). A new `installer.rs` validates the extracted skill, reuses `central_repo::copy_skill_into_central` + `audit_log::audit`, and writes a provenance row via a new `source.rs`. Provenance lives in a new `skill_source` table (migration `0040`). The network call is bounded by the existing `retry::with_retry`. Tokens (for private repos) are read from the keychain inside Rust only.

**Tech Stack:** Rust, Tauri 2, tauri-specta, sqlx/SQLite, reqwest (rustls), flate2 + tar (new), tempfile; React/TypeScript frontend.

**Spec:** `docs/superpowers/specs/2026-05-31-skills-manager-g1.5-network-backup-update-design.md`

---

## File Structure

- Create `src-tauri/migrations/0040_skill_source.sql` — provenance table.
- Create `src-tauri/src/skills/remote.rs` — URL parsing, tarball fetch + safe extract, `RemoteFetchError`.
- Create `src-tauri/src/skills/source.rs` — provenance DB access (`SkillSource`, upsert, get).
- Create `src-tauri/src/skills/installer.rs` — `install_from_dir` core + `install_skill_from_git` command.
- Modify `src-tauri/Cargo.toml` — add `flate2`, `tar`.
- Modify `src-tauri/src/skills/mod.rs` — declare modules + re-export the new command/types.
- Modify `src-tauri/src/lib.rs:266-276` — register `skills::install_skill_from_git` in `collect_commands!`.
- Modify `src-tauri/src/skills/tests.rs` — add tests (append at end).
- Modify `src-tauri/src/error.rs` — add `From<RemoteFetchError>` (kept next to other `From` impls). _(Done inside Task 3 to keep the conversion with its type — declared in `remote.rs`, impl in `error.rs` per existing pattern.)_
- Modify `src/components/SkillsView.tsx` + `src/lib/query/skills.ts` — "Install from URL" action.

**Bounded/safety invariants this PR must preserve (ADR-0006):** bounded retry (no infinite loop), tokens never cross IPC, every install writes an audit row, tar-slip rejected, no codex-job spawn (#1/#2).

---

## Task 1: Provenance migration + table

**Files:**

- Create: `src-tauri/migrations/0040_skill_source.sql`

- [ ] **Step 1: Write the migration**

Create `src-tauri/migrations/0040_skill_source.sql`:

```sql
-- Provenance for network-installed managed skills.
-- One row per (provider, name) managed skill that came from a remote source.
CREATE TABLE IF NOT EXISTS skill_source (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    provider         TEXT NOT NULL,
    name             TEXT NOT NULL,
    source_url       TEXT NOT NULL,
    source_ref       TEXT,
    subpath          TEXT,
    installed_commit TEXT NOT NULL,
    auto_update      INTEGER NOT NULL DEFAULT 0,
    staged_commit    TEXT,
    last_checked_at  TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(provider, name)
);
```

- [ ] **Step 2: Verify the migration applies**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::sanitize_segment_rejects_traversal -- --nocapture`
Expected: PASS. (Any existing skills test forces `Db::connect_in_memory()` → `MIGRATOR.run`, which now applies `0040`. A migration syntax error would fail every db-using test.)

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/migrations/0040_skill_source.sql
git commit -m "feat(skills): skill_source provenance table (G1.5-PR1)"
```

---

## Task 2: Add archive dependencies

**Files:**

- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add flate2 + tar**

In `src-tauri/Cargo.toml`, in the `[dependencies]` section, add next to the existing `tempfile = "3"` line:

```toml
flate2 = "1"
tar = "0.4"
```

(`flate2` defaults to the pure-Rust `miniz_oxide` backend — no system zlib, no openssl. `tempfile` and `reqwest` are already present.)

- [ ] **Step 2: Verify it builds**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: compiles (downloads flate2/tar).

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build(skills): add flate2 + tar for tarball install (G1.5-PR1)"
```

---

## Task 3: `remote.rs` — URL parsing

**Files:**

- Create: `src-tauri/src/skills/remote.rs`
- Modify: `src-tauri/src/skills/mod.rs`
- Test: `src-tauri/src/skills/tests.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/skills/mod.rs`, add after `pub mod registry;`:

```rust
pub mod remote;
```

- [ ] **Step 2: Write the failing test**

Append to `src-tauri/src/skills/tests.rs`:

```rust
// ---- remote::parse_source ----------------------------------------------

#[test]
fn parse_source_accepts_common_forms() {
    use super::remote::parse_source;

    let s = parse_source("owner/repo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");
    assert_eq!(s.git_ref, None);
    assert_eq!(s.subpath, None);

    let s = parse_source("https://github.com/owner/repo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");

    let s = parse_source("github.com/owner/repo@main#skills/foo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");
    assert_eq!(s.git_ref.as_deref(), Some("main"));
    assert_eq!(s.subpath.as_deref(), Some("skills/foo"));

    // .git suffix is stripped.
    let s = parse_source("https://github.com/owner/repo.git").unwrap();
    assert_eq!(s.repo, "repo");
}

#[test]
fn parse_source_rejects_garbage() {
    use super::remote::parse_source;
    assert!(parse_source("").is_none());
    assert!(parse_source("not-a-repo").is_none());
    assert!(parse_source("https://gitlab.com/owner/repo").is_none()); // GitHub-only this PR
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::parse_source -- --nocapture`
Expected: FAIL — `remote` module / `parse_source` not found (compile error).

- [ ] **Step 4: Write the implementation**

Create `src-tauri/src/skills/remote.rs`:

```rust
//! Remote skill source: parse a GitHub repo ref and fetch+extract its tarball.
//!
//! GitHub-only this round. No git binary: we download `…/tarball/<ref>` via
//! reqwest and extract the gzip tarball with tar-slip defense. Tokens (for
//! private repos) are read from the keychain by the caller and never logged.

use std::io::Read;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::central_repo::sanitize_segment;
use crate::error::AppError;
use crate::retry::{with_retry, Retryable};

/// Bounded retry budget for tarball fetches.
const FETCH_MAX_ATTEMPTS: u32 = 3;
const FETCH_BASE_DELAY_MS: u64 = 200;

/// A parsed GitHub source reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSource {
    pub owner: String,
    pub repo: String,
    pub git_ref: Option<String>,
    pub subpath: Option<String>,
}

/// Parse `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo`,
/// with optional `@ref` and `#subpath`. Returns `None` for non-GitHub or malformed input.
pub fn parse_source(input: &str) -> Option<RemoteSource> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    // Split optional #subpath first.
    let (without_sub, subpath) = match raw.split_once('#') {
        Some((head, sub)) if !sub.is_empty() => (head, Some(sub.to_string())),
        _ => (raw, None),
    };

    // Split optional @ref.
    let (locator, git_ref) = match without_sub.split_once('@') {
        Some((head, r)) if !r.is_empty() => (head, Some(r.to_string())),
        _ => (without_sub, None),
    };

    // Strip scheme + host. Accept github.com only.
    let path = locator
        .strip_prefix("https://")
        .or_else(|| locator.strip_prefix("http://"))
        .unwrap_or(locator);
    let path = match path.strip_prefix("github.com/") {
        Some(rest) => rest,
        None => {
            if path.contains('.') {
                // Has a host that is not github.com.
                return None;
            }
            path // bare owner/repo
        }
    };

    let mut parts = path.split('/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches(".git").to_string();
    if parts.next().is_some() {
        return None; // too many path segments
    }
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(RemoteSource {
        owner,
        repo,
        git_ref,
        subpath,
    })
}

/// Error classifying remote fetch failures for bounded retry + AppError mapping.
#[derive(Debug)]
pub enum RemoteFetchError {
    /// Network/5xx/429 — safe to retry.
    Transient(String),
    /// 404 — repo or ref not found.
    NotFound(String),
    /// 401/403 — auth/permission.
    Forbidden(String),
    /// 4xx (other), invalid archive, or extracted dir is not a skill.
    Terminal(String),
}

impl Retryable for RemoteFetchError {
    fn is_retryable(&self) -> bool {
        matches!(self, RemoteFetchError::Transient(_))
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::parse_source -- --nocapture`
Expected: PASS (both `parse_source_*` tests).

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/remote.rs src-tauri/src/skills/mod.rs src-tauri/src/skills/tests.rs
git commit -m "feat(skills): remote::parse_source + RemoteFetchError (G1.5-PR1)"
```

---

## Task 4: `remote.rs` — tarball extraction (tar-slip safe)

**Files:**

- Modify: `src-tauri/src/skills/remote.rs`
- Test: `src-tauri/src/skills/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/skills/tests.rs`:

```rust
// ---- remote::extract_tarball -------------------------------------------

/// Build a gzip tarball in memory from (path, contents) entries.
fn make_targz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut tar_buf = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        for (path, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *contents).unwrap();
        }
        builder.finish().unwrap();
    }
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&tar_buf).unwrap();
    gz.finish().unwrap()
}

#[test]
fn extract_tarball_returns_top_level_dir() {
    use super::remote::extract_tarball;
    // GitHub tarballs wrap everything in a single `owner-repo-<sha>/` dir.
    let gz = make_targz(&[
        ("owner-repo-abc123/SKILL.md", b"---\nname: x\n---\nbody"),
        ("owner-repo-abc123/extra.txt", b"hi"),
    ]);
    let (tmp, top) = extract_tarball(&gz).unwrap();
    assert_eq!(top, "owner-repo-abc123");
    assert!(tmp.path().join("owner-repo-abc123/SKILL.md").is_file());
}

#[test]
fn extract_tarball_rejects_tar_slip() {
    use super::remote::extract_tarball;
    let gz = make_targz(&[("../escape.txt", b"evil")]);
    let res = extract_tarball(&gz);
    assert!(res.is_err(), "tar-slip entry must be rejected");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::extract_tarball -- --nocapture`
Expected: FAIL — `extract_tarball` not found.

- [ ] **Step 3: Write the implementation**

Append to `src-tauri/src/skills/remote.rs`:

```rust
/// Extract a gzip tarball into a fresh temp dir, rejecting any entry whose path
/// escapes the temp root (tar-slip). Returns `(TempDir, top_level_dir_name)`.
///
/// Every path component is checked with `sanitize_segment`, which rejects `..`,
/// separators inside a component, and absolute paths.
pub fn extract_tarball(gz_bytes: &[u8]) -> Result<(TempDir, String), RemoteFetchError> {
    use flate2::read::GzDecoder;

    let tmp = TempDir::new()
        .map_err(|e| RemoteFetchError::Terminal(format!("temp dir: {e}")))?;
    let root = tmp.path().to_path_buf();

    let mut archive = tar::Archive::new(GzDecoder::new(gz_bytes));
    let mut top_level: Option<String> = None;

    let entries = archive
        .entries()
        .map_err(|e| RemoteFetchError::Terminal(format!("read archive: {e}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| RemoteFetchError::Terminal(format!("archive entry: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| RemoteFetchError::Terminal(format!("entry path: {e}")))?
            .into_owned();

        // Validate every component; reject traversal/absolute/empty.
        let mut safe = PathBuf::new();
        let mut components = 0usize;
        for comp in path.components() {
            use std::path::Component;
            match comp {
                Component::Normal(os) => {
                    let seg = os
                        .to_str()
                        .ok_or_else(|| RemoteFetchError::Terminal("non-utf8 path".into()))?;
                    let clean = sanitize_segment(seg)
                        .ok_or_else(|| RemoteFetchError::Terminal(format!("unsafe path segment: {seg}")))?;
                    if components == 0 {
                        top_level.get_or_insert_with(|| clean.clone());
                    }
                    safe.push(clean);
                    components += 1;
                }
                _ => {
                    return Err(RemoteFetchError::Terminal(format!(
                        "unsafe archive path: {}",
                        path.display()
                    )));
                }
            }
        }
        if components == 0 {
            continue;
        }

        let dest = root.join(&safe);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|e| RemoteFetchError::Terminal(format!("mkdir: {e}")))?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| RemoteFetchError::Terminal(format!("mkdir: {e}")))?;
            }
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| RemoteFetchError::Terminal(format!("read entry: {e}")))?;
            std::fs::write(&dest, &buf)
                .map_err(|e| RemoteFetchError::Terminal(format!("write entry: {e}")))?;
        }
    }

    let top = top_level
        .ok_or_else(|| RemoteFetchError::Terminal("empty archive".into()))?;
    Ok((tmp, top))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::extract_tarball -- --nocapture`
Expected: PASS (both extract tests).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/remote.rs src-tauri/src/skills/tests.rs
git commit -m "feat(skills): tar-slip-safe tarball extraction (G1.5-PR1)"
```

---

## Task 5: `remote.rs` — bounded tarball fetch + AppError mapping

**Files:**

- Modify: `src-tauri/src/skills/remote.rs`
- Modify: `src-tauri/src/error.rs`
- Test: `src-tauri/src/skills/tests.rs`

- [ ] **Step 1: Write the failing test (error classification + mapping)**

Append to `src-tauri/src/skills/tests.rs`:

```rust
// ---- remote::RemoteFetchError ------------------------------------------

#[test]
fn remote_fetch_error_classification() {
    use super::remote::RemoteFetchError;
    use crate::error::{AppError, ErrorKind};
    use crate::retry::Retryable;

    assert!(RemoteFetchError::Transient("x".into()).is_retryable());
    assert!(!RemoteFetchError::Terminal("x".into()).is_retryable());
    assert!(!RemoteFetchError::NotFound("x".into()).is_retryable());
    assert!(!RemoteFetchError::Forbidden("x".into()).is_retryable());

    let ae: AppError = RemoteFetchError::NotFound("nope".into()).into();
    assert_eq!(ae.kind, ErrorKind::NotFound);
    let ae: AppError = RemoteFetchError::Transient("blip".into()).into();
    assert_eq!(ae.kind, ErrorKind::Transient);
    assert!(ae.retryable);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::remote_fetch_error_classification -- --nocapture`
Expected: FAIL — no `From<RemoteFetchError> for AppError`.

- [ ] **Step 3: Add the `From` impl + bounded fetch**

In `src-tauri/src/error.rs`, after the `impl From<crate::notion::NotionError> for AppError { … }` block, add:

```rust
impl From<crate::skills::remote::RemoteFetchError> for AppError {
    fn from(e: crate::skills::remote::RemoteFetchError) -> Self {
        use crate::skills::remote::RemoteFetchError as R;
        match e {
            R::Transient(m) => AppError::transient("skills.install.transient", m),
            R::NotFound(m) => AppError::not_found("skills.install.not_found", m),
            R::Forbidden(m) => AppError::forbidden("skills.install.forbidden", m),
            R::Terminal(m) => AppError::terminal("skills.install.terminal", m),
        }
    }
}
```

Append to `src-tauri/src/skills/remote.rs`:

```rust
/// Fetch the GitHub tarball bytes for `source`, bounded by retry.
///
/// `token` (if any) is sent as a Bearer credential and is never logged. Public
/// repos work with `token = None`. The ref defaults to the repo's default branch
/// when `source.git_ref` is `None` (GitHub's `/tarball` with no ref).
pub async fn fetch_tarball_bytes(
    source: &RemoteSource,
    token: Option<&str>,
) -> Result<Vec<u8>, RemoteFetchError> {
    let reference = source.git_ref.clone().unwrap_or_default();
    let url = format!(
        "https://api.github.com/repos/{}/{}/tarball/{}",
        source.owner, source.repo, reference
    );
    let base = std::time::Duration::from_millis(FETCH_BASE_DELAY_MS);

    with_retry(FETCH_MAX_ATTEMPTS, base, |_attempt| {
        let url = url.clone();
        let token = token.map(|t| t.to_string());
        async move {
            let client = reqwest::Client::builder()
                .user_agent("work-radar")
                .build()
                .map_err(|e| RemoteFetchError::Terminal(format!("http client: {e}")))?;
            let mut req = client
                .get(&url)
                .header("Accept", "application/vnd.github+json");
            if let Some(t) = token {
                req = req.bearer_auth(t);
            }
            let resp = req.send().await.map_err(|e| {
                // Connect/timeout/etc. — transient.
                RemoteFetchError::Transient(format!("request failed: {e}"))
            })?;
            let status = resp.status();
            if status.is_success() {
                let bytes = resp.bytes().await.map_err(|e| {
                    RemoteFetchError::Transient(format!("read body failed: {e}"))
                })?;
                return Ok(bytes.to_vec());
            }
            let code = status.as_u16();
            // Map status → classification. Body is NOT logged (may carry detail).
            Err(match code {
                404 => RemoteFetchError::NotFound(format!("repo or ref not found ({code})")),
                401 | 403 => RemoteFetchError::Forbidden(format!("forbidden ({code})")),
                429 | 500..=599 => RemoteFetchError::Transient(format!("server error ({code})")),
                _ => RemoteFetchError::Terminal(format!("request rejected ({code})")),
            })
        }
    })
    .await
}
```

> Note for the engineer: `error.rs` references `crate::skills::remote::RemoteFetchError`, so `remote` must be reachable from the crate root. It is, via `pub mod skills;` → `pub mod remote;` (Task 3 Step 1).

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::remote_fetch_error_classification -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Confirm the bounded budget is small**

Append to `src-tauri/src/skills/tests.rs`:

```rust
#[test]
fn fetch_budget_is_bounded() {
    // Guard against an accidental unbounded retry budget.
    assert!(super::remote::FETCH_MAX_ATTEMPTS <= 5);
}
```

Make the constant visible to the test: in `remote.rs` change `const FETCH_MAX_ATTEMPTS: u32 = 3;` to `pub(crate) const FETCH_MAX_ATTEMPTS: u32 = 3;`.

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::fetch_budget_is_bounded -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/remote.rs src-tauri/src/error.rs src-tauri/src/skills/tests.rs
git commit -m "feat(skills): bounded GitHub tarball fetch + AppError mapping (G1.5-PR1)"
```

---

## Task 6: `source.rs` — provenance DB access

**Files:**

- Create: `src-tauri/src/skills/source.rs`
- Modify: `src-tauri/src/skills/mod.rs`
- Test: `src-tauri/src/skills/tests.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/skills/mod.rs`, add after `pub mod remote;`:

```rust
pub mod source;
```

- [ ] **Step 2: Write the failing test**

Append to `src-tauri/src/skills/tests.rs`:

```rust
// ---- source: provenance row --------------------------------------------

#[tokio::test]
async fn upsert_and_get_skill_source() {
    use super::source::{get_skill_source, upsert_skill_source, NewSkillSource};

    let app = test_app();
    app.manage(test_db().await);

    upsert_skill_source(
        &app.handle(),
        NewSkillSource {
            provider: "claude",
            name: "demo",
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "abc123",
        },
    )
    .await
    .unwrap();

    let got = get_skill_source(&app.handle(), "claude", "demo")
        .await
        .unwrap()
        .expect("row present");
    assert_eq!(got.source_url, "github.com/owner/repo");
    assert_eq!(got.installed_commit, "abc123");
    assert!(!got.auto_update);

    // Upsert again with a new commit → same row updated, not duplicated.
    upsert_skill_source(
        &app.handle(),
        NewSkillSource {
            provider: "claude",
            name: "demo",
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "def456",
        },
    )
    .await
    .unwrap();
    let got = get_skill_source(&app.handle(), "claude", "demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.installed_commit, "def456");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::upsert_and_get_skill_source -- --nocapture`
Expected: FAIL — `source` module not found.

- [ ] **Step 4: Write the implementation**

Create `src-tauri/src/skills/source.rs`:

```rust
//! Provenance for network-installed managed skills (`skill_source` table).
//!
//! Records where a managed skill came from (URL/ref/commit) and the per-skill
//! auto-update opt-in. Pure DB access — no network, no secrets.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::db::Db;
use crate::error::AppError;

/// Read model for a provenance row (exposed to TS; `id` is i32 — specta has no i64).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SkillSource {
    pub id: i32,
    pub provider: String,
    pub name: String,
    pub source_url: String,
    pub source_ref: Option<String>,
    pub subpath: Option<String>,
    pub installed_commit: String,
    pub auto_update: bool,
    pub staged_commit: Option<String>,
    pub last_checked_at: Option<String>,
}

/// Insert/update parameters for a provenance row.
pub struct NewSkillSource<'a> {
    pub provider: &'a str,
    pub name: &'a str,
    pub source_url: &'a str,
    pub source_ref: Option<&'a str>,
    pub subpath: Option<&'a str>,
    pub installed_commit: &'a str,
}

/// Upsert a provenance row keyed by `(provider, name)`. Preserves `auto_update`.
pub async fn upsert_skill_source<R: Runtime>(
    app: &AppHandle<R>,
    s: NewSkillSource<'_>,
) -> Result<(), AppError> {
    let pool = app.state::<Db>().pool().clone();
    sqlx::query(
        "INSERT INTO skill_source \
            (provider, name, source_url, source_ref, subpath, installed_commit, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
         ON CONFLICT(provider, name) DO UPDATE SET \
            source_url = excluded.source_url, \
            source_ref = excluded.source_ref, \
            subpath = excluded.subpath, \
            installed_commit = excluded.installed_commit, \
            staged_commit = NULL, \
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(s.provider)
    .bind(s.name)
    .bind(s.source_url)
    .bind(s.source_ref)
    .bind(s.subpath)
    .bind(s.installed_commit)
    .execute(&pool)
    .await?;
    Ok(())
}

/// Fetch the provenance row for `(provider, name)`, if any.
pub async fn get_skill_source<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    name: &str,
) -> Result<Option<SkillSource>, AppError> {
    let pool = app.state::<Db>().pool().clone();
    let row = sqlx::query_as::<_, (
        i32,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        i64,
        Option<String>,
        Option<String>,
    )>(
        "SELECT id, provider, name, source_url, source_ref, subpath, installed_commit, \
                auto_update, staged_commit, last_checked_at \
         FROM skill_source WHERE provider = ?1 AND name = ?2",
    )
    .bind(provider)
    .bind(name)
    .fetch_optional(&pool)
    .await?;

    Ok(row.map(|r| SkillSource {
        id: r.0,
        provider: r.1,
        name: r.2,
        source_url: r.3,
        source_ref: r.4,
        subpath: r.5,
        installed_commit: r.6,
        auto_update: r.7 != 0,
        staged_commit: r.8,
        last_checked_at: r.9,
    }))
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::upsert_and_get_skill_source -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/source.rs src-tauri/src/skills/mod.rs src-tauri/src/skills/tests.rs
git commit -m "feat(skills): skill_source provenance DB access (G1.5-PR1)"
```

---

## Task 7: `installer.rs` — core install-from-dir (testable, no network)

**Files:**

- Create: `src-tauri/src/skills/installer.rs`
- Modify: `src-tauri/src/skills/mod.rs`
- Test: `src-tauri/src/skills/tests.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/skills/mod.rs`, add after `pub mod source;`:

```rust
pub mod installer;
```

- [ ] **Step 2: Write the failing test**

Append to `src-tauri/src/skills/tests.rs`:

```rust
// ---- installer::install_from_dir ---------------------------------------

#[tokio::test]
async fn install_from_dir_copies_records_and_audits() {
    use super::installer::{install_from_dir, InstallMeta};

    let tmp = TempDir::new().unwrap();
    // Simulate an extracted skill dir.
    let src = make_skill_dir(tmp.path(), "demo", "hello");
    let central_root = tmp.path().join("lib");

    let app = test_app();
    app.manage(test_db().await);

    let skill = install_from_dir(
        &app.handle(),
        &central_root,
        &src,
        "claude",
        InstallMeta {
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "abc123",
        },
    )
    .await
    .unwrap();

    assert_eq!(skill.kind, "managed");
    assert!(central_root.join("claude/demo/SKILL.md").is_file());

    // Provenance recorded.
    let prov = super::source::get_skill_source(&app.handle(), "claude", "demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prov.installed_commit, "abc123");

    // Audit row recorded with action "install".
    let entries = list_skill_audit_core(&app.handle(), 10).await.unwrap();
    assert!(entries.iter().any(|e| e.action == "install"));
}

#[tokio::test]
async fn install_from_dir_rejects_non_skill() {
    use super::installer::{install_from_dir, InstallMeta};
    let tmp = TempDir::new().unwrap();
    // A dir WITHOUT SKILL.md / frontmatter is not a skill.
    let not_skill = tmp.path().join("blob");
    fs::create_dir_all(&not_skill).unwrap();
    fs::write(not_skill.join("random.txt"), b"nope").unwrap();
    let central_root = tmp.path().join("lib");

    let app = test_app();
    app.manage(test_db().await);

    let res = install_from_dir(
        &app.handle(),
        &central_root,
        &not_skill,
        "claude",
        InstallMeta {
            source_url: "github.com/owner/repo",
            source_ref: None,
            subpath: None,
            installed_commit: "x",
        },
    )
    .await;
    assert!(res.is_err(), "non-skill dir must be rejected before copy");
    assert!(!central_root.exists(), "central must not be polluted on rejection");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::install_from_dir -- --nocapture`
Expected: FAIL — `installer` module not found.

- [ ] **Step 4: Write the implementation**

Create `src-tauri/src/skills/installer.rs`:

```rust
//! Network install of a skill into the central managed library.
//!
//! `install_skill_from_git` (command) fetches a GitHub tarball, extracts it,
//! resolves the optional subpath, then `install_from_dir` validates + copies it
//! into the central repo, records provenance, and audits. Never spawns a job
//! (INVARIANT #1/#2): this is file I/O + DB writes only.

use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};

use super::audit_log::audit;
use super::central_repo::{
    central_library_root, copy_skill_into_central, managed_skill_path, sanitize_segment,
};
use super::model::Skill;
use super::remote::{extract_tarball, fetch_tarball_bytes, parse_source};
use super::scan::scan_skill_dir;
use super::source::{upsert_skill_source, NewSkillSource};
use crate::error::AppError;
use crate::keychain::{get_token, TokenKind};

/// Provenance to record for an install.
pub struct InstallMeta<'a> {
    pub source_url: &'a str,
    pub source_ref: Option<&'a str>,
    pub subpath: Option<&'a str>,
    pub installed_commit: &'a str,
}

/// Validate `source_dir` is a real skill, copy it into the central library under
/// `<provider>/<name>`, record provenance, and audit. `name` is derived from the
/// source dir name. Returns the now-managed [`Skill`].
pub async fn install_from_dir<R: Runtime>(
    app: &AppHandle<R>,
    central_root: &Path,
    source_dir: &Path,
    provider: &str,
    meta: InstallMeta<'_>,
) -> Result<Skill, AppError> {
    // Reject anything that does not scan as a skill BEFORE writing to central.
    let scanned = scan_skill_dir(source_dir).ok_or_else(|| {
        AppError::terminal(
            "skills.install.not_a_skill",
            "fetched directory is not a valid skill (no SKILL.md/frontmatter)".to_string(),
        )
    })?;

    let provider_seg = sanitize_segment(provider).ok_or_else(|| {
        AppError::terminal(
            "skills.install.invalid_provider",
            format!("invalid provider segment: {provider}"),
        )
    })?;
    let name = source_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| {
            AppError::terminal(
                "skills.install.invalid_name",
                "source path has no directory name".to_string(),
            )
        })?
        .to_string();
    let name_seg = sanitize_segment(&name).ok_or_else(|| {
        AppError::terminal(
            "skills.install.invalid_name",
            format!("invalid skill name segment: {name}"),
        )
    })?;

    let dest = managed_skill_path(central_root, &provider_seg, &name_seg);
    let file_count = copy_skill_into_central(source_dir, &dest)?;

    upsert_skill_source(
        app,
        NewSkillSource {
            provider: &provider_seg,
            name: &name_seg,
            source_url: meta.source_url,
            source_ref: meta.source_ref,
            subpath: meta.subpath,
            installed_commit: meta.installed_commit,
        },
    )
    .await?;

    audit(
        app,
        "install",
        "managed_skill",
        &format!("{provider_seg}/{name_seg}"),
        Some(meta.source_url),
        Some(&format!("files={file_count},commit={}", meta.installed_commit)),
    )
    .await?;

    let mut skill = scanned;
    skill.kind = "managed".to_string();
    skill.provider = provider.to_string();
    Ok(skill)
}

/// Extract the resolved commit SHA from a GitHub tarball top-level dir name
/// (`owner-repo-<sha>`). Falls back to the whole name if no trailing SHA.
fn commit_from_top_level(top: &str) -> String {
    top.rsplit('-').next().unwrap_or(top).to_string()
}

/// IPC command: install a skill from a GitHub repo URL into the central library.
#[tauri::command]
#[specta::specta]
pub async fn install_skill_from_git<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    provider: String,
) -> Result<Skill, AppError> {
    let source = parse_source(&url).ok_or_else(|| {
        AppError::terminal(
            "skills.install.invalid_url",
            format!("not a supported GitHub repo URL: {url}"),
        )
    })?;

    // Private repos use the keychain GitHub token; public repos need none.
    let token = get_token("github", TokenKind::GitHub).ok().flatten();

    let gz = fetch_tarball_bytes(&source, token.as_deref()).await?;
    let (tmp, top) = extract_tarball(&gz)?;
    let installed_commit = commit_from_top_level(&top);

    // The skill content lives under `<top>/<subpath?>`.
    let mut content_dir = tmp.path().join(&top);
    if let Some(sub) = &source.subpath {
        for seg in sub.split('/').filter(|s| !s.is_empty()) {
            let clean = sanitize_segment(seg).ok_or_else(|| {
                AppError::terminal(
                    "skills.install.invalid_subpath",
                    format!("invalid subpath segment: {seg}"),
                )
            })?;
            content_dir = content_dir.join(clean);
        }
    }
    if !content_dir.is_dir() {
        return Err(AppError::not_found(
            "skills.install.subpath_missing",
            "the requested path was not found in the repository".to_string(),
        ));
    }

    let central_root = central_library_root(&app)?;
    install_from_dir(
        &app,
        &central_root,
        &content_dir,
        &provider,
        InstallMeta {
            source_url: &url,
            source_ref: source.git_ref.as_deref(),
            subpath: source.subpath.as_deref(),
            installed_commit: &installed_commit,
        },
    )
    .await
}
```

> Engineer note: confirm the keychain call signature. This plan assumes `keychain::get_token(credential_ref: &str, kind: TokenKind) -> Result<Option<String>, _>` and a `TokenKind::GitHub` variant (mirroring pr_radar's GitHub token read). If the real `credential_ref` for GitHub differs, match what `commands/pr_radar.rs` uses. This is the ONLY uncertain external API in the PR — verify before Step 5.

- [ ] **Step 5: Run test to verify it passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills::tests::install_from_dir -- --nocapture`
Expected: PASS (both install_from_dir tests).

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/installer.rs src-tauri/src/skills/mod.rs src-tauri/src/skills/tests.rs
git commit -m "feat(skills): install_from_dir core + install_skill_from_git command (G1.5-PR1)"
```

---

## Task 8: Wire the command + re-exports

**Files:**

- Modify: `src-tauri/src/skills/mod.rs`
- Modify: `src-tauri/src/lib.rs:266-276`

- [ ] **Step 1: Re-export the command + provenance type**

In `src-tauri/src/skills/mod.rs`, add to the re-export block (after the `import::{…}` line):

```rust
pub use installer::install_skill_from_git;
pub use source::{SkillSource, NewSkillSource};
```

- [ ] **Step 2: Register the command in the specta builder**

In `src-tauri/src/lib.rs`, inside `collect_commands![ … ]`, add after `skills::list_skill_audit,`:

```rust
            skills::install_skill_from_git,
```

- [ ] **Step 3: Verify it compiles + full skills test suite passes**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test skills:: -- --nocapture`
Expected: PASS (all skills tests, including the new ones).

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/skills/mod.rs src-tauri/src/lib.rs
git commit -m "feat(skills): register install_skill_from_git command (G1.5-PR1)"
```

---

## Task 9: Regenerate bindings + verify drift is intentional

**Files:**

- Modify: `src/bindings.ts` (generated)

- [ ] **Step 1: Record the pre-change bindings hash**

Run: `git hash-object src/bindings.ts`
Note the hash.

- [ ] **Step 2: Regenerate bindings by booting the app in debug**

Run (let it boot ~15s, then Ctrl-C / kill): `export PATH="$HOME/.cargo/bin:$PATH" && pnpm tauri dev`
The `#[cfg(debug_assertions)]` `builder.export(..., "../src/bindings.ts")` at `lib.rs:292` rewrites `src/bindings.ts` on boot.

> If a headless/no-GUI environment can't run `tauri dev`, say so explicitly (do not fake the regeneration) and hand this step to a session that can boot the app — this is a real gate, not optional.

- [ ] **Step 3: Inspect the drift — must be ONLY the new command**

Run: `git diff src/bindings.ts`
Expected: a new `installSkillFromGit` command binding (+ the `SkillSource` type only if referenced by an exported command/return — it is NOT in PR1, so likely just the command). No unrelated commands removed/changed. If anything else changed, investigate before committing.

- [ ] **Step 4: Frontend gates green**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: typecheck 0 errors; lint 0 errors (pre-existing 2 react-hooks warnings OK); vitest all pass.

- [ ] **Step 5: Commit**

```bash
git add src/bindings.ts
git commit -m "chore(skills): regenerate bindings for install_skill_from_git (G1.5-PR1)"
```

---

## Task 10: Frontend — "Install from URL" action

**Files:**

- Modify: `src/lib/query/skills.ts`
- Modify: `src/components/SkillsView.tsx`
- Test: `src/components/SkillsView.test.tsx` (or the existing skills test file — match what's there)

- [ ] **Step 1: Read the existing import action to mirror it**

Read `src/lib/query/skills.ts` (find the `importExternalSkill`/`removeManagedSkill` mutations added in G1-PR3) and `src/components/SkillsView.tsx` (find the Import action UI). Mirror that exact mutation + UI pattern — do not invent a new pattern.

- [ ] **Step 2: Add the install mutation**

In `src/lib/query/skills.ts`, next to the existing `importExternalSkill` mutation, add (matching the file's existing style and the generated `commands.installSkillFromGit` binding):

```ts
export function useInstallSkillFromGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ url, provider }: { url: string; provider: string }) =>
      unwrap(commands.installSkillFromGit(url, provider)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
```

> Match the real helpers: if the file uses a different unwrap/`commands` import or query-key, follow that. `commands.installSkillFromGit` is generated in `src/bindings.ts` from Task 9.

- [ ] **Step 3: Add the UI action**

In `src/components/SkillsView.tsx`, add an "Install from URL" control near the existing Import action: an input for the repo URL (+ the provider already in context for that section) that calls `useInstallSkillFromGit().mutate({ url, provider })`. Surface errors via the existing `AppError` toast/inline pattern used by import. Reuse existing shadcn components (Input, Button, Sheet/Dialog) already imported in the file — do not add new UI primitives.

- [ ] **Step 4: Add/extend a frontend test**

Mirror the existing SkillsView import test: render, type a URL, submit, assert the mutation/command is called with `{ url, provider }`. (Use the existing mocking pattern for `commands` in the test file.)

- [ ] **Step 5: Frontend gates green**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: all green (pre-existing 2 warnings OK).

- [ ] **Step 6: Commit**

```bash
git add src/lib/query/skills.ts src/components/SkillsView.tsx src/components/SkillsView.test.tsx
git commit -m "feat(skills): SkillsView install-from-URL action (G1.5-PR1)"
```

---

## Task 11: Full gates + reviewer pass + push

- [ ] **Step 1: Rust gates**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
Expected: all tests pass (note the new count = prior 440 + new tests); clippy 0 warnings; fmt clean.

- [ ] **Step 2: Frontend gates**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd .. && pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: typecheck 0, lint 0 errors, vitest pass.

- [ ] **Step 3: bindings drift gate**

Run: `git diff --exit-code src/bindings.ts`
Expected: clean (exit 0) — already committed in Task 9; no uncommitted drift.

- [ ] **Step 4: #1/#2 guard — confirm no job-spawn on the install path**

Run: `/usr/bin/grep -rn "spawn\|gated\|codex" src-tauri/src/skills/installer.rs src-tauri/src/skills/remote.rs src-tauri/src/skills/source.rs`
Expected: NO matches (install is pure file I/O + DB + audit). Confirm existing job-gating guard tests still pass (covered by `cargo test`).

- [ ] **Step 5: Independent critic pass (no self-approve)**

Dispatch the `oh-my-claudecode:critic` agent (opus) to review the full PR diff against ADR-0006 rails (bounded retry, tokens-in-Rust, audit completeness, tar-slip, reversibility via existing `remove_managed_skill`, #1/#2). Address blockers; record `Nit:` items as backlog. Do NOT proceed to push until the critic ACCEPTs.

- [ ] **Step 6: decisions.md breadcrumb**

Append one line to `docs/decisions.md` (bottom): the G1.5-PR1 entry — what shipped (network install via GitHub tarball, `skill_source` table, reqwest-not-octocrab tarball, reuse import pipeline), the resolved-commit-from-top-level-dir choice, and the bindings drift (`installSkillFromGit` only). Commit:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add docs/decisions.md
git commit -m "docs(decisions): G1.5-PR1 breadcrumb (network install)"
```

- [ ] **Step 7: Push dev + verify the wire**

Run:

```bash
git push origin HEAD:dev
L=$(/usr/bin/git rev-parse HEAD); R=$(/usr/bin/git ls-remote origin refs/heads/dev | cut -f1)
[ "$L" = "$R" ] && echo "PUSH MATCH" || echo "PUSH MISMATCH"
/usr/bin/git log --oneline -1 HEAD~1   # parent must be the prior known dev head (af40077 chain)
```

Expected: `PUSH MATCH`; `HEAD~1` is the previous dev commit. (Push policy: dev only — husky pre-push blocks main.)

---

## Self-Review (completed during planning)

- **Spec coverage:** network install from GitHub (§4 remote/installer) ✓; provenance DB table (§5) ✓ Task 1/6; reuse import pipeline + audit (§3) ✓ Task 7; bounded retry test (§8) ✓ Task 5; tar-slip test (§8) ✓ Task 4; #1/#2 guard (§8) ✓ Task 11 Step 4; tokens-in-Rust (§8) ✓ Task 7 (keychain read inside command); audit completeness (§8) ✓ Task 7 test; FE install action (§7) ✓ Task 10; bindings drift reviewed (§6) ✓ Task 9. Deferred per spec §11: GitLab/Gitea, skills.sh, backup, updater — not in this PR. ✓
- **Placeholder scan:** no TBD/TODO; all code blocks complete. The two "engineer note" callouts (keychain signature in Task 7; bindings regen requires GUI in Task 9) are explicit verification instructions, not placeholders. The FE tasks (10) intentionally say "mirror the existing import action" with the exact mutation code given, because the surrounding file style must be matched — the new code is fully specified.
- **Type consistency:** `RemoteSource{owner,repo,git_ref,subpath}`, `RemoteFetchError{Transient,NotFound,Forbidden,Terminal}`, `NewSkillSource{provider,name,source_url,source_ref,subpath,installed_commit}`, `SkillSource` (adds id/auto_update/staged_commit/last_checked_at), `InstallMeta{source_url,source_ref,subpath,installed_commit}`, `install_from_dir(app, central_root, source_dir, provider, meta)`, `install_skill_from_git(app, url, provider)` — names consistent across tasks. `audit(&app, action, kind, target_ref, source_ref, detail)` and `central_library_root/managed_skill_path/copy_skill_into_central/sanitize_segment/scan_skill_dir` match the real G1 code read during planning.

---

## Notes / risks

- **Only uncertain external API:** the exact `keychain::get_token` signature + GitHub `credential_ref` (Task 7 note). Verify against `commands/pr_radar.rs` before implementing Task 7 Step 4. Everything else uses code quoted from the current tree.
- **`scan_skill_dir` contract:** assumed `Option<Skill>` returning `None` for non-skill dirs (matches `import.rs` usage). If it returns `Ok/Err`, adjust the validation in `install_from_dir` accordingly.
- **resolved commit:** taken from the tarball top-level dir `owner-repo-<sha>` (GitHub guarantees this). If GitHub ever changes the naming, the recorded `installed_commit` degrades to the full dir name — provenance still works, only the SHA precision is lost.
- **Bindings regen needs a GUI boot** (`pnpm tauri dev`) — Task 9. If the executing session is headless, hand that one step off; do not fake it.
