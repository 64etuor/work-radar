# Windows Residual Gaps Design

**Date:** 2026-07-24
**Status:** Approved
**Scope:** Close the remaining Windows 11 gaps on top of the landed 2026-07-21 Windows
compatibility slice: privilege-free skills apply, ntn token import path candidates, and
real-Windows verification. Boule, cmux, Hermes, and automatic CI triggers are explicitly out.

## Context

The 2026-07-21 slice (`2026-07-21-windows-compatibility-design.md`, Approved, implemented)
made the core app, Codex, Git, and GitHub surfaces portable: Node Tauri launcher,
`src-tauri/src/platform.rs` boundary (PATHEXT, `%APPDATA%\npm` discovery), target-specific
keyring backends, shell-free Echo runner, Ctrl-as-primary hotkey mapping, `.ico` bundle
assets, and a manually dispatched `windows-compat.yml` workflow.

A fresh audit found the residual Windows risks:

1. **Skills apply fails on stock Windows.** `skills/apply.rs` creates directory links with
   `std::os::windows::fs::symlink_dir`, which requires Developer Mode or
   `SeCreateSymbolicLinkPrivilege`. On a default Windows install, applying a skill fails
   with `ERROR_PRIVILEGE_NOT_HELD` (os error 1314). This is the only blocker-class gap.
2. **ntn Notion token import finds nothing on Windows.** `commands/tokens.rs` reads the
   XDG-style `~/.config/notion/api_key` only. Degraded (paste fallback exists).
3. **No real-Windows execution evidence for the above.** The manual workflow exists but has
   not been exercised against these paths.

Owner decisions taken for this slice: Boule will be removed from the system entirely later,
so it gets no Windows work; cmux and Hermes have no Windows host binaries and stay
explicitly unavailable (already gated); automatic CI triggers stay deferred (manual
dispatch only).

## Design

### 1. Skills apply: junction fallback

Keep `symlink_dir` as the first attempt. When creation fails with a privilege error
(os error 1314), fall back to creating an **NTFS junction** at the same path via the
`junction` crate. Junctions are directory reparse points creatable without any privilege.

Contract preservation (ADR-0006):

- **Recognition:** the "is this our link" logic (apply/scan/resolve/divergence/uninstall)
  must treat a junction whose resolved target is inside the central library exactly like a
  symlink with that target. `std::fs::read_link` and `symlink_metadata().file_type()
.is_symlink()` treat junctions as symlinks on Windows, so the existing checks are
  expected to hold; tests must prove it rather than assume it.
- **Reversibility:** uninstall removes the junction and restores prior state, user files
  untouched, same as symlinks.
- **No behavior change on macOS/Linux.** The fallback is `#[cfg(windows)]` only.

Testing: pure fallback-decision logic (error classification → retry-as-junction) is unit
tested on all hosts. Real junction create/read/remove tests are `#[cfg(windows)]` and run
on the `windows-latest` runner via the manual workflow's `cargo test`.

### 2. ntn token import path candidates

Replace the single hardcoded `~/.config/notion/api_key` read with an ordered candidate
probe built next to the existing platform helpers:

1. `~/.config/notion/api_key` (current behavior, all hosts);
2. on Windows additionally `%APPDATA%\notion\api_key` and
   `%USERPROFILE%\.config\notion\api_key` via the platform home adapter.

First readable candidate wins; none found keeps today's silent fallback to manual paste.
No new IPC surface.

### 3. Verification

- Full macOS gates: `cargo test`, `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`, `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`.
- Local cross-check: `cargo check --target x86_64-pc-windows-msvc`.
- Dispatch `.github/workflows/windows-compat.yml` (`gh workflow run`) and confirm green —
  this executes the junction tests on real Windows.
- Add a short Windows first-boot smoke checklist section to `docs/SETUP.md` for use when a
  physical Windows machine is available (startup, keychain roundtrip, skills apply without
  Developer Mode, Codex detection, mmbak import dialog).

## Out of Scope (explicit)

- **Boule:** owner will remove it from the system entirely; no Windows enablement. Removal
  itself is a separate future slice, not mixed into this PR.
- **cmux / Hermes:** no Windows host binaries exist; existing explicit-unavailable gating
  is the intended graceful degrade.
- **Automatic CI triggers:** deferred by owner decision; `workflow_dispatch` remains the
  only trigger.
- Windows code signing, release publishing, updater — unchanged deferrals from the
  2026-07-21 design.

## Risks and Rollback

- Junction semantics differ from symlinks at the filesystem-API margin (e.g. deletion via
  `remove_dir`, `\\?\`-prefixed `read_link` output). Tests normalize and lock the observed
  behavior on the Windows runner. Rollback: drop the fallback arm; symlink-only behavior
  returns.
- The `junction` crate is a new dependency; it is small, Windows-only in the dependency
  graph, and compiled out elsewhere.
- ntn candidate probing touches only a read-only convenience import with an existing
  manual fallback.

## Invariants Preserved

- Tokens remain OS-keychain-only; the ntn change reads a third-party CLI's own config file
  (existing behavior) and still routes storage through the keychain.
- Skills operations remain user-invoked, reversible, audit-logged (ADR-0006).
- No new network calls, no retry loops, no renderer-supplied paths, no rail changes.
