# Open Distribution Readiness With Private Git Implementation Plan

> **For Claude/Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare Work Radar so other people can install and use it while keeping the current GitHub repository private until a separate release-source decision is made.

**Architecture:** Treat this as a release-readiness program, not a feature sprint. First remove public-release blockers from the private repo, then add repeatable packaging/security gates, then decide whether to ship binaries only, a curated source archive, or a public mirror. The app's existing invariant remains: secrets stay in OS keychain and external network calls stay in Rust.

**Tech Stack:** Tauri 2, Rust/sqlx/keyring, Vite/React/TanStack Query, GitHub Actions, pnpm, cargo, OS signing/notarization tooling.

---

## Operating Constraints

- Keep the current GitHub repository private during this goal.
- Do not flip repo visibility as part of this plan.
- Public distribution can start as GitHub Release artifacts from a private repo, a manually hosted download, or TestFlight-like closed distribution. Calling it "open source" remains blocked until a public source/mirror/source archive path is chosen.
- Work in small PR-sized commits on `dev`; `main` remains PR-only per `docs/areas/git-conventions.md`.
- Every source-affecting change must keep `docs/areas/area-map.md` routing discipline.
- No unrelated cleanup. Only touch files in the task's stated scope.

## Success Criteria

- A non-maintainer can install or build Work Radar from documented instructions without knowing private repo workflow.
- No tracked file exposes maintainer-only session artifacts, private-account workflow, bad font downloads, or avoidable personal identifiers.
- Public-facing privacy behavior is explicit: what is local-only, what touches external APIs, what is persisted, and where secrets live.
- Release artifacts are built by a reproducible process with signing/notarization policy documented.
- CI is green, including format, audit decisions, frontend/Rust tests, and a Tauri packaging smoke path.

## Phase 0: Product/Release Decision Record

**Files:**

- Create: `docs/adr/00XX-private-repo-public-distribution.md`
- Modify: `docs/decisions.md`

**Steps:**

1. Determine next ADR id with:
   `ls docs/adr/[0-9]*.md governance/docs/adr/[0-9]*.md 2>/dev/null | sort | tail`.
2. Write an ADR with this decision:
   - Current Git repo remains private during release-readiness.
   - Public distribution channel is initially binary/manual-download unless later superseded.
   - Source-opening path is a separate decision: public mirror, source archive, or full repo visibility.
   - Privacy/security gates must pass before any public artifact is advertised.
3. Add one `docs/decisions.md` line linking the ADR.

**Acceptance:**

- ADR has drivers, rejected alternatives, consequences, and explicit follow-ups.
- It states clearly that "usable by others" and "open source" are separate until source publication is decided.

## Phase 1: Repository Surface Hygiene

**Files:**

- Modify: `.gitignore`
- Remove or move: `.claude/skills/**`, `.codex/skills/**`, `.agents/skills/**`, `.react-doctor/**`, `progress.txt`, `poc.html`, `mockups/**` if not product docs
- Modify: `docs/reference/skills.md`

**Steps:**

1. Decide whether agent skills are product assets or maintainer tooling.
2. If maintainer tooling, untrack `.claude/skills/**`, `.codex/skills/**`, `.agents/skills/**`, `.react-doctor/**` and add ignore rules.
3. If product assets, move them under a reviewed, licensed `tools/` or `skills/` tree and add provenance to `NOTICE`.
4. Remove tracked session/progress artifacts such as `progress.txt`.
5. Replace private account/test identifiers with neutral examples, e.g. `user@example.test`.

**Acceptance:**

- `git ls-files | rg '^(\.claude/skills|\.codex/skills|\.agents/skills|\.react-doctor|progress\.txt|poc\.html|mockups/)'` returns nothing unless intentionally documented as product assets.
- No public docs mention `64etuor/work-radar` as the user-facing repo.

## Phase 2: License, NOTICE, and Public Metadata

**Files:**

- Create: `LICENSE`
- Create: `NOTICE`
- Create: `SECURITY.md`
- Create: `CONTRIBUTING.md`
- Optional create: `CODE_OF_CONDUCT.md`, `SUPPORT.md`
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`

**Steps:**

1. Choose license. Recommended default for broad adoption: MIT or Apache-2.0; choose intentionally.
2. Add root `LICENSE`.
3. Add `license`, `repository`, `homepage`, `bugs`, and author/maintainer metadata to `package.json`.
4. Add matching `license`, `repository`, `homepage`, and metadata to `src-tauri/Cargo.toml`.
5. Create `NOTICE` covering bundled fonts, icons, and any kept vendored tooling.
6. Add `SECURITY.md` with private-report instructions that do not require public issue disclosure.
7. Add `CONTRIBUTING.md` for private-repo development access and public bug/report workflow.

**Acceptance:**

- `rg -n '"private": true|license|repository|homepage|bugs' package.json src-tauri/Cargo.toml` shows intentional metadata.
- Root license and security disclosure exist.

## Phase 3: Public README and Onboarding

**Files:**

- Modify: `README.md`
- Modify: `docs/reference/commands.md`
- Move or rewrite: `docs/HANDOFF.md` references from public docs
- Modify: `docs/areas/git-conventions.md` to remove public-facing private account assumptions or move them to maintainer docs

**Steps:**

1. Rewrite README for users first:
   - What Work Radar does.
   - Current distribution status.
   - Install/build options.
   - Required external accounts: optional GitHub, Notion, Google, Codex/Hermes.
   - Privacy summary.
2. Add developer setup:
   - Node/pnpm version.
   - Rust toolchain.
   - Tauri platform dependencies.
   - macOS `pnpm tauri:dev:setup` before `pnpm tauri dev`.
3. Remove `docs/HANDOFF.md` as "start here" for public readers.
4. Update `docs/reference/commands.md` so it matches `package.json` and CI exactly.
5. Add a "before PR" command bundle.

**Acceptance:**

- A fresh contributor can follow README without knowing maintainer-only workflow.
- `docs/reference/commands.md` includes `pnpm format:check`, `pnpm lint`, `pnpm test`, frontend guard scripts, Rust fmt/clippy/test, and packaging smoke expectations.

## Phase 4: Privacy and Local Persistence Hardening

**Files:**

- Modify: `src/lib/query/persist.ts`
- Inspect/modify: `src/main.tsx`
- Inspect/modify query keys under `src/lib/query/**`
- Modify: `src/components/ErrorBoundary.tsx`
- Modify: `src/lib/toast.ts`
- Modify: `src-tauri/src/logging.rs`
- Add tests under `src/lib/**.test.ts` as needed

**Steps:**

1. Make renderer query persistence deny-by-default.
2. Allowlist only non-sensitive UI preferences/status booleans.
3. Exclude calendar event titles, locations, URLs, PR titles/authors, local repo paths, agent logs, and project metadata from `localStorage`.
4. Add a redaction helper for frontend-to-backend error logging.
5. Redact home paths, query params, bearer/auth/token-like substrings, email addresses where not required, and long opaque tokens.
6. Add tests proving sensitive keys are not persisted and logs are redacted.

**Acceptance:**

- Tests fail before the allowlist/redaction changes and pass after.
- Manual inspection of `localStorage` after common flows shows no private calendar/PR/repo data.
- Token flow remains keychain-only.

## Phase 5: Asset and Dependency Hygiene

**Files:**

- Replace: `src/assets/fonts/SUIT-Variable.woff2`
- Modify: `src/styles/fonts.css` if font names/paths change
- Modify: `package.json`, `pnpm-lock.yaml`
- Optional add: `scripts/check-assets.mjs`

**Steps:**

1. Replace `SUIT-Variable.woff2` with the real WOFF2 from upstream.
2. Verify with `file src/assets/fonts/SUIT-Variable.woff2`.
3. Add checksum/provenance notes to `NOTICE`.
4. Run `pnpm audit --audit-level high`.
5. Upgrade Vite/esbuild if advisory still applies, or document a justified non-applicability decision in `SECURITY.md`.
6. Consider a small asset validation script for font MIME/signature checks.

**Acceptance:**

- `file src/assets/fonts/SUIT-Variable.woff2` reports font data, not HTML.
- `pnpm audit --audit-level high` passes or has a documented, reviewed exception.

## Phase 6: Tauri Security and Packaging

**Files:**

- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Inspect opener call sites under `src-tauri/src/**` and `src/**`
- Create/modify: `.github/workflows/release.yml`
- Create/modify: docs under `docs/reference/`

**Steps:**

1. Add production CSP compatible with Tauri IPC, local assets, markdown rendering, OAuth loopback, and required network endpoints.
2. Audit `opener` usage and restrict schemes/hosts where Tauri capability supports it; otherwise centralize URL validation in Rust/TS before opening.
3. Decide bundle identifier for public distribution. If changing from `co.kr.mirrorless.workradar`, document DB/keychain migration impact.
4. Add Linux packaging smoke to CI or a separate release workflow.
5. Add release matrix for macOS/Windows/Linux artifacts.
6. Document macOS Developer ID signing/notarization and Windows signing status.
7. Decide updater policy:
   - Initial release: manual download only, documented.
   - Later release: Tauri signed updater with key management.

**Acceptance:**

- `pnpm tauri build` succeeds on at least one CI runner.
- Public release docs explain whether builds are signed/notarized.
- CSP is active in release config.

## Phase 7: CI and Quality Gates

**Files:**

- Modify: `.github/workflows/ci.yml`
- Optional create: `.github/dependabot.yml`
- Optional create: scripts under `scripts/`

**Steps:**

1. Fix `pnpm format:check` failures or explicitly ignore generated/archive files in `.prettierignore`.
2. Add dependency update policy: Dependabot or documented manual cadence.
3. Add `pnpm audit --audit-level high` or a documented equivalent gate.
4. Add secret scan gate for current tree.
5. Run historical scan separately before public source/mirror/archive release.
6. Preserve `src/bindings.ts` drift check after Rust tests.

**Acceptance:**

- CI is green from a clean clone.
- Known generated/archive exceptions are explicit, not accidental.

## Phase 8: Fresh Machine Release Candidate

**Files:**

- Modify only docs or scripts found broken during smoke

**Steps:**

1. Test from a fresh macOS user account or clean VM:
   - Install prerequisites.
   - Run README setup.
   - Start dev app.
   - Build packaged app.
2. Test empty first-run app:
   - No GitHub/Notion/Google/Codex installed.
   - App degrades gracefully.
3. Test optional integrations one by one:
   - GitHub token import/paste.
   - Notion token.
   - Google OAuth client + loopback.
   - Codex/Hermes absent and present.
4. Inspect logs and app data for secret leakage.

**Acceptance:**

- Fresh setup notes are accurate.
- App is usable without optional integrations.
- Logs do not include tokens or unnecessary PII.

## Phase 9: Release Candidate Decision

**Files:**

- Modify: `docs/decisions.md`
- Optional modify: `README.md`, release notes

**Steps:**

1. Choose release channel:
   - Private Git + public binaries.
   - Private Git + invite-only binaries.
   - Curated public source archive.
   - Public mirror later.
2. Write release notes with known limitations.
3. Tag release only after verification evidence is attached.

**Acceptance:**

- The release channel matches the ADR.
- Known limitations are visible before download/install.

## Verification Bundle

Run from repo root unless noted:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm check:frontend-ownership
pnpm check:classname-regression
pnpm check:design-tokens
pnpm test:design-tokens
pnpm test
pnpm audit --audit-level high
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

If any command cannot run, record why and whether it blocks public distribution.

## Current Verification Snapshot (2026-06-15)

- `pnpm tauri build`: passed on macOS arm64. Produced:
  - `src-tauri/target/release/bundle/macos/Work Radar.app`
  - `src-tauri/target/release/bundle/dmg/Work Radar_0.1.0_aarch64.dmg`
- `pnpm audit --audit-level high`: failed on `esbuild` via `vite` (`GHSA-gv7w-rqvm-qjhr`, high; patched `esbuild >=0.28.1`).
- `cargo audit --file src-tauri/Cargo.lock`: failed on `rsa 0.9.10` (`RUSTSEC-2023-0071`, medium, no fixed upgrade available) and reported unmaintained/unsound transitive warnings including GTK3 bindings, `paste`, `proc-macro-error`, `unic-*`, and `glib`.
- Targeted tracked-file secret regex scan for common live token patterns returned no matches.
- Targeted tracked-file private metadata scan still found `64etuor/work-radar`, `/Users/davidpark/private_project/work-radar`, and `64etuor@gmail.com` occurrences across README/docs/tests/governance notes. Treat these as repo-surface hygiene work, not secret leakage.
- `gitleaks` was not installed in the local shell during this snapshot; run a dedicated tool before any public source/mirror/archive release.

## Parallelization Plan

Safe parallel lanes after Phase 0:

- Lane A: repo/document hygiene (`README`, license, NOTICE, contributor docs)
- Lane B: privacy hardening (`persist.ts`, error redaction, tests)
- Lane C: release engineering (`tauri.conf.json`, capabilities, CI/release workflow)
- Lane D: asset/dependency hygiene (`SUIT` font, audit, dependency updates)

Do not parallelize edits to the same files. Integrate through small commits and rerun the full verification bundle after merging lanes.

## Stop Conditions

- Stop before public artifact publishing if license is undecided.
- Stop before calling this "open source" if the only artifact is binary and source remains private.
- Stop before release if `pnpm audit --audit-level high`, `pnpm format:check`, Rust clippy/test, or packaging smoke fails without a documented accepted exception.
- Stop before changing bundle identifier unless DB/keychain migration consequences are documented.
