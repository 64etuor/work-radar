# Windows 11 Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Work Radar's core app, Codex, Git, and GitHub surfaces build and behave correctly on
Windows 11 while preserving macOS behavior and explicitly disabling unsupported owner-only integrations.

**Architecture:** Replace the Bash Tauri entrypoint with a Node launcher, add a small Rust platform
boundary for host/path/executable/support policy, and keep `Cmd` as a stored semantic primary modifier
that maps to Ctrl on Windows. Use target-specific keyring backends and a manually dispatched Windows
verification workflow because automatic Actions are intentionally disabled repository-wide.

**Tech Stack:** Tauri 2, Rust 2021, Tokio, keyring 3, dirs 6, React 19, TypeScript 5.8, Node 20 ESM,
Vitest, Node test runner, GitHub Actions Windows runners.

---

### Task 1: Replace the Bash-only Tauri entrypoint

**Files:**

- Create: `scripts/tauri-wrapper.mjs`
- Create: `scripts/tauri-wrapper.test.mjs`
- Modify: `package.json`
- Reference: `scripts/tauri-wrapper.sh`
- Reference: `scripts/dev-codesign-runner.sh`

1. Write Node tests for a pure `buildTauriArgs(args, env, platform)` helper. Assert macOS `dev`
   injects `--runner <repo>/scripts/dev-codesign-runner.sh`, explicit runner and unsigned mode pass
   through, Windows adds no runner, and arbitrary Tauri arguments retain order.
2. Run `node --test scripts/tauri-wrapper.test.mjs`; confirm RED because the module does not exist.
3. Implement the ESM wrapper using `process.execPath` plus
   `node_modules/@tauri-apps/cli/tauri.js`, `spawnSync(..., { stdio: "inherit" })`, and propagated exit
   status. Export only the pure argument helper and main runner seam needed by the test.
4. Change `package.json` `tauri` to `node scripts/tauri-wrapper.mjs`; keep macOS-only setup/signed
   aliases unchanged.
5. Run the Node test, `pnpm tauri -- --help`, and the existing `pnpm test:codesign`; expect PASS and
   unchanged macOS signing behavior.

### Task 2: Enable the Windows credential backend

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Reference: `src-tauri/src/keychain.rs`

1. Add target-specific Cargo metadata so macOS enables `keyring/apple-native`, Windows enables
   `keyring/windows-native`, and the shared dependency keeps the same keyring 3 API.
2. Run `cargo tree --manifest-path src-tauri/Cargo.toml -e features -i keyring`; confirm the current
   host selects Apple only.
3. Run `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc` after
   installing the Rust target if absent; confirm the Windows dependency graph reaches
   `windows-native` and no Apple framework.
4. Do not add a file/SQLite fallback. Credential errors continue through the existing `AppError`
   envelope.

### Task 3: Add the Rust platform boundary and portable CLI discovery

**Files:**

- Create: `src-tauri/src/platform.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/agent.rs`
- Modify: `src-tauri/src/commands/tokens.rs`
- Modify: `src-tauri/src/commands/audit.rs`
- Modify: `src-tauri/src/skills/scan.rs`

1. Write failing unit tests in `platform.rs` for Windows PATH candidate order (`tool.exe`,
   `tool.cmd`, `tool.bat`, `tool`), PATHEXT normalization, npm-global candidates below APPDATA, Unix
   bare/known candidates, and home expansion with an injected home path.
2. Run `cargo test --manifest-path src-tauri/Cargo.toml platform::tests`; confirm RED.
3. Implement a typed `HostOs`, pure candidate builders, `dirs::home_dir()` process adapter, and
   bounded executable probing helpers. Keep the module below the repository's 250-line preference.
4. Route Codex resolution through the shared candidates so `codex.cmd` in `%APPDATA%\\npm` can be
   found; keep `--version` and `login status` timeouts unchanged.
5. Route gh/ntn import and duplicate-install audit expansion through the same home/candidate rules.
6. Change skill root process capture from direct `HOME` to the platform home adapter while retaining
   injected `SkillRootEnv` tests.
7. Run targeted platform, agent availability, token, audit, and skill-root tests until green.

### Task 4: Remove the production POSIX shell dependency

**Files:**

- Modify: `src-tauri/src/agent.rs`
- Test: existing `agent::tests::echo_runner_captures_log_and_completes`
- Test: existing `jobs::tests::echo_job_timeout_kills_and_fails`

1. Strengthen the Echo tests to assert the log contains the supplied message and deterministic tick
   lines without requiring `sh` on PATH.
2. Run the two targeted tests with a PATH that excludes `sh`; confirm RED with the current runner.
3. Replace the constant shell script with Tokio file writes and bounded one-second sleeps. Preserve
   line count, timeout cancellation, `AgentOutcome`, and log format; do not add a new process.
4. Re-run the tests under the restricted PATH and normal environment; expect PASS.

### Task 5: Make unsupported optional integrations explicit on Windows

**Files:**

- Modify: `src-tauri/src/platform.rs`
- Modify: `src-tauri/src/hermes_agent/detect.rs`
- Modify: `src-tauri/src/commands/cmux.rs`
- Modify: `src-tauri/src/commands/cmux_bridge.rs`
- Modify: `src-tauri/src/governance/ticker.rs`
- Modify: `src-tauri/src/lib.rs`

1. Add failing table-driven tests for `HostOs::Windows` returning unsupported for Hermes, cmux, and
   Boule while macOS retains support.
2. Implement the support table in `platform.rs`.
3. On Windows, make Hermes detection return `installed=false` with a stable unsupported message and
   no `which` process; make cmux status/bridge return their existing graceful empty shapes; make
   Boule node resolution return unavailable.
4. Skip Hermes toggle-hotkey startup registration on Windows. Keep the core Ctrl+Space global
   shortcut and tray creation unchanged.
5. Run Hermes parse, cmux parse/status, governance resolver, and shortcut tests.

### Task 6: Map the semantic primary modifier to Windows Ctrl

**Files:**

- Modify: `src/lib/hotkey.ts`
- Modify: `src/lib/hotkey.test.ts`
- Modify: `src/lib/useViewShortcuts.ts`
- Create or modify: `src/lib/useViewShortcuts.test.ts`
- Modify: `src/components/settings/NavigationSettings.tsx`

1. Write failing tests for `eventHotkeyCandidates(event, platform)` proving exact `Ctrl+1` precedes
   the Windows primary alias `Cmd+1`, macOS emits only the physical Cmd candidate, and display maps
   semantic Cmd to `Ctrl` on Windows.
2. Run targeted Vitest; confirm RED.
3. Implement candidate generation and platform detection as pure functions with a thin browser
   adapter. Update `useViewShortcuts` to resolve candidates in order and stop at the first action.
4. Update touched settings copy to describe macOS Cmd / Windows Ctrl without changing stored keymap
   JSON or resetting user customizations.
5. Run hotkey, navigation, action, and shortcut hook tests; expect PASS.

### Task 7: Add a bounded Windows verification workflow and setup docs

**Files:**

- Create: `.github/workflows/windows-compat.yml`
- Modify: `docs/SETUP.md`
- Modify: `docs/reference/commands.md` only if the pre-existing user edit does not conflict
- Modify: `docs/decisions.md`

1. Add a `workflow_dispatch`-only `windows-latest` workflow. Install pnpm/Node/Rust, cache safely,
   then run frontend typecheck/lint/test/build and Rust fmt/clippy/test/build plus binding drift.
2. Do not add push, pull_request, schedule, or release triggers while `.github/workflows/ci.yml`
   remains intentionally disabled.
3. Document Windows 11 prerequisites (Rust MSVC toolchain, Node, pnpm, WebView2, Git, optional Codex
   and gh), `pnpm tauri dev/build`, Credential Manager storage, Ctrl shortcuts, and unsupported
   integrations.
4. Append one decision-log line recording the platform adapter and the deliberate manual CI trigger.
5. Validate workflow YAML structure with the available parser or actionlint if installed.

### Task 8: Verify compilation, behavior, and the actual app

**Files:**

- Modify only files already listed if failures are caused by this change.

1. Run targeted tests from Tasks 1-7.
2. Run `cargo fmt --check --manifest-path src-tauri/Cargo.toml`.
3. Run `cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings`.
4. Run `cargo test --manifest-path src-tauri/Cargo.toml` and verify generated bindings remain clean.
5. Run `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, `pnpm build`, and the repository frontend
   guards.
6. Run the Windows target check locally where possible and execute the manual Windows workflow if
   GitHub Actions quota permits. Report either result precisely; do not call an unrun Windows binary
   test passed.
7. Run `pnpm tauri dev` on macOS, verify startup, navigation, project/Git surface availability, and
   Codex availability detection, then stop the app cleanly. This is the available local manual QA;
   actual Windows UI QA remains required before claiming release readiness.
8. Run `git diff --check` and inspect the final scoped diff for token, network, rail, and unrelated
   change regressions.
