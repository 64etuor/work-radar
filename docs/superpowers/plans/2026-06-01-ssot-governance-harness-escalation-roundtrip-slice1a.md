# Boule v2 First Slice — 1A (TS sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**STATUS: ✅ COMPLETE (2026-06-01).** Implemented holistically (not the literal per-task commits below) and committed as `74b51b6` (code) + `ba086cb` (docs) on `feat/governance-boule-p1`, unpushed. vitest **150** pass, tsc clean, headless MCP round-trip observed, independent opus critic **round-2 ACCEPT** (round-1 MAJOR M1 = `chooseOption` binding-guard, fixed + 2 regression tests). Drift = `governance/**` + docs only. Done-line: tail of `docs/decisions.md`. **Next = Slice 1B** (Python `~/.hermes` fabric bridge — separate plan, touches the live fabric). The per-task checkboxes below are marked done to reflect the shipped work; commit granularity differed (2 cohesive commits, not one per task).

**Goal:** Build the headless TypeScript half of the v2 escalation round-trip — an `escalate(question, options[])` MCP command that mints a Type 0 `decision_proposed` + `decision_blocked`, and a human-gated `choose` command that resolves it via a new `decision_chosen` event — with zero changes to the live `~/.hermes` fabric.

**Architecture:** Append-only events only. `escalate` mints two events and returns a structured payload carrying one opaque, fully-bound option token per choice (`BOULE:<blockedEventId>:<decisionId>:<optionToken>`). `choose` is human-gated (`actor:"user"`) but NOT Type-1 review-gated (`canApprove` is for ADR approval; a Type 0 tap is a direction-pick). `deriveDecisionState` gains a terminal `chosen` phase so a redelivered tap no-ops. The Python bridge that posts to Telegram and routes the tap back is a SEPARATE plan (1B); 1A is provable headless.

**Tech Stack:** TypeScript (Node strip-types), vitest 2, MCP SDK 1.29 (`registerTool`), zod 4.4.3.

**Spec:** `docs/superpowers/specs/2026-06-01-ssot-governance-harness-escalation-roundtrip-slice1.md`

**Conventions (footguns — read before coding):**

- Runtime `src/**` imports use the **`.ts`** extension (`import { x } from "../event/id.ts"`).
- Test files import src with the **`.js`** extension (`from "../../src/escalate/token.js"`) — the vitest resolver maps `.js`→`.ts`. Getting this backwards breaks the run.
- Commands run from `governance/`: tests `pnpm test`, typecheck `pnpm exec tsc --noEmit`. (Install, if ever needed, is `pnpm install --ignore-workspace`.)
- `server.ts` connects stdio on import → it is NEVER imported by tests; test the logic below it.
- Commit only; **do NOT push** (Boule is parked). Export `PATH="$HOME/.cargo/bin:$PATH"` before any commit (husky pre-commit).

---

## File Structure

- `src/event/event.ts` (MODIFY) — add `decision_blocked`, `decision_chosen` to `EventType`.
- `src/escalate/token.ts` (CREATE) — pure mint/parse/classify of the opaque option token.
- `src/escalate/escalate.ts` (CREATE) — the `escalate()` orchestrator (mints the two events + tokens).
- `src/decision/decision.ts` (MODIFY) — `deriveDecisionState` recognizes `decision_chosen` → terminal `chosen`.
- `src/decision/handlers.ts` (MODIFY) — add `chooseOption()` (human-gated, not review-gated, idempotent).
- `src/mcp/server.ts` (MODIFY) — register `escalate` (agent-visible) + `choose` (bridge/human-only).
- Tests: `test/escalate/token.test.ts`, `test/escalate/escalate.test.ts`, extend `test/decision/decision.test.ts`, extend `test/mcp/handlers.test.ts`.

---

## Task 1: EventType — add the two new event types

**Files:**

- Modify: `src/event/event.ts:3-14`

- [x] **Step 1: Add the union members**

In `src/event/event.ts`, change the `EventType` union to add the two new types after `decision_rejected`:

```ts
export type EventType =
  | "commit_recorded"
  | "pr_opened"
  | "pr_merged"
  | "ci_failed"
  | "agent_run_completed"
  | "decision_recorded"
  | "decision_proposed"
  | "decision_review_recorded" // P2a: External Reviewer wrote a review for a decision
  | "decision_approved" // P2a: human gate passed (actor=user)
  | "decision_rejected" // P2a: human gate rejected (actor=user)
  | "decision_blocked" // v2 slice1: a Type 0 escalation — a fork that needs a human (source=agent_run|hermes)
  | "decision_chosen" // v2 slice1: human picked an option for a Type 0 (actor=user, NOT review-gated)
  | "task_created";
```

- [x] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no usages yet; union widening is safe).

- [x] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/event/event.ts
git commit -m "feat(governance): add decision_blocked + decision_chosen event types (v2 slice1)"
```

---

## Task 2: Token module (pure) — mint / parse / classify

**Files:**

- Create: `src/escalate/token.ts`
- Test: `test/escalate/token.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/escalate/token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mintToken, parseToken, isGovernanceReply } from "../../src/escalate/token.js";

describe("governance option token", () => {
  it("round-trips a well-formed token", () => {
    const t = mintToken("evt_b", "evt_d", "opt1");
    expect(t).toBe("BOULE:evt_b:evt_d:opt1");
    expect(parseToken(t)).toEqual({
      blockedEventId: "evt_b",
      decisionId: "evt_d",
      optionToken: "opt1",
    });
  });

  it("parses with surrounding whitespace", () => {
    expect(parseToken("  BOULE:evt_b:evt_d:opt0  ")).toEqual({
      blockedEventId: "evt_b",
      decisionId: "evt_d",
      optionToken: "opt0",
    });
  });

  it("rejects non-token and malformed BOULE strings (exact-shape only)", () => {
    expect(parseToken("sqlite")).toBeNull(); // normal steer
    expect(parseToken("BOULE:")).toBeNull(); // malformed
    expect(parseToken("BOULE:a:b")).toBeNull(); // too few fields
    expect(parseToken("BOULE:a:b:c:d")).toBeNull(); // too many fields
    expect(parseToken("BOULE:a::c")).toBeNull(); // empty field
    expect(parseToken("NOTBOULE:a:b:c")).toBeNull(); // wrong prefix
  });

  it("classifies BOULE-prefixed messages (even malformed) as governance replies", () => {
    expect(isGovernanceReply("BOULE:a:b:c")).toBe(true);
    expect(isGovernanceReply("BOULE:")).toBe(true); // prefixed but malformed → consume, don't forward
    expect(isGovernanceReply("sqlite")).toBe(false); // normal steer → fall through
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test -- token`
Expected: FAIL — `Cannot find module ".../src/escalate/token.ts"`.

- [x] **Step 3: Write the implementation**

Create `src/escalate/token.ts`:

```ts
/** Opaque, single-use, fully-bound governance option token.
 *  Format: BOULE:<blockedEventId>:<decisionId>:<optionToken>
 *  Matched by EXACT equality only — never substring/keyword. The WORKLOG inbound-routing
 *  bug-class is precisely substring routing; do not reintroduce it. */
const PREFIX = "BOULE";
const SEP = ":";

export interface ParsedToken {
  blockedEventId: string;
  decisionId: string;
  optionToken: string;
}

export function mintToken(blockedEventId: string, decisionId: string, optionToken: string): string {
  return [PREFIX, blockedEventId, decisionId, optionToken].join(SEP);
}

/** Parse a candidate reply. Returns null unless it is a well-formed token: exactly four
 *  colon-separated fields, correct prefix, no empty field. A BOULE-prefixed-but-malformed
 *  string also returns null — the caller consumes/rejects it, never forwards it to the pane.
 *  (Event ids are `evt_*` and contain no colon, so a 4-field split is unambiguous.) */
export function parseToken(text: string): ParsedToken | null {
  const parts = text.trim().split(SEP);
  if (parts.length !== 4) return null;
  const [prefix, blockedEventId, decisionId, optionToken] = parts;
  if (prefix !== PREFIX) return null;
  if (!blockedEventId || !decisionId || !optionToken) return null;
  return { blockedEventId, decisionId, optionToken };
}

/** True iff `text` looks like a governance reply (BOULE-prefixed), even if malformed.
 *  The inbound interceptor uses this to choose "consume/reject" vs "fall through to a
 *  normal pane steer". */
export function isGovernanceReply(text: string): boolean {
  return text.trim().startsWith(PREFIX + SEP);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test -- token`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/escalate/token.ts governance/test/escalate/token.test.ts
git commit -m "feat(governance): opaque exact-match option token for v2 escalation (slice1)"
```

---

## Task 3: deriveDecisionState — terminal `chosen` phase

**Files:**

- Modify: `src/decision/decision.ts`
- Test: `test/decision/decision.test.ts`

- [x] **Step 1: Write the failing test**

Append to `test/decision/decision.test.ts` (reuse the file's existing `GovEvent` builders/imports; if it has a local `mk`/`evt` helper, use it — otherwise inline the literals as below):

```ts
import { describe, it, expect } from "vitest";
import { deriveDecisionState } from "../../src/decision/decision.js";
import type { GovEvent } from "../../src/event/event.js";

function ev(
  id: string,
  type: GovEvent["frontmatter"]["type"],
  related: string[],
  tags: string[] = [],
): GovEvent {
  return {
    frontmatter: { id, type, source: "hermes", actor: "user", tags, related_to: related },
    body: id,
  };
}

describe("deriveDecisionState — Type 0 chosen", () => {
  const proposal: GovEvent = {
    frontmatter: {
      id: "evt_d",
      type: "decision_proposed",
      source: "hermes",
      actor: "user",
      tags: ["decision", "type0"],
    },
    body: "DB: sqlite or postgres?",
  };

  it("a Type 0 with no resolution is phase=proposed (pending)", () => {
    const s = deriveDecisionState(proposal, [ev("evt_b", "decision_blocked", ["evt_d"])]);
    expect(s.phase).toBe("proposed");
    expect(s.verdict).toBeNull();
  });

  it("a decision_chosen resolves it to terminal chosen + surfaces the option", () => {
    const s = deriveDecisionState(proposal, [
      ev("evt_b", "decision_blocked", ["evt_d"]),
      ev("evt_c", "decision_chosen", ["evt_d", "evt_b"], ["decision", "option:opt1"]),
    ]);
    expect(s.phase).toBe("chosen");
    expect(s.verdict).toBe("chosen");
    expect(s.chosenOption).toBe("opt1");
  });

  it("rejected/approved still take precedence over chosen", () => {
    const s = deriveDecisionState(proposal, [
      ev("evt_c", "decision_chosen", ["evt_d"], ["option:opt0"]),
      ev("evt_r", "decision_rejected", ["evt_d"]),
    ]);
    expect(s.verdict).toBe("rejected");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test -- decision`
Expected: FAIL — `s.phase` is `"proposed"` not `"chosen"` (and `chosenOption` undefined) for the chosen case.

- [x] **Step 3: Write the implementation**

In `src/decision/decision.ts`:

(a) Widen the types:

```ts
export type DecisionPhase = "proposed" | "reviewed" | "approved" | "rejected" | "chosen";

export interface DecisionState {
  decisionId: string;
  title: string;
  phase: DecisionPhase;
  reviewCount: number;
  reviewed: boolean;
  verdict: "approved" | "rejected" | "chosen" | null;
  chosenOption?: string;
}
```

(b) Add a helper near `reviewAuthorModel`:

```ts
/** The option token a decision_chosen recorded (tag `option:<token>`), or null. */
function chosenOptionOf(e: GovEvent): string | null {
  const tags = e.frontmatter.tags;
  if (!Array.isArray(tags)) return null;
  const tag = tags.find((t) => t.startsWith("option:"));
  return tag ? tag.slice("option:".length) : null;
}
```

(c) In `deriveDecisionState`, after the `approved` line, detect chosen and extend the branch ladder:

```ts
const rejected = related.some((e) => e.frontmatter.type === "decision_rejected");
const approved = related.some((e) => e.frontmatter.type === "decision_approved");
const chosenEvt = related.find((e) => e.frontmatter.type === "decision_chosen");

let phase: DecisionPhase;
let verdict: DecisionState["verdict"];
let chosenOption: string | undefined;
if (rejected) {
  phase = "rejected";
  verdict = "rejected";
} else if (approved) {
  phase = "approved";
  verdict = "approved";
} else if (chosenEvt) {
  phase = "chosen";
  verdict = "chosen";
  chosenOption = chosenOptionOf(chosenEvt) ?? undefined;
} else if (reviewCount >= quorum) {
  phase = "reviewed";
  verdict = null;
} else {
  phase = "proposed";
  verdict = null;
}
return {
  decisionId,
  title,
  phase,
  reviewCount,
  reviewed: reviewCount >= quorum,
  verdict,
  chosenOption,
};
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- decision`
Expected: PASS (existing decision tests + the 3 new ones). The widened verdict union is backward-compatible.

- [x] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/decision/decision.ts governance/test/decision/decision.test.ts
git commit -m "feat(governance): deriveDecisionState terminal chosen state for Type 0 (slice1)"
```

---

## Task 4: chooseOption handler — human-gated, idempotent

**Files:**

- Modify: `src/decision/handlers.ts`
- Test: `test/mcp/handlers.test.ts` (or a new `test/decision/choose.test.ts` — keep it next to the other handler tests)

- [x] **Step 1: Write the failing test**

Create `test/decision/choose.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption } from "../../src/decision/handlers.js";
import { why } from "../../src/decision/handlers.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-choose-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("chooseOption — Type 0 human resolution", () => {
  it("resolves a Type 0 to chosen and lands an actor:user decision_chosen", async () => {
    const esc = await escalate(
      ws,
      {
        question: "DB: sqlite or postgres?",
        options: [{ label: "sqlite" }, { label: "postgres" }],
      },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    const r = await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      new Date("2026-06-01T10:05:00Z"),
      0.5,
    );
    expect(r.ok).toBe(true);
    expect(r.chosenOption).toBe("opt0");

    const trail = await why(ws, { decisionId: esc.decisionId });
    expect(trail.phase).toBe("chosen");
    const types = trail.chain.map((c) => c.type);
    expect(types).toContain("decision_blocked");
    expect(types).toContain("decision_chosen");
    const chosen = trail.chain.find((c) => c.type === "decision_chosen");
    expect(chosen?.actor).toBe("user");
  });

  it("double-tap is an idempotent friendly no-op (no second decision_chosen)", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    const first = await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      new Date("2026-06-01T10:05:00Z"),
      0.5,
    );
    expect(first.ok).toBe(true);
    const second = await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt1" },
      new Date("2026-06-01T10:06:00Z"),
      0.5,
    );
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already chosen/);
    const trail = await why(ws, { decisionId: esc.decisionId });
    expect(trail.chain.filter((c) => c.type === "decision_chosen")).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test -- choose`
Expected: FAIL — `escalate` and `chooseOption` are not exported yet (`escalate` lands in Task 5; this test will fully pass only after Task 5 — that is expected for subagent-driven order. If running strictly task-by-task, stub-import will fail at module resolution).

> Note for the implementer: Task 4 and Task 5 are co-dependent (the test exercises both). Implement Task 4's `chooseOption` now; the test goes green at the end of Task 5. Verify Task 4 in isolation with the unit assertion in Step 4 if you want an intermediate green.

- [x] **Step 3: Write the implementation**

In `src/decision/handlers.ts`, add after `reject()` (it reuses the file's existing `loadState`, `generateId`, `writeEvent`, `GovEvent`):

```ts
export interface ChooseInput {
  decisionId: string;
  blockedEventId: string;
  optionToken: string;
}
export interface ChooseResult {
  ok: boolean;
  reason: string;
  eventId?: string;
  chosenOption?: string;
}

/** /choose — human-gated Type 0 resolution. Deliberately NOT review-gated: a tapped option
 *  is a human direction-pick, not a Type-1 ADR approval (canApprove is for the latter).
 *  Pins actor:"user". Idempotent: a redelivered tap on an already-terminal decision is a
 *  friendly no-op (no second decision_chosen), which protects against Telegram redelivery. */
export async function chooseOption(
  workspaceDir: string,
  input: ChooseInput,
  now: Date,
  rand: number,
): Promise<ChooseResult> {
  const { state } = await loadState(workspaceDir, input.decisionId);
  if (state.verdict) return { ok: false, reason: `decision already ${state.verdict}` };
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_chosen",
      source: "hermes",
      actor: "user",
      tags: ["decision", "type0", `option:${input.optionToken}`],
      related_to: [input.decisionId, input.blockedEventId],
    },
    body: `Human chose ${input.optionToken} for ${input.decisionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return {
    ok: true,
    reason: "chosen",
    eventId: evt.frontmatter.id,
    chosenOption: input.optionToken,
  };
}
```

- [x] **Step 4: Run tests (after Task 5 lands escalate)**

Run: `pnpm test -- choose`
Expected: PASS (2 tests). If running before Task 5, instead assert chooseOption against a hand-written proposal+blocked pair, or proceed to Task 5 and run then.

- [x] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/decision/handlers.ts governance/test/decision/choose.test.ts
git commit -m "feat(governance): chooseOption — human-gated idempotent Type 0 resolution (slice1)"
```

---

## Task 5: escalate orchestrator

**Files:**

- Create: `src/escalate/escalate.ts`
- Test: `test/escalate/escalate.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/escalate/escalate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate } from "../../src/escalate/escalate.js";
import { readAllEvents, eventsForDecision } from "../../src/decision/readEvents.js";
import { parseToken } from "../../src/escalate/token.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-esc-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("escalate — Type 0 emission", () => {
  it("mints a decision_proposed + decision_blocked and binds tokens to both ids", async () => {
    const r = await escalate(
      ws,
      {
        question: "DB: sqlite or postgres?",
        options: [{ label: "sqlite" }, { label: "postgres" }],
        ambiguityKind: "architecture",
      },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    expect(r.decisionId).toMatch(/^evt_/);
    expect(r.blockedEventId).toMatch(/^evt_/);
    expect(r.decisionId).not.toBe(r.blockedEventId);
    expect(r.options).toHaveLength(2);

    // each option's reply is a token bound to BOTH ids
    for (const o of r.options) {
      const parsed = parseToken(o.reply);
      expect(parsed).not.toBeNull();
      expect(parsed!.decisionId).toBe(r.decisionId);
      expect(parsed!.blockedEventId).toBe(r.blockedEventId);
    }
    expect(r.options.map((o) => o.token)).toEqual(["opt0", "opt1"]);

    // events actually landed, blocked is related_to the proposal
    const grp = eventsForDecision(await readAllEvents(ws), r.decisionId);
    expect(grp.proposal?.frontmatter.type).toBe("decision_proposed");
    expect(grp.proposal?.frontmatter.tags).toContain("type0");
    const blocked = grp.related.find((e) => e.frontmatter.type === "decision_blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.frontmatter.related_to).toContain(r.decisionId);
    expect(blocked!.frontmatter.tags).toContain("ambiguity:architecture");
    // body carries the rendered options for the bridge
    const body = JSON.parse(blocked!.body);
    expect(body.options.map((x: { token: string }) => x.token)).toEqual(["opt0", "opt1"]);
  });

  it("rejects fewer than two options", async () => {
    await expect(
      escalate(
        ws,
        { question: "q?", options: [{ label: "only" }] },
        new Date("2026-06-01T10:00:00Z"),
        0.5,
      ),
    ).rejects.toThrow(/two options/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test -- escalate`
Expected: FAIL — `Cannot find module ".../src/escalate/escalate.ts"`.

- [x] **Step 3: Write the implementation**

Create `src/escalate/escalate.ts`:

```ts
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { mintToken } from "./token.ts";

export type AmbiguityKind =
  | "scope"
  | "architecture"
  | "irreversible-design"
  | "security"
  | "product-behavior"
  | "dependency"
  | "data-loss"
  | "cost"
  | "schedule"
  | "unknown";
export type BlockedOn = "human" | "external-review" | "repo-state" | "credential" | "policy";
export type MinimumGate = "none" | "human" | "external-review" | "type1-guardian";

export interface EscalateOption {
  label: string;
}
export interface EscalateInput {
  question: string;
  options: EscalateOption[];
  ambiguityKind?: AmbiguityKind;
  blockedOn?: BlockedOn;
  minimumRequiredGate?: MinimumGate;
  agentRecommendation?: string;
  /** The cmux session id when a running session escalates; defaults to "user" for a manual escalate. */
  actor?: string;
}

export interface EscalateOptionOut {
  token: string;
  label: string;
  reply: string;
}
export interface EscalateResult {
  decisionId: string; // evt_* id of the Type 0 decision_proposed
  blockedEventId: string; // evt_* id of the decision_blocked event
  options: EscalateOptionOut[];
}

/** /escalate — emit a Type 0 escalation: a decision_proposed (phase=proposed, verdict=null IS
 *  Type 0 "pending") + a decision_blocked carrying the discrete options. Returns the structured
 *  payload (a-prime: the bridge acts on the return; no daemon). Append-only; mints NO verdict. */
export async function escalate(
  workspaceDir: string,
  input: EscalateInput,
  now: Date,
  rand: number,
): Promise<EscalateResult> {
  if (input.options.length < 2) throw new Error("escalate requires at least two options");
  const actor = input.actor ?? "user";
  const source = actor === "user" ? "hermes" : "agent_run";

  // 1) Type 0 decision_proposed — proposed + verdict:null is exactly "Type 0 / pending".
  const proposal: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_proposed",
      source,
      actor,
      tags: ["decision", "type0"],
    },
    body: input.question,
  };
  await writeEvent(workspaceDir, proposal, now);
  const decisionId = proposal.frontmatter.id;

  // 2) decision_blocked — distinct id (offset stamp avoids same-second collision), one
  //    fully-bound token per option. Token binds the reply to BOTH event ids.
  const blockedNow = new Date(now.getTime() + 1000);
  const blockedId = generateId("evt", blockedNow, rand);
  const options: EscalateOptionOut[] = input.options.map((o, i) => {
    const optionToken = `opt${i}`;
    return {
      token: optionToken,
      label: o.label,
      reply: mintToken(blockedId, decisionId, optionToken),
    };
  });
  const blocked: GovEvent = {
    frontmatter: {
      id: blockedId,
      type: "decision_blocked",
      source,
      actor,
      related_to: [decisionId],
      tags: [
        "escalation",
        `ambiguity:${input.ambiguityKind ?? "unknown"}`,
        `blocked_on:${input.blockedOn ?? "human"}`,
        `min_gate:${input.minimumRequiredGate ?? "human"}`,
      ],
    },
    body: JSON.stringify(
      {
        question: input.question,
        options: options.map((o) => ({ token: o.token, label: o.label, reply: o.reply })),
        agent_recommendation: input.agentRecommendation ?? null,
      },
      null,
      2,
    ),
  };
  await writeEvent(workspaceDir, blocked, blockedNow);

  return { decisionId, blockedEventId: blockedId, options };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- escalate choose`
Expected: PASS (escalate: 2; choose: 2 — Task 4's test goes green now that escalate exists).

- [x] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/escalate/escalate.ts governance/test/escalate/escalate.test.ts
git commit -m "feat(governance): escalate orchestrator — Type 0 decision_blocked + bound tokens (slice1)"
```

---

## Task 6: MCP registration + headless round-trip + full verify

**Files:**

- Modify: `src/mcp/server.ts`

- [x] **Step 1: Register the two tools**

In `src/mcp/server.ts`, add imports near the other handler imports:

```ts
import { escalate } from "../escalate/escalate.ts";
import { chooseOption } from "../decision/handlers.ts";
```

Register the two tools alongside the existing `registerTool` calls, using the file's verified identifiers: the workspace const is `WORKSPACE`, `z` is imported from zod, and the clock/rng are `nowFn()` (`() => new Date()`) and `randFn()` (`() => Math.random()`). The config object is `{ description, inputSchema }` (the existing tools do NOT pass a `title`). **Capability split (rail):** `escalate` is agent-visible; `choose` is bridge/human-only — note it in the comment.

```ts
// v2 slice1 — escalation round-trip. AGENT-VISIBLE: a running session may escalate a fork.
server.registerTool(
  "escalate",
  {
    description:
      "Type 0 에스컬레이션 방출 (decision_proposed + decision_blocked) — append-only, verdict 없음",
    inputSchema: {
      question: z.string(),
      options: z.array(z.object({ label: z.string() })).min(2),
      ambiguity_kind: z.string().optional(),
    },
  },
  async ({ question, options, ambiguity_kind }) => {
    const r = await escalate(
      WORKSPACE,
      { question, options, ambiguityKind: ambiguity_kind as never },
      nowFn(),
      randFn(),
    );
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

// v2 slice1 — BRIDGE/HUMAN-ONLY: only the Telegram bridge calls this, on an exact token match.
// Human-gated (actor:user) but NOT review-gated — a Type 0 tap is a direction-pick, not an ADR approval.
server.registerTool(
  "choose",
  {
    description: "Type 0 해소 — 사람이 고른 옵션을 decision_chosen(actor:user)으로 기록",
    inputSchema: {
      decision_id: z.string(),
      blocked_event_id: z.string(),
      option_token: z.string(),
    },
  },
  async ({ decision_id, blocked_event_id, option_token }) => {
    const r = await chooseOption(
      WORKSPACE,
      { decisionId: decision_id, blockedEventId: blocked_event_id, optionToken: option_token },
      nowFn(),
      randFn(),
    );
    return {
      content: [
        {
          type: "text",
          text: r.ok ? `chosen: ${r.chosenOption} for ${decision_id}` : `NO-OP: ${r.reason}`,
        },
      ],
    };
  },
);
```

- [x] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [x] **Step 3: Full headless suite**

Run: `pnpm test`
Expected: PASS — prior 137 + the new escalate/choose/token/decision tests (target ≈ 145+).

- [x] **Step 4: Headless MCP round-trip (manual proof of the TS half)**

Drive the real stdio server with a temporary `.mjs` driver inside `governance/` (the established pattern — /tmp fails node_modules resolution; delete the driver after). The driver should, against the MCP SDK client: `tools/list` (assert `escalate` + `choose` present) → call `escalate` (assert it returns `decisionId`/`blockedEventId`/two bound tokens) → parse one option's `reply` token → call `choose` with its fields → call `why <decisionId>` (assert `phase: "chosen"` and a `decision_chosen` actor:user in the chain). Capture the transcript, then `rm` the driver. Record the observed output in the done-line. If the round-trip cannot be driven, say so explicitly ("could not run") — do not claim it passed.

- [x] **Step 5: Confirm no drift outside governance/**

Run:

```bash
git -C /Users/davidpark/private_project/work-radar status --short
git -C /Users/davidpark/private_project/work-radar diff --stat HEAD~6 -- ':(exclude)governance' ':(exclude)docs'
```

Expected: changes confined to `governance/**` + `docs/**`. No `src/`, `src-tauri/`, `bindings.ts`, or migration changes (INVARIANT #4 — bindings drift 0; the MCP is stdio, not Tauri IPC).

- [x] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/mcp/server.ts
git commit -m "feat(governance): register escalate + choose MCP tools (v2 slice1)"
```

---

## Done criteria (1A)

- [x] `decision_blocked` + `decision_chosen` in `EventType`; `escalate` + `choose` MCP tools registered.
- [x] `escalate(question, options[])` mints a Type 0 `decision_proposed` + `decision_blocked` with one fully-bound (`BOULE:<blocked>:<decision>:<opt>`) exact-match token per option.
- [x] `choose` lands a human-gated (`actor:"user"`), NOT review-gated `decision_chosen`; `deriveDecisionState` → terminal `chosen`; redelivered tap is an idempotent no-op.
- [x] `pnpm test` green (≈145+), `pnpm exec tsc --noEmit` clean, headless MCP round-trip observed (escalate → choose → `why` chain), bindings drift 0, no app/Rust/migration changes.
- [x] Independent **critic (opus, separate pass)** ACCEPT — explicitly checks: Python/agent has no write-path to a verdict (only `choose` writes `decision_chosen`, pinned actor:user); token is exact-match only; no auto-default/unbounded loop; double-tap idempotent.
- [x] Commit only — **do NOT push** (Boule parked). `docs/decisions.md` done-line breadcrumb.

## Deferred to Slice 1B (separate plan — touches the LIVE ~/.hermes fabric)

- Outbound bounded `sync-once` adapter (Python) → existing `cmux_notify_telegram.py` sink.
- Inbound interceptor prepended at `~/.hermes/.../platforms/telegram.py:~4968` ahead of `try_forward` → `try_governance_reply` invokes MCP `choose` on exact token match.
- The one characterization test (valid token resolves / normal reply forwards / malformed BOULE not forwarded).
- Live phone round-trip smoke.
- ⚠️ Requires explicit user awareness — modifies the user's daily-driver Telegram/cmux fabric.

## Known nit (deferred polish)

`conflicts()` lists a Type 0 (phase `proposed`, no review) as if it "needs review" — its gate label is review-oriented. Harmless for 1A (the proof path is escalate → choose → why). Refine `gateLabel`/`conflicts` to distinguish Type 0 "needs human choice" from Type 1 "needs review" in a later slice.
