# SSOT Governance Harness — Boule v2: First-Class HITL + Plan→Execution→Escalation Loop (architecture design)

- **Date**: 2026-06-01
- **Status**: design (architecture agreed on 3 forks; one seam open) — pre-plan, parked
- **Branch**: `feat/governance-boule-p1` (PARKED, unpushed — commit only, never push without explicit request)
- **Parent design**: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md` (5-layer model, 7 agents, §5 interface, §6 INVARIANTs)
- **Provenance**: synthesized from a **two-model architecture consult** — `codex exec` (gpt-5.5) + an opus architect agent — both grounded in the real layer model, the mechanized Type-1 gate (`canApprove`), the append-only event store, and the user's live Telegram/cmux Hermes fabric (`~/.hermes/WORKLOG.md`). The two converged on the spine and diverged on one axis (plan representation); the user resolved all open forks (below).

## 1. Problem & Context

Today Boule's human-in-the-loop (HITL) is **narrow and binary**: it exists only at **L3 Type 1** (ADR approve/reject) and **L4** (principle-evolution PRs). The user wants two things:

1. **HITL as a first-class dimension across all layers** — not just the Type-1 gate.
2. A **Plan → Execution → Escalation loop**: the user discusses & loads a new feature → the system sequences it into an implementation order → it uses the **cmux CLI to spawn new coding sessions** and starts work → **ambiguous decisions that arise _during_ execution are re-surfaced to the human via the observation area** (the event/Telegram surface), never silently auto-decided.

Constraint: keep the **complex-systems implementation philosophy** (append-only events, emergence, path-dependence, bounded autonomy, _escalation-not-automation_, markdown SSOT) and embed this **naturally**, while preserving **INVARIANT #1** (automation must never penetrate the decision rails).

A key asset already exists: a **mature Telegram + cmux HITL fabric** (standalone Hermes gateway in `~/.hermes`) — session-keyed forum topics, bidirectional reply→pane injection, an error-only **read-only-by-default** watchdog. This is exactly the "human surface" the master design hand-waved; the goal is to **reuse it**, not rebuild it.

## 2. Settled Decisions (user-resolved forks)

1. **Plan representation = projection over L3 (minimal)**, _not_ a new layer/tier. Adopt the richer escalation **event schema** on top. (Chosen over a named "L2.5 Plan Graph" object — smaller change, reuses existing fold/reference-graph machinery, keeps the epistemic ladder clean.)
2. **First slice = governance round-trip, no cmux spawn yet** — prove the escalation loop's governance spine and de-risk the routing seam before any orchestration.
3. **Two-surface HITL** — execution-time **Type 0 → Telegram** card (the mobile fabric the user actually uses); high-ceremony **Type 1 ADR / L4 → in-app Hermes cards** (ADR-0007 retained). Needs an ADR-0007 companion note.

## 3. Architecture

### 3.1 No new layer — a cross-cutting HITL control plane + named Type 0

Keep L0–L4 unchanged as the _epistemic/causal_ ladder (raw fact → pattern → inference → committed promise → constitution). HITL becomes a **cross-cutting control plane**, expressed as **events**, not a layer.

New rule (the heart): **an agent may continue only while its next action is inside a pre-authorized _autonomy envelope_; crossing the envelope emits an escalation event and halts.**

**Type 0 = pending/unresolved** is _named_, not newly invented: `deriveDecisionState` (`governance/src/decision/decision.ts`) already returns the state `phase:"proposed", verdict:null` — that **is** Type 0. The change is (1) name it `Type 0 / pending` in the model + command surface, and (2) make it **emittable mid-execution**, not only at ADR-creation time. Type 0 is a _holding state_, not a peer of Type 1/2; it resolves into: Type 2 reversible line · Type 1 ADR candidate · plan revision · task cancellation · human instruction · no-op.

### 3.2 The escalation event — `decision_blocked`

One new L0 event type (≈ one enum entry in `event/event.ts` + a handler mirroring `proposeDecision`):

- **`decision_blocked`** — `source: agent_run`, `actor` = the cmux session id. "A running session hit a fork it is forbidden to resolve." Body carries the question + discrete options. `related_to → dec_*` (the decision it asks about, or a fresh Type 0 `decision_proposed` it just minted).

Rich fields (from the codex consult — they enable severity/batching, defusing topic-sprawl):

- `ambiguity_kind`: scope · architecture · irreversible-design · security · product-behavior · dependency · data-loss · cost · schedule · unknown
- `options[]`: the discrete choices (each gets a stable **option token**, see §3.7)
- `blocked_on`: human · external-review · repo-state · credential · policy
- `minimum_required_gate`: none · human · external-review · type1-guardian
- `agent_recommendation` (advisory only)

> **Philosophical payoff**: ambiguity → escalation is **emergence captured as an event**, not automation papering over a gap. The session does not decide; it _observes that a decision is needed_ and records that observation.

### 3.3 Plan = projection over L3

- **`plan_proposed`** event — body = an ordered list of _intended_ decisions/tasks, each step `related_to` a `dec_*` id.
- **`plan_revised`** event — supersedes a prior plan id (same supersession pattern the Telegram topic cleanup already uses). The "current plan" = the projection over the **latest non-superseded** `plan_*` event; never an edited file.
- Plan **state is fully derived** from the decision events its steps point at — the existing `deriveDecisionState` fold + the `governance/src/index/` reference-graph machinery. A plan is "done" when every step reaches a terminal verdict or emits `task_completed`.
- Relationship: **plan : decisions :: an ordered set : its elements.** The plan owns _sequencing & path-dependence_ (step N's outcome can rewrite N+1…); each decision owns its _own gate_. **A plan never approves anything.**
- **Plan acceptance is human-gated** when it spawns execution or changes repo direction (`plan_accepted`, `actor:"user"`).

### 3.4 Two new propose-only agents

1. **Planner** (time-scale: _on intent-load_, deliberate, high-end model) — consumes a "load feature X" intent, emits **exactly one `plan_proposed` (draft)**. Never executes; cannot accept its own plan.
2. **Conductor** (time-scale: _immediate_, event-triggered) — after a plan is human-accepted, spawns cmux coding sessions **one step at a time** via the cmux CLI; owns routing, identity mapping, liveness — **not task content**. A _dispatcher, not a decider_: may only spawn, observe `task_completed`/`decision_blocked`, and advance the plan pointer. **No `approve` capability.**

This generalizes the watchdog's proven default (`CMUX_WATCHDOG_STEER=0` = investigate + report, never steer) from _error_ events to _ambiguity_ events.

### 3.5 Autonomy envelope (the boundary)

Every spawned session gets a **machine-readable contract**: allowed files/scope, allowed reversible (Type-2) actions, forbidden decision classes, escalation triggers. The session is **workspace-write inside its isolated worktree** (INVARIANT #6 — never the user tree) and free to make Type-2 micro-choices. The instant it must choose outside the contract — a Type-1 boundary, a new consequential dependency, an invariant conflict, ambiguous product/architecture intent — it **must emit `decision_blocked` and stop**.

### 3.6 Two-surface HITL + identity triple

- **Type 0 (execution-time)** → posted to the **owning cmux session's existing Telegram topic** (`{workspace} — {task}`, keyed `session:<surface>`). Options render as the tappable buttons the master design's §5.1 `ask_user` always wanted — now over the _mature_ channel.
- **Type 1 ADR / L4 principle** → the in-app Hermes shadcn approval cards (ADR-0007), unchanged.

**Identity triple (load-bearing):** `governance decision_id (dec_*) ↔ cmux session (session:<surface>) ↔ Telegram topic (message_thread_id)`. The `session ↔ topic` edge already exists and is battle-tested in `cmux-telegram-topics.json`; **we add one new edge** (`dec_* ↔ session`, carried on the `decision_blocked` event, optionally persisted as `surface.binding.created`).

### 3.7 The routing seam (risk #1) — structured cards + option tokens

A Telegram reply must disambiguate **"steer the session"** vs **"resolve a governance fork."** The WORKLOG shows this inbound-routing bug-class bites repeatedly. Rule: governance escalations post a **structured card with explicit option tokens**; only a reply matching a token is routed to the Governance MCP as `approve <id>` / `reject <id>` / `choose <id> <option>` — **everything else falls through** to normal pane injection. This seam deserves its own characterization tests.

### 3.8 INVARIANT #1 safety — structural, not procedural

- **The spawned session has no write-path to a verdict.** `decision_approved` is minted only by `approve()`, which hard-pins `actor:"user"` and is guarded by `canApprove` (refuses without a distinct-model review quorum). A session emitting `decision_blocked` cannot forge approval — worst case it emits _more proposals_ (the safe direction).
- **The new agents only PROPOSE.** Planner → one draft plan. Conductor → spawn + advance. Neither has an approve capability (mirrors the master design §7 path-restriction model).
- **Append-only is the audit.** Every escalation/choice/resolution is an immutable `wx` event; `why <id>` reconstructs the full chain. The opposite of silent automation.
- **Default is halt-and-ask**, inherited from the watchdog's read-only-by-default posture; steering is opt-in.
- **New rail to assert in `decision-rails.md`**: _a spawned execution session that encounters a Type-1 decision MUST escalate and MUST NOT self-resolve._ A natural extension of INVARIANT #1 — and per the constitution it must itself pass the Meta-Observer PR gate.

## 4. The One Open Seam — Boule ↔ Telegram bridge (decide in the plan)

Even the no-cmux first slice needs Boule (TS sidecar in `governance/`) to reach the Telegram fabric (Python in `~/.hermes`) and get the tapped reply back. This seam determines coupling, where code lives, and the INVARIANT #3 posture. Three shapes:

- **(a) Event + adapter (RECOMMENDED).** Boule emits the `decision_blocked` event; a small adapter on the `~/.hermes` side watches/harvests it, posts to Telegram via the existing sink, and maps the reply token back to a Boule MCP call. _Loosest coupling, append-only-native, each side stays in its own language._
- **(b) Direct sink shell.** Boule MCP `escalate` directly shells the existing `cmux_notify_*` sink; the inbound router calls back into Boule MCP. _Tighter, fewer moving parts, couples the sidecar to the fabric's CLI._
- **(c) Shared contract file/socket** both poll. _Most explicit, most new machinery._

**Recommendation: (a)** — to be confirmed when writing the implementation plan. This is the single decision deferred out of this design.

## 5. First Slice (chosen) — one escalation round-trip, no cmux

Prove every architectural claim with the smallest possible build. **No Planner, no Conductor, no cmux spawning.**

1. A Governance MCP command **`escalate(question, options[])`** that mints a Type 0 `decision_proposed` + a `decision_blocked` event (the only new event type; ≈ one enum entry + a handler mirroring `proposeDecision`).
2. A thin **Boule↔Telegram bridge** (seam per §4, recommend (a)) that posts the card to a Telegram topic via the _existing_ sink and maps a tapped option token back to the existing `approve`/`reject`/`choose` handlers.

**Manual proof**: from a terminal, `escalate("DB: SQLite or Postgres for X?", ["sqlite","postgres"])` → the card arrives in the `{workspace} — {task}` topic on the phone → tap → a `decision_approved` event lands in `governance/workspace/events/` with `actor:"user"`, and `why <id>` prints the full chain. That single round-trip exercises Type 0 emission, append-only escalation, the identity triple, fabric reuse, and the structural impossibility of agent self-approval — **without** the Planner/Conductor/cmux orchestration, which then slot onto a _proven_ loop.

## 6. Top Risks

1. **Conductor becomes a de-facto decider via defaults.** A `choose` timeout-default, or a Planner ordering that implicitly forecloses options, = automation through the back door. Mitigation: **no auto-default on `decision_blocked`** — a blocked session stays blocked until a human event arrives (accept the latency; it is the whole point). Bound the _session_, never the _decision_.
2. **Topic ↔ decision routing ambiguity** (§3.7). A casual reply misread as approval. Mitigation: structured cards + explicit option tokens; only token-matching replies resolve; characterization tests (this bug-class has bitten the fabric repeatedly).
3. **Plan path-dependence vs append-only immutability.** Step 3's outcome invalidates step 5, but the plan event is immutable. Mitigation: `plan_revised` supersession; the plan is a projection over the latest non-superseded `plan_*`.
4. **Classification drift.** An agent labels a Type-1 as Type-2 to keep moving. Mitigation: conservative defaults + Guardian reclassification; Type 0 has **no auto-resolution path** for consequential ambiguity.

## 7. INVARIANT Compliance (preliminary — full check at plan/critic time)

| #   | INVARIANT                    | Posture                                                                                                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 자동화 → 결정 레일 침투 금지 | Structural: sessions/agents only emit proposals/blocks; no write-path to `decision_approved` (actor:user + `canApprove`). New rail asserts mandatory escalation.                |
| 2   | 외부 토큰 keychain           | Telegram credentials already live in the `~/.hermes` fabric (outside the repo); Boule emits events, does not hold tokens. To verify per bridge seam.                            |
| 3   | 외부 네트워크 Rust           | The Telegram network call stays in the existing Python fabric; Boule (TS sidecar) emits local events. Bridge seam (a) keeps the network out of the sidecar. To confirm in plan. |
| 4   | IPC = specta                 | Governance MCP is stdio (not Tauri IPC) → no `bindings.ts` change for the first slice. In-app Type-1 cards already specta (P2b).                                                |
| 5   | bounded retry                | Escalation is event-driven + human-gated; no polling loops in the sidecar. Bridge adapter (if it watches) uses bounded scans.                                                   |
| 6   | SQLite 마이그레이션만        | No DB; append-only markdown events. Worktree isolation for spawned sessions (later slices).                                                                                     |
| 7   | 시각 디자인 DESIGN.md        | First slice has no in-app UI (Telegram card is the fabric's surface). Later in-app affordances on shadcn.                                                                       |

Verification is a **separate reviewer pass** (critic) — no self-approve.

## 8. Deferred / Follow-ups (post first-slice)

- **Bridge seam (a/b/c)** final decision — the one open fork, resolved at plan time.
- **Planner** agent (intent → `plan_proposed`) and **plan acceptance** gate.
- **Conductor** agent + **cmux session spawning** + the **autonomy-envelope** schema.
- **Type 1 fork through the Guardian** end-to-end (`decision_blocked → type1_candidate → external_review → human_gate → approved/rejected`).
- **ADR-0007 companion note** (two-surface HITL: Telegram for Type 0, in-app for Type 1).
- **`decision-rails.md` new rail** (mandatory escalation) via the Meta-Observer PR gate.
- Dependency note: full pattern-driven planning benefits from the **Pattern Detector** (L0→L1), still unbuilt — but the escalation loop does **not** block on it.

## 9. Provenance

Two independent model proposals (codex gpt-5.5 + opus architect), brief at `/tmp/boule-arch/brief.md` (ephemeral). They converged on: no new layer, Type 0 = pending (already in code), ambiguity-as-typed-event, propose-only Planner/Conductor, reuse the Telegram fabric, structural INVARIANT-#1 safety, smallest-slice = one escalation round-trip. They diverged only on plan representation (named L2.5 object vs projection-over-L3); the user chose **projection-over-L3** + the richer escalation event schema.
