# Windows 11 Compatibility Design

**Date:** 2026-07-21
**Status:** Approved
**Scope:** Windows 11 core app, Codex, Git, and GitHub support; graceful disablement of macOS-only integrations

## Context

Work Radar is a Tauri 2 desktop app whose product code is mostly portable, but the current developer
entrypoint and several backend seams assume macOS or POSIX. `pnpm tauri` always invokes Bash, the
keyring crate enables only the Apple backend, the Echo diagnostic runner spawns `sh`, CLI discovery
assumes Unix paths and `HOME`, and the default navigation keymap treats `Cmd` as a physical key rather
than the semantic primary modifier. The repository also has no active Windows verification surface.

The requested outcome is not parity for every owner-specific automation. Windows 11 must support the
core local app plus Codex, Git, and GitHub. cmux, Hermes, and Boule may remain unavailable, but their
absence must be explicit and must never prevent startup or normal core use.

## Chosen Direction: Thin Platform Adapter

Keep domain modules platform-neutral and centralize unavoidable host differences in two small seams:

1. A Node-based Tauri launcher owns development-command portability while preserving the existing
   macOS signing runner behavior.
2. A Rust platform module owns home-directory lookup, executable discovery, primary optional
   integration support, and target-specific behavior used by backend callers.

The frontend continues to store `Cmd` as the semantic primary modifier in the default keymap. On
Windows and Linux, runtime matching treats Ctrl as the primary-key candidate after checking an exact
physical Ctrl binding first. This preserves explicit custom Ctrl bindings while making existing
default `Cmd+1`-style navigation work on Windows.

## Supported Surface

| Surface                                                   | Windows 11 contract                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| App startup, tray, notifications, dialog, global shortcut | Supported through Tauri plugins                                                   |
| SQLite and migrations                                     | Supported at the OS app-data path                                                 |
| Secrets                                                   | Stored only in Windows Credential Manager through keyring `windows-native`        |
| Git operations                                            | Supported through the `git` executable on `PATH`                                  |
| GitHub API and `gh` import                                | Supported through Rust/octocrab and Windows CLI discovery                         |
| Codex jobs                                                | Supported for native and npm-installed Codex executables on `PATH`/npm global bin |
| Navigation shortcuts                                      | Ctrl acts as the Windows primary modifier; exact custom bindings win              |
| cmux bridge/status                                        | Explicitly unavailable, returning stable empty/unavailable results                |
| Hermes panel/ACP                                          | Explicitly unavailable; no startup hotkey registration on Windows                 |
| Boule live runner/Control Room                            | Explicitly unavailable; default-disabled scheduler remains inert                  |
| macOS development signing                                 | Preserved unchanged on macOS and skipped elsewhere                                |

## Build and Credential Architecture

`package.json` invokes `node scripts/tauri-wrapper.mjs`. The wrapper launches the checked-in Tauri CLI
JavaScript entrypoint with the current Node executable, so it does not depend on Bash or Windows
`.cmd` shim semantics. On macOS `tauri dev` still receives the repository signing runner unless an
explicit runner or `WORK_RADAR_UNSIGNED_DEV=1` is present. Other commands and hosts pass through.

Keyring remains the only credential boundary. Cargo enables `apple-native` only on macOS and
`windows-native` only on Windows. No SQLite or renderer fallback is permitted. Other targets retain a
compile-only keyring dependency without claiming a supported secret backend in this slice.

## Rust Platform Boundary

`src-tauri/src/platform.rs` provides small, typed helpers:

- current host classification;
- `dirs::home_dir()` as the home-directory source instead of direct `HOME` reads;
- PATH/PATHEXT-aware executable candidates, including Windows npm global `.cmd` locations;
- support policy for cmux, Hermes, and Boule.

Codex, GitHub CLI import/audit, skill-root discovery, and cmux bridge home lookup consume these helpers.
The Echo runner stops spawning a shell and writes its bounded diagnostic ticks directly with Tokio.
This removes the only production `sh` dependency without introducing shell quoting rules.

## Optional Integration Degradation

Windows startup does not register the Hermes toggle hotkey. Hermes detection returns a stable
unsupported result without spawning `hermes` or `which`. cmux status returns `available: false`, and
the bridge returns an empty snapshot with a Windows-support warning. Boule runner resolution returns
unavailable before spawning Node. These paths remain read-only or default-disabled and do not change
the decision/proposal/execution rails.

## Keyboard Contract

Saved shortcut strings remain backward compatible. Matching order on Windows is:

1. exact event representation, such as `Ctrl+1`;
2. semantic primary-modifier alias, such as the default `Cmd+1`;
3. no match.

This prevents a default alias from stealing a user-authored Ctrl binding. Shortcut display renders the
semantic `Cmd` token as Ctrl on Windows, while macOS continues to show the command glyph. Hard-coded
shell shortcuts already accept `metaKey || ctrlKey` and remain unchanged.

## Verification Strategy

TDD locks pure platform candidate generation, Tauri wrapper argument forwarding, Windows primary-key
matching precedence, shell-free Echo behavior, and optional-integration support decisions.

Local macOS verification runs the full Rust and frontend gates, confirms the macOS signing arguments
are unchanged, runs a Windows target `cargo check` where the local toolchain allows it, and boots the
actual Tauri app for a core smoke test.

The existing GitHub Actions workflow is intentionally disabled because repository Actions usage and
Linux runner disk were exhausted. This change therefore adds a separate `workflow_dispatch` Windows
verification workflow rather than silently re-enabling automatic CI. It installs Windows Tauri
prerequisites and runs frontend typecheck/lint/test/build plus Rust fmt/clippy/test/build and bindings
drift. Automatic triggers remain deferred until the repository's CI budget decision changes.

## Risks and Rollback

- Windows Credential Manager behavior is security-sensitive. Rollback is the target-specific Cargo
  dependency change; no stored-secret migration is introduced.
- npm-installed CLI discovery can expose `.cmd` launch differences. Candidate ordering is tested and
  failed version probes degrade to unavailable without spawning jobs.
- Shortcut aliasing can create ambiguity. Exact physical bindings always win, and tests lock that
  precedence.
- Optional integration gating could hide a future Windows-capable release. Support policy is
  centralized so enabling a validated integration is one explicit change.

## Deliberate Deferrals

- No Hermes, cmux, or Boule Windows implementation.
- No Windows code-signing certificate, release publishing, updater, or automatic Actions trigger.
- No Linux support claim or Linux secret-store redesign.
- No localization or broad replacement of macOS-oriented prose outside touched shortcut/setup copy.
- No new IPC command or generated TypeScript binding unless implementation discovery proves one is
  required.

## Invariants Preserved

- Tokens remain OS-keychain-only and never enter SQLite or renderer storage.
- External network calls remain in Rust.
- Agent work remains bounded and gated exactly as before.
- Optional integration detection is display/availability state, not a decision input.
- No renderer-supplied executable or repository path is introduced.
- No retry loop or background autonomy is added.
