# Boule v2 — First Slice: One Escalation Round-Trip (spec)

- **Date**: 2026-06-01
- **Status**: spec (forks resolved; ready to plan) — PARKED branch, commit-only
- **Branch**: `feat/governance-boule-p1`
- **Parent design**: `docs/superpowers/specs/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md` (the v2 architecture; this spec implements its §5 first slice only)
- **Provenance**: forks resolved by a **two-model consult** (codex gpt-5.5 repo-sandboxed + opus architect that read the live `~/.hermes` fabric). Both independently picked **(a) bounded adapter** and both flagged the same INVARIANT-#1 risk (the inbound half) and the same first-slice code gaps. User confirmed both decisions 2026-06-01.

## 1. Goal (the smallest provable round-trip)

Prove the v2 escalation spine end-to-end with the smallest build: **no Planner, no Conductor, no cmux spawning.**

A Governance MCP command **`escalate(question, options[])`** that mints a Type 0 `decision_proposed` + a new `decision_blocked` event → the question + tappable option tokens reach a Telegram topic on the phone → tapping an option routes back through a **human-gated** resolver → a `decision_chosen` (actor:"user") event lands → `why <id>` prints the full append-only chain.

That single round-trip exercises: Type 0 emission, append-only escalation, the identity triple, reuse of the mature Telegram fabric, and the **structural impossibility of agent self-resolution** — without the orchestration that later slices slot onto a proven loop.

## 2. Settled decisions (this slice)

1. **Bridge seam = (a), tightened to a bounded one-shot adapter** (codex's "a-prime"). Boule (TS) only emits append-only events; the network stays in the Python `~/.hermes` fabric. No daemon — the outbound adapter is a **bounded `sync-once`** (`--limit N --since <cursor>`, idempotent, sent-markers keyed by `decision_blocked` event id). Rejected (b) (couples the TS sidecar to the fabric CLI + makes it causally trigger the network — against INVARIANT #3) and (c) (pure new machinery over an already-append-only store).
2. **Type 0 tap resolves via a NEW `choose` / `decision_chosen` path**, NOT through `approve()`. Faithful to design §3.1 (Type 0 ≠ Type 1): a tapped option is a human direction-pick, not an ADR approval, so it must **not** be gated by the Type-1 distinct-model review quorum (`canApprove`). It IS human-gated (`actor:"user"`, transport-trusted). The full Type-1 path (escalate → type1_candidate → review → approve) stays deferred to a later slice.
3. **ID contract uses the real `evt_*` id, not `dec_*`.** `proposeDecision()` mints `generateId("evt", …)` today (`event/id.ts`, `handlers.ts:19`); the parent design's `dec_*` was aspirational. Smallest change = drop `dec_*` from the bridge contract; the token and the identity triple key on the actual `evt_*` decision id. No churn to existing ids/tests.

## 3. The two-mechanism split (the correction both models made)

The design's (a) one-liner ("maps the reply token back to a Boule MCP call") hides the whole INVARIANT-#1 risk. (a) is actually **two** independent mechanisms; build and test them separately:

- **Outbound (Boule → phone)** — bounded, append-only-native. Boule `escalate` does only `writeEvent` (Type 0 `decision_proposed` + `decision_blocked`). A small Python adapter does a **bounded sync-once**: read new `decision_blocked` events since a stored cursor, pipe a normalized payload into the existing sink `cmux_notify_telegram.py:main` (it already reads stdin; `_ensure_topic:100` reuses the forum topic; `sendMessage:212` makes the only network call). The TS sidecar **never imports a network client** → INVARIANT #3 satisfied structurally.
- **Inbound (tap → verdict)** — synchronous interceptor, NOT a watcher. The reply arrives at `~/.hermes/.../platforms/telegram.py:_handle_text_message` (~line 4950), which today calls `try_forward` (`cmux_topic_router.py:77`) and **blind-forwards every topic reply into the cmux pane**. Prepend a token-match guard **before** the `try_forward` call (~line 4968): on an **exact** token match, invoke the gated Boule MCP `choose` tool and return; otherwise fall through to `try_forward` unchanged (normal pane steer preserved).

## 4. INVARIANT #1 safety — structural rails (this slice)

- **Python never writes a `decision_*` verdict event.** The adapter may ONLY invoke the gated MCP tool (`choose`). Writing a verdict event file from Python would bypass the gate entirely. This is a new rail (§7).
- **Capability split.** Agent-visible tools (a future spawned session would see): `escalate`, `propose_decision`, `conflicts`, `why`, `history`, read-only ingress. Bridge/human-only: `choose`, `approve`, `reject`. In this slice there is no spawned session, so the split is enforced by (i) `choose`/`approve`/`reject` hard-pinning `actor:"user"` and (ii) the bridge being the only caller of `choose`. Document the split as the rail it will become.
- **Opaque, single-use, fully-bound token.** Format (codex): `BOULE:<blocked_event_id>:<decision_evt_id>:<option_token>`. Minted at `escalate` time, stored on the `decision_blocked` event body, scoped to (thread, decision, event, option). **Exact-equality allowlist match only** — never substring/keyword (the WORKLOG inbound-routing bug-class is exactly substring routing). A `BOULE:`-prefixed message that doesn't validate is consumed/rejected, NOT forwarded to the pane. Non-prefixed text stays a normal steer.
- **Binding enforced in code, not just in the string (slice1A, post-critic M1).** `chooseOption` does NOT trust its `(decisionId, blockedEventId, optionToken)` args blindly: it loads the referenced `decision_blocked` event, asserts it is of THIS decision (`related_to` includes `decisionId`), and asserts `optionToken` is one this escalation actually minted. A mismatched/fabricated tap returns `{ok:false}` and writes nothing. This makes the "fully-bound" guarantee true in code, not merely in `parseToken`'s string check.
- **`choose` must stay bridge/human-only (rail for 1B).** The binding guard stops fabricated options, but does NOT by itself stop the _escalating agent_ (which learns the triple from `escalate`'s return) from calling `choose` and laundering `actor:"user"`. The structural guarantee that "only a human Telegram tap calls `choose`" is the transport split landed in 1B (the inbound interceptor is the sole caller, firing only on a human tap). Until then, `choose` is NOT exposed to any spawned session. If `choose` is ever made agent-visible, the binding guard alone is insufficient — that is an explicit open question carried to the relevant slice.
- **No auto-default on a blocked decision** (design §6.1). A blocked Type 0 stays blocked until a human event arrives — no `setTimer`, no timeout-resolve. The only loop is the outbound bounded scan (INVARIANT #5).
- **Double-tap idempotency.** Telegram can redeliver. `writeEvent`'s `wx` flag protects the file, but the second tap must no-op cleanly with a friendly "already resolved" reply (read `deriveDecisionState`), not surface a raw EEXIST.

## 5. Slice decomposition (TS-first, fabric-second)

The TS side is safe + headless-testable; the Python side touches the user's **live** `~/.hermes` fabric and needs a live smoke. Split accordingly:

### Slice 1A — TS sidecar (safe, headless, no fabric changes)

- `event/event.ts`: add `decision_blocked`, `decision_chosen` to `EventType`.
- `decision/`: a `chooseOption` handler — mirrors `approve()` minus `canApprove`, pins `actor:"user"`, writes `decision_chosen` referencing the `decision_blocked` event + chosen option. `deriveDecisionState` recognizes `decision_chosen` as a terminal resolution of a Type 0.
- `escalate(question, options[])` — mints `decision_proposed` (Type 0) + `decision_blocked` (rich fields from design §3.2: `ambiguity_kind`, `options[]` each with a stable token, `blocked_on`, `minimum_required_gate`, `agent_recommendation`). Returns the structured escalation payload (codex's a-prime: caller/adapter can act on the return without a daemon).
- MCP: register `escalate` + `choose`. Token minting + exact-match validation as a pure helper (testable without the fabric).
- All verifiable headless: vitest + the existing stub-MCP round-trip driver.

### Slice 1B — Python fabric bridge (live system, needs care + live smoke)

- Outbound bounded adapter (`sync-once --limit --since cursor`) → existing sink.
- Inbound interceptor prepended at `telegram.py:~4968` ahead of `try_forward`; a new `try_governance_reply(chat_id, thread_id, text)` helper (reuses `resolve_surface`'s registry lookup) that invokes MCP `choose` on exact token match.
- **One characterization test** (both models): valid token → governance resolves; normal reply → forwarded to pane (steer preserved); malformed `BOULE:` token → NOT forwarded. This single test pins both halves of INVARIANT #1 + the §3.7 disambiguation.
- ⚠️ Touches the user's daily-driver fabric → explicit user awareness + a real phone round-trip smoke before "done".

## 6. INVARIANT compliance (preliminary — full check at critic time)

| #   | Posture                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Structural: Boule emits proposals/blocks only; resolution = human `choose` (`actor:"user"`); Python never writes a verdict event (new rail). Agent can't forge a tap. |
| 2   | Telegram credentials live in `~/.hermes` (outside repo); Boule emits local events, holds no tokens.                                                                   |
| 3   | Network stays in the Python sink (`sendMessage`); the TS sidecar imports no network client.                                                                           |
| 4   | Governance MCP is stdio (not Tauri IPC) → no `bindings.ts` change.                                                                                                    |
| 5   | Outbound adapter is a bounded `sync-once` (`--limit/--since`); no infinite poll; no auto-default on blocked.                                                          |
| 6   | No DB; append-only markdown events (gitignored runtime).                                                                                                              |
| 7   | No in-app UI this slice (Telegram card is the fabric's surface).                                                                                                      |

Verification is a **separate reviewer (critic) pass** — no self-approve.

## 7. New rail to assert (later, via Meta-Observer PR gate)

`decision-rails.md`: \_"The Python fabric (and any spawned execution session) never writes a `decision\__` verdict event; it may only invoke the gated MCP tool. A session/agent that hits a Type-1 decision MUST escalate and MUST NOT self-resolve."\* A natural extension of INVARIANT #1; per the constitution it must itself pass the Meta-Observer PR gate (deferred with the rail).

## 8. Out of scope (deferred, unchanged from design §8)

Planner, Conductor + cmux spawning, autonomy-envelope schema, full Type-1-via-Guardian flow, ADR-0007 companion note, the `decision-rails.md` rail landing, Slack mirror, Pattern Detector (L0→L1). None block this slice.

## 9. Verification plan

- **1A**: governance `vitest` (new: EventType, chooseOption handler, escalate, token mint/validate, double-tap no-op, deriveDecisionState terminal) + `tsc` 0 + headless stub-MCP round-trip (escalate → choose → `decision_chosen` lands → `why` chain) + bindings drift 0 + no app/Rust/migration changes.
- **1B**: the one characterization test (3 branches) + a **live phone round-trip smoke** (escalate from a terminal → card arrives in the `{workspace} — {task}` topic → tap → `decision_chosen` actor:user lands → `why <id>` prints the chain). State explicitly if the live smoke could not run.
- Independent **critic (opus, separate pass)** ACCEPT before "done". Commit only; **do not push** (Boule parked).
