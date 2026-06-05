# Phase 5 — Gmail AI-origin connector (gated send)

**Status: pending approval** (ralplan consensus artifact — planning only, no execution)
**Track:** External Action Gate. Branch `feat/external-action-phase3` (tip `c533c0f`), worktree `.claude/worktrees/external-action-phase4`.
**Spec:** `docs/superpowers/specs/2026-06-04-external-action-gate-mcp-design.md` §4 (Phase 5).
**Mirrors:** Phase 4 Calendar connector (`calendar/write.rs::execute_calendar_action`, `commands/external_actions.rs` router, `external_actions/mod.rs` enum). The **largest arm** — the only one needing a _new_ `TokenKind` + OAuth.
**Revision 2** (post-architect): R1 MIME-injection story split out; R2 audit framing fixed; R3 getProfile→refresh-ping (send-only scope); R4 US-006 re-scoped to real connect surface; R5 CSRF-parity tripwire.
**Revision 3** (post-critic): C1 recipient-in-preview requirement + test (US-005); M1 audit-PII assertion targets the `ref=…,bytes=…` detail string with a distinctive recipient; M2 input-interpolation PII assertion (US-002/003); M3 MIME builder = reject-only for header control chars incl. folded continuations; G2 command-registration site named (US-006); G3 `kind_str` stability case (US-004); G4 `GmailSendParams` schema-closed case (US-005); m1 US-007 tightened (label pre-exists).

---

## RALPLAN-DR (deliberate mode — OAuth + external send + PII)

### Principles

1. **Single chokepoint.** AI proposes (MCP enqueue), Rust executes after human approval. No new decision rail (INVARIANT #1).
2. **Least privilege.** Request `gmail.send` **only**. No read scope. Validate the connection by token refresh, not by reading mail.
3. **No duplicate / misdirected sends.** Email send is non-idempotent _and_ high-consequence — single-attempt write; failure surfaces for re-proposal, never silent retry (INVARIANT #5).
4. **Content-free audit.** Recipient, subject, body are PII — audit/logs carry sizes + a message id only, never content (INVARIANT #7).
5. **What the human approves is what sends.** The approval preview must equal the bytes that go to Gmail — no smuggled headers (INVARIANT #2 chain-of-custody).
6. **Mirror, don't reinvent.** Reuse the established 3-spot seam and the Phase 4 connector shape so the diff reads as "one more arm."

### Decision Drivers (top 3)

1. **Safety of a non-idempotent, high-blast-radius write** — a duplicate or misdirected email is unrecoverable and externally visible (worse than a duplicate calendar event).
2. **Token isolation across personal/work profiles** — send uses _only_ the action's `project_ref` credential, never an ambient token (#11; already enforced by the router seam).
3. **Greenfield OAuth cost** — new `TokenKind::Gmail` + Google OAuth; minimize risk by mirroring the proven `calendar/oauth.rs` machinery without destabilizing it.

### Contested decisions (resolved)

**D1 — Google OAuth helper sharing.** Choose **mirror into `gmail/oauth.rs`** (not extract-shared, not cross-call calendar). Per-service-module precedent is real (`calendar/mod.rs:26` "github≠notion"). _But the architect is right that the dangerous duplication is the non-RFC-pinned CSRF `state` guard that lives in the caller (`commands/calendar.rs:170-175`), not the pure PKCE helpers._ Mitigation = **R5 parity tripwire** (below), not a refactor. Revisit extraction at rule-of-three (a 3rd Google service). _Deferred alt:_ extract `google_oauth` (lower long-run divergence risk; rejected now to avoid refactoring the live calendar OAuth path).

**D2 — connection validation read.** **REVISED (R3): validate via `refresh_core` token-refresh round-trip** (mirror `ping_google_calendar`, `commands/calendar.rs:251-288`) — boolean ok/detail, **send-only scope, zero PII, zero read scope.** `users.getProfile` is _rejected_ for the baseline because it requires a read scope (`gmail.metadata`/`readonly`), contradicting Principle #2. _Deferred alt:_ getProfile for account-email display = later additive story with `gmail.metadata` if the product needs it.

**D3 — scope.** `https://www.googleapis.com/auth/gmail.send`, send-only, as the single source const in `gmail/oauth.rs`. No mailbox/read scopes.

### Pre-mortem (4 scenarios)

1. **Duplicate / non-delivery on transient drop.** `send_message_once` (WRITE_MAX_ATTEMPTS=1, mirrors `create_event_once` `http.rs:311-328`) prevents retry-duplication but converts a dropped response into "failed" → user re-proposes → possible second send. Honest framing: client-side send-idempotency is **not achievable** via the Gmail API (no dedup token). Mitigation = single attempt + proposal-level `stable_idem_key` dedup + an explicit approval-panel caption that a re-proposal may double-send. Residual documented + surfaced (deferred, GOAL3 class). **Email's asymmetry called out explicitly** (vs calendar's nuisance-level duplicate).
2. **Header injection / chain-of-custody break.** A `\r\n` in `to`/`subject` smuggles `Bcc:`/extra `To:` into the RFC822 `raw` stream — and may not render in the human preview, so the human approves X and Y sends. Mitigation = **US-002 dedicated hardened MIME builder** with adversarial tests: **reject** (not escape) CR/LF/control chars in header fields incl. folded continuations; assert exactly one `To:`, no injected `Bcc:`; base64url round-trip. This is the single highest-risk new line in the phase (no Calendar analog — Calendar's payload is `serde_json`, injection-proof by construction `write.rs:32-60`).
3. **Wrong recipient via wrong token/identity.** Router resolves token only from `action.project_ref` cref (`external_actions.rs:53-62`); MCP takes `project_id` only + `deny_unknown_fields` + server `fetch_project`. Preview shows `[personal/work: name]` + recipient.
4. **PII / secret leak in audit or logs.** `external_ref` = message id only; audit `bytes` = combined header+body size (R2); `classify_http` scrubs response bodies incl. the **send error path** (a Gmail 400 can echo the recipient). Test asserts recipient/subject text never appears in `external_ref`, audit row, or any error string.

### Expanded test plan

- **Unit (pure, no network):** `auth_url` has S256 + exactly the `gmail.send` scope; `parse_token_response` ok/err **+ scrub assertion** (no `access_token`/`invalid_grant` in error string, mirror `oauth.rs:301-308`); `GmailCreds` blob round-trip + `has_refresh`; **MIME builder** (US-002) — header control-char **rejection** (reject-only, incl. folded continuation), base64url `raw` decode round-trip, single-`To:`/no-`Bcc:` assertion, no input interpolated into error strings; `classify_http` buckets + body scrub.
- **Dispatch (mock provider):** `GmailSendEmail` routes to `send_message_once` with the built message; `external_ref` = message id (not thread id/snippet); non-gmail action rejected; empty to/subject rejected pre-provider; the retrying `send_message` is **not** called by the gate (mock `unreachable!`, mirror `write.rs:303-311`).
- **Audit/PII:** assert recipient + subject text absent from `external_ref` AND the synthesized audit `detail` string (`ref=…,bytes=…`, `store.rs:230-236`); send-error-path scrub test.
- **MCP (headless):** unknown `project_id` → 0 enqueued; valid → enqueued with resolved cref as `project_ref`; identical proposal dedups; schema closed (`additionalProperties:false`), no `project_ref`/`credential_ref` in input schema (mirror `mcp/mod.rs:783-785`).
- **CSRF parity (R5):** gmail connect rejects `recv_state != state`.
- **Integration/observability:** gate round-trip enqueue→approve→execute→audit shows message-id + byte-size only; `recover_interrupted_actions` reaper covers a crashed gmail send (lease guard).
- **e2e / live (user-only, deferred):** real Google OAuth consent (PKCE loopback), real `gmail.send`, WKWebView settings connect — agent cannot mint OAuth or click native UI.

---

## PRD stories (ralph-ready, dependency-ordered) — 7 stories

### US-001 — Gmail OAuth foundation (+ CSRF parity tripwire)

**Adds:** `TokenKind::Gmail` (`as_str` "gmail"); `src-tauri/src/gmail/{mod.rs,oauth.rs}`: `GmailCreds {client_id, client_secret, refresh_token}` blob (mirror `CalendarCreds`), `GMAIL_SEND_SCOPE` const (send-only, single source), mirrored pure PKCE/redirect helpers, `connect_core`/`refresh_core`, `GmailError` (Transient/Terminal/ReconnectRequired) + `Retryable`.
**Acceptance:**

- `TokenKind::Gmail` added; `as_str`→"gmail"; all `TokenKind` matches still exhaustive (compile).
- `auth_url` includes `response_type=code`, `code_challenge_method=S256`, exactly the `gmail.send` scope; unit test round-trips query incl. scope.
- `GmailCreds::{from_blob,to_blob,has_refresh}` + `merge_refresh` mirror calendar; round-trip test.
- `parse_token_response` ok + error tested **incl. scrub assertion** (no token/grant text in error).
- **R5 (m2 — scope):** doc-comment cross-reference in `gmail/oauth.rs` marking the `state` CSRF guard as duplicated-with-calendar ("change both"). **No test is required at US-001** — the enforcing `recv_state != state` rejection test lands with US-006 (the guard lives in the connect command); US-001 must not be marked `passes` on the strength of a comment implying coverage that isn't here yet.
- `cargo test` new pure tests pass; `clippy --all-targets -D warnings` 0; `cargo fmt --check` clean.

### US-002 — Hardened RFC822/MIME message builder (pure, adversarial-tested) — R1

**Adds:** `src-tauri/src/gmail/message.rs`: pure `build_raw_message(to, subject, body) -> Result<String, GmailError>` producing base64url-encoded RFC822; header-field validation (reject CR/LF/control chars in `to`/`subject`); minimal MIME (text/plain, UTF-8, encoded-word or proper encoding for non-ASCII subject).
**Acceptance:**

- Valid input → base64url `raw` that **decodes** (test round-trips) to a message with exactly one `To:` and one `Subject:`, correct body.
- **M3 reject-only (no "escape" branch):** CR/LF/NUL/control chars in `to` or `subject` → **hard validation error** (`GmailError::Terminal`) _before_ any encoding — header values are validated, not sanitized. Adversarial tests reject: `to = "a@b.com\r\nBcc: evil@x"`, the folded-continuation variant `to = "a@b.com\r\n Bcc: evil@x"`, bare `\n`/`\r`/NUL in both `to` and `subject`. Assert that on valid input the built bytes contain exactly one `To:` and **no** `Bcc:`. Encoded-word is used only for the _body_ / non-ASCII display portions, and only _after_ control-char validation has passed.
- **M2 no input in error strings:** the validation-error message MUST NOT interpolate `to`/`subject`/`body` content — test triggers the injection rejection with a distinctive recipient (`leak@x.test`) and asserts that string does NOT appear in the returned error (only a code/reason).
- Non-ASCII subject/body encoded correctly (decode round-trip).
- Pure (no network/IO); `cargo test`/clippy/fmt green. Independent of US-003 → parallelizable with it.

### US-003 — Gmail HTTP provider + trait + single-attempt send + refresh liveness ping — R3

**Adds:** `src-tauri/src/gmail/http.rs` `HttpGmailProvider`; `GmailProvider` trait: `exchange_code`, `refresh_access`, `send_message` (bounded retry), `send_message_once` (single attempt, default-delegates to `send_message` for fakes). `classify_http` with body scrub (incl. send error path). Connection validation = `refresh_core` ping (no read API).
**Acceptance:**

- `send_message_once` uses `WRITE_MAX_ATTEMPTS=1` (no retry); `send_message` keeps bounded retry; non-idempotency rationale documented on the trait method referencing the calendar precedent.
- `classify_http` buckets (401/403/429/5xx/4xx) + **send-error-path body scrub** unit tests (a recipient echoed in a Gmail 400 **response body** never appears in the error message — inherited from the calendar `classify_http` pattern, emits `HTTP {status} ({len}B)` only).
- **M2 (input vector):** no error path in the gmail send/provider layer interpolates `to`/`subject`/`body` _input_ into its message — the genuinely new leak vector (vs the already-safe response scrub). Covered jointly with US-002's validation-error assertion.
- Connection validated via `refresh_core` round-trip (send-only scope; zero read scope, zero PII) — mirror `ping_google_calendar`.
- `cargo test`/clippy/fmt green.

### US-004 — Gmail send gate connector (the 3-spot seam) — R2

**Adds:** `ExternalAction::GmailSendEmail { to, subject, body }` + `kind_str` "gmail.send" (`external_actions/mod.rs`); `execute_gmail_action<P: GmailProvider>(provider, access_token, action)` (mirror `execute_calendar_action`): validate non-empty to/subject, call US-002 `build_raw_message`, `send_message_once`, return `ExecOutcome { external_ref: Some(message_id), bytes: Some((to.len + subject.len + body.len) as i64) }`; router arm + `gmail_access(action_id)` in `commands/external_actions.rs` via `cref_for_action` → new `gmail::access_token_for_cref(cref)` (cref-keyed OAuth refresh, mirror `calendar::access_token_for_cref`).
**Acceptance:**

- `external_ref` = Gmail message id only (never thread id/snippet/subject).
- **R2 + M1 (non-vacuous):** audit `bytes` = combined `to.len()+subject.len()+body.len()` (a length only). Dispatch test uses a **distinctive** recipient `leak@x.test` + subject and asserts that string appears in **neither** `outcome.external_ref` **NOR** the synthesized audit `detail` string produced by `(external_ref, bytes)` → `ref=…,bytes=…` (see `store.rs:230-236`, the real audit-detail formatter — NOT `write.rs:248-255`, which is a response-scrub test). Reuse the mock to feed the distinctive values.
- **G3 kind_str stability:** extend `external_action_kind_str_is_stable` (`mod.rs`) to assert `GmailSendEmail → "gmail.send"`.
- Mock-provider tests: routes to `send_message_once` with the US-002-built message; non-gmail action defensively rejected; empty to/subject rejected before provider; retrying `send_message` NOT called by the gate (mock `unreachable!`).
- Token resolved only from `action.project_ref`; missing → hard error (existing `cref_for_action`).
- `cargo test` (≥3 dispatch + 1 audit-PII + kind_str), clippy 0, fmt clean, bindings drift 0 (`ExternalAction` not specta-referenced).

### US-005 — MCP `wr_gmail_send` write tool

**Adds:** `GmailSendParams { project_id, to, subject, body }` (`deny_unknown_fields`); `wr_gmail_send` building `GmailSendEmail` + delegating to `enqueue_write_proposal`; reuse `stable_idem_key`. (Depends only on US-004's enum variant, not the provider — can start once the variant exists.)
**Acceptance:**

- Proposer supplies `project_id` only; server `fetch_project` resolves cref (no raw `project_ref`/`credential_ref` accepted).
- **C1 recipient-in-preview (chain-of-custody, Principle #5/#2):** the `wr_gmail_send` op_summary MUST embed the **recipient + subject**, e.g. `format!("Gmail 발송 → {to}: {subject}")`, so the resolved preview (`enqueue_write_proposal` builds `[kind: name] {op_summary}`, `mcp/mod.rs:369`) surfaces the exact recipient to the approver. **`write_tool_tests` asserts the enqueued row's `preview` contains the `to` value.** Column boundary (state explicitly so a future change doesn't break one fixing the other): the recipient appears in **`preview`** (required, for human approval) but NOT in the audit **`detail`** (R2/M1, `ref=…,bytes=…` only) — different columns, both hold.
- **G4 schema-closed case:** add `gmail_send_params_schema_is_closed_and_stable` to `schema_tests` (`mcp/mod.rs`, per its "Phase 2~5 신규 param은 케이스 추가" note): `additionalProperties:false`, exact field set, `project_ref`/`credential_ref` absent.
- `write_tool_tests`: unknown project → 0 enqueued; valid → enqueued with resolved cref; identical proposal dedups via idempotency key.
- GitHub/Notion/Calendar tools unchanged; `cargo test`/clippy/fmt green.

### US-006 — Backend OAuth connect surface (full mirror) + keychain — R4 + R5

**Adds:** `src-tauri/src/commands/gmail.rs` mirroring the **real** calendar surface: `set_gmail_oauth_client` (client_id/secret entry, mirror `set_google_oauth_client` `commands/calendar.rs:96`), `start`/`cancel`/`status`/`disconnect`, and the `oauth_attempts` cancellation registry (`commands/calendar.rs:25-73`); keychain set/get under `{cref}:gmail`. Register `#[specta::specta]` commands (bindings regen via `cargo test`).
**Acceptance:**

- Connect mirrors calendar (PKCE loopback `127.0.0.1:0` ephemeral, store `GmailCreds` blob under `{credential_ref}:gmail`); refresh rotates keychain only on token change.
- **R5:** the `recv_state != state` CSRF guard is present in `commands/gmail.rs` with the duplicated-with-calendar doc cross-ref; a test asserts state-mismatch rejection.
- **R4:** plan/code states whether a **separate Google OAuth client** (with `gmail.send` enabled) is required vs reusing the calendar client — document the expectation in the command doc + breadcrumb.
- **G2 registration site:** the new `#[specta::specta]` commands are registered in the **same Tauri builder `invoke_handler` + specta `collect_commands` list as the calendar commands** (`lib.rs`) — name the site so a ralph run doesn't define commands that compile but are never wired. Acceptance: `bindings.ts` shows the new gmail commands after `cargo test` regen.
- New commands present; `bindings.ts` regenerated (drift additive only); token body never returned to renderer (status = boolean/email-absent). `cargo test`/clippy/fmt green.
- _Live OAuth consent + loopback = user smoke (deferred, noted)._

### US-007 — FE preview + settings connect entry + breadcrumb

**Adds:** `PendingActionsPanel` lucide `Mail` icon branch for `gmail.*`; a settings entry to connect Gmail (mirror the calendar connect control); `docs/decisions.md` Phase 5 breadcrumb.
**m1 — genuine FE delta only (do NOT re-add label):** `serviceOf("gmail.send")→"gmail"` ALREADY works (pure dot-split, no change) and `formatActionKind` ALREADY maps `gmail→"Gmail"` (pre-added). The ONLY real code delta is adding `Mail` to the `lucide-react` import (currently `{ Calendar, Check, Github, X }`) + a `Mail` icon branch in `PendingActionsPanel.tsx` (alongside the existing github/calendar branches). Avoid a no-op re-add diff.
**Acceptance:**

- `serviceOf("gmail.send")` → "gmail" (assert via existing serviceOf test — no impl change); Mail icon branch renders for gmail actions; the recipient+subject reach the preview via US-005's op_summary (C1), rendered un-truncated (Principle #5 — human sees exact target).
- `pnpm typecheck` 0; `pnpm lint` 0 err (≤2 baseline warnings); `pnpm vitest run` green; prettier applied.
- `docs/decisions.md` one-line Phase 5 entry (dual-path N/A — gate-only; send-only scope; single-attempt; client-registration note; live smoke deferred). No scope creep.
- _Settings connect UI live click = user smoke (deferred, noted)._

---

## Dependencies / parallelism

- Order: US-001 → (US-002 ‖ US-003) → US-004 → (US-005 ‖ US-006) → US-007.
- US-002 (pure MIME) and US-003 (provider) are independent → parallelizable after US-001.
- US-004 needs US-002 builder + US-003 provider + the enum variant; US-005 needs only the enum variant (could start earlier).
- US-006 (connect) is independent of the gate tests (gate uses mocks) → lands after US-004.

## Gates (per `docs/reference/commands.md`)

cargo test + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` + `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` + bindings drift 0. Worktree gotchas: export `$HOME/.cargo/bin`; `Db`=`SqlitePool` (no Deref); `pnpm exec prettier --write` before FE commit; verify cargo via `rtk proxy cargo`; new PK id = i32 (no specta i64); bindings regen via `cargo test`. **No migration** (external_actions table reused; keychain `TokenKind` is an account suffix, not a DB column — `tokens.rs:5-26`).

## Completion bar

All 7 stories `passes: true`; full gate suite green; **critic (opus, separate ctx) ACCEPT 0 blockers**; deslop pass; post-deslop regression green; commit (NO push — user-explicit only). Live Google/Gmail API + OAuth consent + WKWebView = user smoke (agent cannot).

---

## ADR

- **Decision:** Add Gmail as the 5th external-action arm: greenfield `TokenKind::Gmail` + per-service `gmail/` module (own OAuth/error, mirroring calendar), a **gate-only** single-attempt `gmail.send` connector on the existing 3-spot seam, a **hardened RFC822 MIME builder with adversarial header-injection tests**, connection validation via **token-refresh ping (send-only scope, no read)**, and a propose-only `wr_gmail_send` MCP tool. No inbox reading; no getProfile in the baseline.
- **Drivers:** non-idempotent high-blast-radius write safety; per-profile token isolation; minimize OAuth/greenfield risk by mirroring proven calendar machinery.
- **Alternatives considered:** shared `google_oauth` extraction (D1-A, deferred — refactor risk to live calendar; revisit at rule-of-three); gmail→calendar direct call (D1-C, rejected — boundary coupling); `getProfile` validation read (D2, rejected — needs a read scope, violates least-privilege); full message reader (deferred — PII surface, not needed by the gate).
- **Why chosen:** mirroring keeps the diff reviewable as "one more arm" and preserves the per-service-module precedent; single-attempt send + content-free audit + hardened MIME builder directly satisfy INVARIANTs #5/#7/#2; the router seam already enforces #1/#2/#11; refresh-ping validation upholds least-privilege (#2-scope).
- **Consequences:** ~1 duplicated ~40-line pure PKCE helper set + a hand-duplicated CSRF `state` guard (accepted with an R5 parity tripwire; rule-of-three revisit for extraction); a residual lost-response double-send window remains (documented, surfaced, deferred — but email's asymmetry is flagged in the approval caption); a real send requires the user to connect Gmail (OAuth) first and possibly register a Google client with `gmail.send`.
- **Follow-ups:** shared `google_oauth` extraction (if a 3rd Google service appears); `getProfile`/account-email display (additive, `gmail.metadata`); full Gmail reader as a separate PII-reviewed feature; client-side send-idempotency hardening if Gmail ever exposes a dedup token.
