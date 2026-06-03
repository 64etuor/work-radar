# Boule v3 Phase G — Context Steward / Handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the handoff continuity axis (events + fold + structural validation + projector + MCP) plus a pure Context Steward (`computeContextPressure`) and a pure hydration-bundle assembler under a thin IO shell, so a long task can `checkpoint → handoff → hydrate` into a fresh session.

**Architecture:** Event-sourced, pure-core-under-IO-shell, mirroring Phases A/D/E/F. A new `src/handoff/` axis (own `handoff_*` events, `deriveHandoffState` fold, guards, handlers, projector) and a new `src/steward/` module (pure `computeContextPressure`, pure `assembleBundle`, thin `hydrate` IO shell). The Steward is **advisory** (emits nothing); only `hydrate` writes (one `handoff_consumed`). No DB tables, no `bindings.ts`, no migration, no app/Rust change.

**Tech Stack:** Node 24+ strip-types TS (source imports `.ts`, tests import `.js`), vitest, zod (MCP input), `@modelcontextprotocol/sdk`. Governance sidecar under `governance/` — NOT the Rust app.

**Design:** `governance/docs/design/2026-06-03-boule-v3-phase-g-context-steward-handoff-design.md` (committed `f4ec295`).

**Constraints (user-stated, this slice):** decision_* write-path 0 · no push/merge/delete · `src/bindings.ts` + app SQLite/migrations byte-unchanged · leave gates + separate-critic evidence · bounded implementation only within this accepted plan.

---

## Conventions (read once)

- **Gate base** = `f4ec295` (the design commit; the last commit before any Phase G code). All drift gates diff `f4ec295..HEAD`.
- **Commit** in governance with `git commit --no-verify` (root husky targets the app; this worktree lacks root deps). End every commit message with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Run all gates from** `governance/`: `pnpm exec tsc --noEmit` and `pnpm exec vitest run`.
- **Time in tests:** `const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));` (mirrors existing tests). `rand` is a fixed number per event.
- **NEVER** run `Date.now()`/`Math.random()` in source — non-determinism is injected at the MCP boundary only (`nowFn`/`randFn`).
- Do **not** Prettier governance files (no prettier dep here; aligned-comment local style → churn).

## File Structure (locked decomposition)

| File | Responsibility |
| --- | --- |
| `src/event/event.ts` (modify) | add 5 `handoff_*` to `EventType` union |
| `src/handoff/handoff.ts` (create) | `HandoffPhase`, `HandoffState`, pure `deriveHandoffState`, `handoffsOf` |
| `src/handoff/validate.ts` (create) | `REQUIRED_SECTIONS`, pure `validateHandoff(body)` |
| `src/handoff/guards.ts` (create) | `canDraft`, `canValidate`, `canConsume` phase guards |
| `src/handoff/handlers.ts` (create) | `requestHandoff`, `draftHandoff`, `runValidateHandoff`, `consumeHandoff`, `listHandoffs`, `handoffTrail` |
| `src/handoff/project.ts` (create) | pure `projectHandoffs` + `renderHandoffs` → `state/handoffs.json` |
| `src/steward/pressure.ts` (create) | pure `computeContextPressure(runtimeSignals, log, now)` |
| `src/steward/hydrate.ts` (create) | `HydrationBundle` type + pure `assembleBundle(inputs)` (+ markdown render) |
| `src/steward/hydrateIo.ts` (create) | thin `hydrate(workspaceDir, input, deps, now, rand)` IO shell |
| `src/mcp/server.ts` (modify) | register 6 commands; wire git summary + `graphStore.getNeighbors` |
| `test/handoff/*.test.ts`, `test/steward/*.test.ts` (create) | per-task tests |

---

## Task 1: Handoff event types

**Files:**
- Modify: `src/event/event.ts:46-48` (insert before the final `orchestrator_suggestion_created` member — keep that the last union member's trailing `;`)
- Test: `test/handoff/event-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/handoff/event-types.test.ts
import { describe, it, expect } from "vitest";
import { serializeEvent, parseEvent, type GovEvent } from "../../src/event/event.js";

describe("handoff event types", () => {
  it("round-trips a handoff_requested event", () => {
    const evt: GovEvent = {
      frontmatter: {
        id: "evt_20260603_130000_0001",
        type: "handoff_requested",
        source: "system",
        actor: "system",
        tags: ["handoff"],
        related_to: ["evt_session_001"],
      },
      body: "Handoff requested",
    };
    const round = parseEvent(serializeEvent(evt));
    expect(round.frontmatter.type).toBe("handoff_requested");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc --noEmit`
Expected: FAIL — `Type '"handoff_requested"' is not assignable to type 'EventType'`.

- [ ] **Step 3: Add the 5 event types**

In `src/event/event.ts`, change the tail of the `EventType` union (currently ending at `orchestrator_suggestion_created";`) to insert the handoff members **before** it:

```ts
  // v3 Phase G: Handoff continuity axis. verdict-free (source: system|hermes|agent_run). A
  // handoff's id = its birth event id (handoff_requested). consume is the ONLY new write beyond
  // the lifecycle records; the Context Steward itself emits nothing (advisory).
  | "handoff_requested"   // born `requested` (a handoff is opened for a session)
  | "handoff_drafted"     // a draft markdown body submitted → `validating`
  | "handoff_validated"   // structural check passed → `pending`
  | "handoff_invalid"     // structural check failed (carries missing[]) → `invalid` (re-draft)
  | "handoff_consumed"    // a fresh session hydrated from the bundle (terminal)
  // v3 Phase E: Orchestrator emits an advisory suggestion. suggestion-class — source/actor=system,
  // NO verdict. The ONLY new write permission in Phase E (master §4.1); dispatch events → Phase I.
  | "orchestrator_suggestion_created";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run test/handoff/event-types.test.ts`
Expected: tsc 0 errors; test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/event/event.ts test/handoff/event-types.test.ts
git commit --no-verify -m "feat(governance): Phase G — handoff_* event types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `deriveHandoffState` fold + `handoffsOf`

**Files:**
- Create: `src/handoff/handoff.ts`
- Test: `test/handoff/handoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/handoff/handoff.test.ts
import { describe, it, expect } from "vitest";
import { deriveHandoffState, handoffsOf, type HandoffPhase } from "../../src/handoff/handoff.js";
import type { GovEvent } from "../../src/event/event.js";

const ev = (id: string, type: GovEvent["frontmatter"]["type"], related?: string[]): GovEvent => ({
  frontmatter: { id, type, source: "system", actor: "system", tags: ["handoff"], related_to: related },
  body: "",
});
const birth = ev("evt_h1", "handoff_requested", ["evt_session_1"]);

describe("deriveHandoffState", () => {
  it("births at `requested`", () => {
    expect(deriveHandoffState(birth, []).phase).toBe<HandoffPhase>("requested");
    expect(deriveHandoffState(birth, []).sessionId).toBe("evt_session_1");
  });
  it("drafted → validating → pending → consumed (terminal wins)", () => {
    const related = [
      ev("evt_h1_a", "handoff_drafted", ["evt_h1"]),
      ev("evt_h1_b", "handoff_validated", ["evt_h1"]),
      ev("evt_h1_c", "handoff_consumed", ["evt_h1"]),
    ];
    const s = deriveHandoffState(birth, related);
    expect(s.phase).toBe<HandoffPhase>("consumed");
    expect(s.verdict).toBe("consumed");
  });
  it("invalid sends it back to `invalid`; latest substate by id wins", () => {
    const related = [
      ev("evt_h1_a", "handoff_drafted", ["evt_h1"]),
      ev("evt_h1_b", "handoff_invalid", ["evt_h1"]),
    ];
    expect(deriveHandoffState(birth, related).phase).toBe<HandoffPhase>("invalid");
  });
  it("ignores foreign event types (fail-closed)", () => {
    const related = [ev("evt_x", "task_completed", ["evt_h1"])];
    expect(deriveHandoffState(birth, related).phase).toBe<HandoffPhase>("requested");
  });
  it("handoffsOf returns births sorted, excludes re-reference", () => {
    const all = [birth, ev("evt_h0", "handoff_requested", ["evt_session_0"]), ev("evt_h1_a", "handoff_drafted", ["evt_h1"])];
    expect(handoffsOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_h0", "evt_h1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/handoff/handoff.test.ts`
Expected: FAIL — cannot find module `../../src/handoff/handoff.js`.

- [ ] **Step 3: Implement `src/handoff/handoff.ts`**

```ts
import type { GovEvent } from "../event/event.ts";

export type HandoffPhase = "requested" | "validating" | "pending" | "invalid" | "consumed";

export interface HandoffState {
  handoffId: string;
  sessionId: string | null; // the session being handed off FROM (birth related_to[0])
  phase: HandoffPhase;
  verdict: "consumed" | null; // terminal marker (mirrors SessionState.verdict)
}

/** Advancing active-substate transitions, mapped to their resulting phase. LATEST by id wins. */
const SUBSTATE: Record<string, HandoffPhase> = {
  handoff_drafted: "validating",
  handoff_validated: "pending",
  handoff_invalid: "invalid",
};

/** Pure fold: a birth (handoff_requested) + its related lifecycle events → HandoffState.
 *  Precedence (clone of deriveSessionState): terminal `consumed` wins; else the latest advancing
 *  substate transition by id; else the birth phase `requested`. Fail-closed on foreign types.
 *  ORDERING CONTRACT (Boule): ids are display/tiebreak-only; same-second transitions on one
 *  handoff stream do not occur in practice, so the id tiebreak is a benign display nicety. */
export function deriveHandoffState(birth: GovEvent, related: GovEvent[]): HandoffState {
  const handoffId = birth.frontmatter.id;
  const sessionId = (birth.frontmatter.related_to ?? [])[0] ?? null;

  const consumed = related.some((e) => e.frontmatter.type === "handoff_consumed");
  if (consumed) return { handoffId, sessionId, phase: "consumed", verdict: "consumed" };

  let latest: GovEvent | null = null;
  let latestPhase: HandoffPhase | null = null;
  for (const e of related) {
    const p = SUBSTATE[e.frontmatter.type];
    if (!p) continue;
    if (!latest || e.frontmatter.id.localeCompare(latest.frontmatter.id) > 0) {
      latest = e;
      latestPhase = p;
    }
  }
  return { handoffId, sessionId, phase: latestPhase ?? "requested", verdict: null };
}

/** All handoff birth events (chronological by id). A handoff_requested referencing an existing
 *  handoff birth is excluded (defensive double-count guard, clone of sessionsOf). */
export function handoffsOf(all: GovEvent[]): GovEvent[] {
  const birthIds = new Set(
    all.filter((e) => e.frontmatter.type === "handoff_requested").map((e) => e.frontmatter.id),
  );
  return all
    .filter((e) => e.frontmatter.type === "handoff_requested")
    .filter((e) => !(e.frontmatter.related_to ?? []).some((r) => birthIds.has(r)))
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/handoff/handoff.test.ts && pnpm exec tsc --noEmit`
Expected: test PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/handoff/handoff.ts test/handoff/handoff.test.ts
git commit --no-verify -m "feat(governance): Phase G — deriveHandoffState fold + handoffsOf

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `validateHandoff` (structural 7-section check)

**Files:**
- Create: `src/handoff/validate.ts`
- Test: `test/handoff/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/handoff/validate.test.ts
import { describe, it, expect } from "vitest";
import { validateHandoff, REQUIRED_SECTIONS } from "../../src/handoff/validate.js";

const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nsome content for ${h}.`).join("\n\n");

describe("validateHandoff", () => {
  it("accepts a body with all 7 non-empty sections", () => {
    expect(validateHandoff(complete)).toEqual({ ok: true, missing: [] });
  });
  it("reports a missing section", () => {
    const body = REQUIRED_SECTIONS.slice(0, 6).map((h) => `## ${h}\nx`).join("\n\n");
    const r = validateHandoff(body);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("Open questions");
  });
  it("treats a present-but-empty section as missing", () => {
    const body = REQUIRED_SECTIONS.map((h, i) => `## ${h}\n${i === 0 ? "" : "x"}`).join("\n\n");
    const r = validateHandoff(body);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("Mission");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/handoff/validate.test.ts`
Expected: FAIL — cannot find module `../../src/handoff/validate.js`.

- [ ] **Step 3: Implement `src/handoff/validate.ts`**

```ts
/** The 7 required handoff sections (master design §8). A handoff missing any of these — or with
 *  any of them empty — is structurally invalid. Matching is case-insensitive on a markdown heading
 *  line (#/##/### …) whose text starts with the section name; the section's content is the text up
 *  to the next heading. PURE: no I/O. */
export const REQUIRED_SECTIONS = [
  "Mission",
  "Completed",
  "Current failing point",
  "Important implicit knowledge",
  "Next exact steps",
  "Do not do",
  "Open questions",
] as const;

export interface ValidationResult {
  ok: boolean;
  missing: string[]; // section names absent OR present-but-empty
}

interface Section {
  name: string;
  content: string;
}

/** Split a markdown body into heading→content sections. A heading line is `#{1,6} <text>`. */
function sections(body: string): Section[] {
  const lines = body.split("\n");
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1], content: "" };
    } else if (cur) {
      cur.content += line + "\n";
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function validateHandoff(body: string): ValidationResult {
  const found = sections(body);
  const missing: string[] = [];
  for (const required of REQUIRED_SECTIONS) {
    const match = found.find((s) => s.name.toLowerCase().startsWith(required.toLowerCase()));
    if (!match || match.content.trim().length === 0) missing.push(required);
  }
  return { ok: missing.length === 0, missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/handoff/validate.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/handoff/validate.ts test/handoff/validate.test.ts
git commit --no-verify -m "feat(governance): Phase G — validateHandoff 7-section structural check

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Guards + handlers (request / draft / validate / consume / list / trail)

**Files:**
- Create: `src/handoff/guards.ts`
- Create: `src/handoff/handlers.ts`
- Test: `test/handoff/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/handoff/handlers.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestHandoff, draftHandoff, runValidateHandoff, consumeHandoff, listHandoffs, handoffTrail,
} from "../../src/handoff/handlers.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\ncontent ${h}`).join("\n\n");

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-handoff-h-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("handoff handlers round-trip", () => {
  it("request → draft(incomplete) → invalid → draft(complete) → pending → consumed", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_session_1" }, at(0), 0.1);

    const bad = await runValidateHandoff(dir, { handoffId }, at(1), 0.2);
    expect(bad.ok).toBe(false); // no draft yet → cannot validate

    await draftHandoff(dir, { handoffId, body: "## Mission\nonly one" }, at(2), 0.3);
    const inv = await runValidateHandoff(dir, { handoffId }, at(3), 0.4);
    expect(inv.ok).toBe(true);
    expect(inv.valid).toBe(false); // structurally invalid → handoff_invalid emitted

    await draftHandoff(dir, { handoffId, body: complete }, at(4), 0.5);
    const ok = await runValidateHandoff(dir, { handoffId }, at(5), 0.6);
    expect(ok.valid).toBe(true); // handoff_validated → pending

    const open = await listHandoffs(dir);
    expect(open.find((h) => h.handoffId === handoffId)?.phase).toBe("pending");

    const con = await consumeHandoff(dir, { handoffId }, at(6), 0.7);
    expect(con.ok).toBe(true);

    const trail = await handoffTrail(dir, { handoffId });
    expect(trail.phase).toBe("consumed");

    // Only handoff_* events were ever written.
    const all = await readAllEvents(dir);
    expect(all.every((e) => e.frontmatter.type.startsWith("handoff_"))).toBe(true);
  });

  it("consume refuses a non-pending handoff", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_session_1" }, at(0), 0.1);
    const r = await consumeHandoff(dir, { handoffId }, at(1), 0.2);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/handoff/handlers.test.ts`
Expected: FAIL — cannot find module `../../src/handoff/guards.js` / `handlers.js`.

- [ ] **Step 3a: Implement `src/handoff/guards.ts`**

```ts
import type { HandoffState } from "./handoff.ts";

export interface Gate { ok: boolean; reason: string; }
const ok: Gate = { ok: true, reason: "" };

/** draft allowed only from `requested` (first draft) or `invalid` (re-draft). */
export function canDraft(s: HandoffState): Gate {
  return s.phase === "requested" || s.phase === "invalid"
    ? ok
    : { ok: false, reason: `cannot draft a handoff in phase ${s.phase}` };
}

/** validate allowed only from `validating` (a draft is awaiting the structural check). */
export function canValidate(s: HandoffState): Gate {
  return s.phase === "validating"
    ? ok
    : { ok: false, reason: `no draft awaiting validation (phase ${s.phase})` };
}

/** consume (hydrate) allowed only from `pending` (validated, not yet consumed). */
export function canConsume(s: HandoffState): Gate {
  return s.phase === "pending"
    ? ok
    : { ok: false, reason: `cannot consume a handoff in phase ${s.phase}` };
}
```

- [ ] **Step 3b: Implement `src/handoff/handlers.ts`**

```ts
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveHandoffState, handoffsOf, type HandoffState } from "./handoff.ts";
import { validateHandoff } from "./validate.ts";
import { canDraft, canValidate, canConsume } from "./guards.ts";

export interface HandoffGateResult { ok: boolean; reason: string; eventId?: string; }

async function loadHandoff(
  workspaceDir: string, handoffId: string,
): Promise<{ state: HandoffState; all: GovEvent[]; related: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, handoffId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "handoff_requested")
    throw new Error(`unknown handoff: ${handoffId}`);
  return { state: deriveHandoffState(grp.proposal, grp.related), all, related: grp.related };
}

/** Write one verdict-free handoff lifecycle event. source/actor = "system" (registry record). */
async function writeLifecycle(
  workspaceDir: string, type: EventType, handoffId: string, body: string, now: Date, rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type, source: "system", actor: "system",
      tags: ["handoff"], related_to: [handoffId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

/** request_handoff — births a handoff (handoff_requested). The event id is the new handoff id;
 *  related_to[0] = the session being handed off from. */
export async function requestHandoff(
  workspaceDir: string, input: { sessionId: string }, now: Date, rand: number,
): Promise<{ handoffId: string }> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "handoff_requested", source: "system", actor: "system",
      tags: ["handoff"], related_to: [input.sessionId],
    },
    body: `Handoff requested for ${input.sessionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { handoffId: evt.frontmatter.id };
}

/** draft_handoff — submit a draft markdown body (→ validating). The body IS the handoff content. */
export async function draftHandoff(
  workspaceDir: string, input: { handoffId: string; body: string }, now: Date, rand: number,
): Promise<HandoffGateResult> {
  const { state } = await loadHandoff(workspaceDir, input.handoffId);
  const gate = canDraft(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "handoff_drafted", input.handoffId, input.body, now, rand);
  return { ok: true, reason: "", eventId };
}

export interface ValidateResult extends HandoffGateResult { valid?: boolean; missing?: string[]; }

/** validate_handoff — run the pure structural check on the LATEST draft and emit
 *  handoff_validated (→pending) or handoff_invalid (→invalid, carries missing[]). ok=false means
 *  the command itself could not run (wrong phase / no draft); valid is the structural verdict. */
export async function runValidateHandoff(
  workspaceDir: string, input: { handoffId: string }, now: Date, rand: number,
): Promise<ValidateResult> {
  const { state, related } = await loadHandoff(workspaceDir, input.handoffId);
  const gate = canValidate(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const drafts = related
    .filter((e) => e.frontmatter.type === "handoff_drafted")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  const latest = drafts[drafts.length - 1];
  const result = validateHandoff(latest?.body ?? "");
  if (result.ok) {
    const eventId = await writeLifecycle(workspaceDir, "handoff_validated", input.handoffId, `Validated ${input.handoffId}`, now, rand);
    return { ok: true, reason: "", valid: true, eventId };
  }
  const eventId = await writeLifecycle(
    workspaceDir, "handoff_invalid", input.handoffId, JSON.stringify({ missing: result.missing }), now, rand,
  );
  return { ok: true, reason: "", valid: false, missing: result.missing, eventId };
}

/** consume — mark a pending handoff consumed (handoff_consumed, terminal). The hydration IO shell
 *  (hydrateIo.ts) calls this after assembling the bundle; exposed directly for the no-bundle path. */
export async function consumeHandoff(
  workspaceDir: string, input: { handoffId: string }, now: Date, rand: number,
): Promise<HandoffGateResult> {
  const { state } = await loadHandoff(workspaceDir, input.handoffId);
  const gate = canConsume(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "handoff_consumed", input.handoffId, `Consumed ${input.handoffId}`, now, rand);
  return { ok: true, reason: "", eventId };
}

export interface HandoffSummary { handoffId: string; sessionId: string | null; phase: HandoffState["phase"]; }

/** handoff_status — non-consumed handoffs. */
export async function listHandoffs(workspaceDir: string): Promise<HandoffSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: HandoffSummary[] = [];
  for (const birth of handoffsOf(all)) {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    const s = deriveHandoffState(grp.proposal!, grp.related);
    if (s.phase !== "consumed") out.push({ handoffId: s.handoffId, sessionId: s.sessionId, phase: s.phase });
  }
  return out;
}

export interface HandoffTrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface HandoffTrail { handoffId: string; sessionId: string | null; phase: HandoffState["phase"]; chain: HandoffTrailEntry[]; }

/** handoff <id> — full chronological trail. */
export async function handoffTrail(workspaceDir: string, input: { handoffId: string }): Promise<HandoffTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.handoffId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "handoff_requested")
    throw new Error(`unknown handoff: ${input.handoffId}`);
  const s = deriveHandoffState(grp.proposal, grp.related);
  const chain: HandoffTrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { handoffId: s.handoffId, sessionId: s.sessionId, phase: s.phase, chain };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/handoff/handlers.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/handoff/guards.ts src/handoff/handlers.ts test/handoff/handlers.test.ts
git commit --no-verify -m "feat(governance): Phase G — handoff guards + handlers (request/draft/validate/consume)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Projector (`projectHandoffs` + `renderHandoffs`)

**Files:**
- Create: `src/handoff/project.ts`
- Test: `test/handoff/project.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/handoff/project.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHandoff, draftHandoff, runValidateHandoff } from "../../src/handoff/handlers.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { projectHandoffs, renderHandoffs } from "../../src/handoff/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nc`).join("\n\n");

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-handoff-p-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("handoff projector", () => {
  it("projectHandoffs reflects pending phase; renderHandoffs is rebuildable", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    await draftHandoff(dir, { handoffId, body: complete }, at(1), 0.2);
    await runValidateHandoff(dir, { handoffId }, at(2), 0.3);

    const states = projectHandoffs(await readAllEvents(dir));
    expect(states.find((s) => s.handoffId === handoffId)?.phase).toBe("pending");

    const path = await renderHandoffs(dir);
    const a = await readFile(path, "utf8");
    const b = await readFile(await renderHandoffs(dir), "utf8");
    expect(a).toBe(b); // byte-stable / rebuildable from events
    expect(JSON.parse(a)[0].phase).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/handoff/project.test.ts`
Expected: FAIL — cannot find module `../../src/handoff/project.js`.

- [ ] **Step 3: Implement `src/handoff/project.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveHandoffState, handoffsOf, type HandoffState } from "./handoff.ts";

/** PURE: events → handoff states (sorted by handoff id via handoffsOf). No I/O, emits no events. */
export function projectHandoffs(all: GovEvent[]): HandoffState[] {
  return handoffsOf(all).map((birth) => {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    return deriveHandoffState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/handoffs.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable. The ONLY writer of handoff status;
 *  no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderHandoffs(workspaceDir: string): Promise<string> {
  const states = projectHandoffs(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "handoffs.json");
  const rows = states.map((s) => ({ handoffId: s.handoffId, sessionId: s.sessionId, phase: s.phase }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/handoff/project.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/handoff/project.ts test/handoff/project.test.ts
git commit --no-verify -m "feat(governance): Phase G — projectHandoffs + renderHandoffs (state/handoffs.json)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `computeContextPressure` (pure Steward)

**Files:**
- Create: `src/steward/pressure.ts`
- Test: `test/steward/pressure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/steward/pressure.test.ts
import { describe, it, expect } from "vitest";
import { computeContextPressure, type RuntimeSignals } from "../../src/steward/pressure.js";
import type { GovEvent } from "../../src/event/event.js";

const now = new Date(Date.UTC(2026, 5, 3, 14, 0, 0));
const idle: RuntimeSignals = { estimatedTokenRatio: 0, turnCount: 0, wallClockMs: 0, filesTouched: 0 };
const saturated: RuntimeSignals = { estimatedTokenRatio: 1, turnCount: 200, wallClockMs: 7_200_000, filesTouched: 100 };

describe("computeContextPressure", () => {
  it("idle signals + empty log → low", () => {
    const r = computeContextPressure(idle, [], now);
    expect(r.level).toBe("low");
    expect(r.score).toBeLessThan(0.5);
  });
  it("saturated signals → critical", () => {
    const r = computeContextPressure(saturated, [], now);
    expect(r.level).toBe("critical");
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it("an open decision_blocked raises the unresolvedDecisions component", () => {
    const log: GovEvent[] = [
      { frontmatter: { id: "evt_dp", type: "decision_proposed", source: "agent_run", actor: "a", tags: [] }, body: "" },
      { frontmatter: { id: "evt_db", type: "decision_blocked", source: "agent_run", actor: "a", tags: [], related_to: ["evt_dp"] }, body: "" },
    ];
    const withBlock = computeContextPressure(idle, log, now);
    const without = computeContextPressure(idle, [], now);
    expect(withBlock.components.unresolvedDecisions).toBeGreaterThan(without.components.unresolvedDecisions);
  });
  it("emits nothing (pure) — returns a value only", () => {
    const r = computeContextPressure(idle, [], now);
    expect(Object.keys(r).sort()).toEqual(["components", "level", "score"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/steward/pressure.test.ts`
Expected: FAIL — cannot find module `../../src/steward/pressure.js`.

- [ ] **Step 3: Implement `src/steward/pressure.ts`**

```ts
import type { GovEvent } from "../event/event.ts";

/** Runtime-only signals the SIDECAR cannot observe — supplied by the caller (MCP boundary / hermes). */
export interface RuntimeSignals {
  estimatedTokenRatio: number; // 0..1 of the model context window
  turnCount: number;
  wallClockMs: number;
  filesTouched: number;
}

export type PressureLevel = "low" | "medium" | "high" | "critical";

export interface PressureComponents {
  estimatedTokenRatio: number;
  turnCount: number;
  wallClockMs: number;
  filesTouched: number;
  unresolvedDecisions: number;
  planStepDistanceToSafeBoundary: number;
  lastHandoffAgeMs: number;
}

export interface ContextPressure {
  level: PressureLevel;
  score: number; // 0..1
  components: PressureComponents; // each NORMALIZED to 0..1 (the weighted inputs)
}

const HOUR_MS = 3_600_000;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Weights sum to 1.0 (documented in the design §3). estimatedTokenRatio dominates because it is
 *  the direct cause of context saturation; event-derived signals are corroborating. */
const W = {
  estimatedTokenRatio: 0.30,
  turnCount: 0.15,
  wallClockMs: 0.10,
  filesTouched: 0.10,
  unresolvedDecisions: 0.15,
  planStepDistanceToSafeBoundary: 0.10,
  lastHandoffAgeMs: 0.10,
} as const;

/** Parse the embedded UTC stamp from an event id (prefix_YYYYMMDD_HHMMSS_hex) → epoch ms, or null. */
function idStampMs(id: string): number | null {
  const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Open decision_blocked count: a decision_blocked whose referenced decision_proposed has no
 *  verdict event (decision_approved/rejected/chosen) in the log. Conservative: unmatched → open. */
function countUnresolvedDecisions(log: GovEvent[]): number {
  const VERDICTS = new Set(["decision_approved", "decision_rejected", "decision_chosen"]);
  const resolved = new Set(
    log.filter((e) => VERDICTS.has(e.frontmatter.type)).flatMap((e) => e.frontmatter.related_to ?? []),
  );
  let n = 0;
  for (const e of log) {
    if (e.frontmatter.type !== "decision_blocked") continue;
    const refs = e.frontmatter.related_to ?? [];
    if (!refs.some((r) => resolved.has(r))) n++;
  }
  return n;
}

/** In-flight task count (active|blocked task lifecycle) as a bounded proxy for "distance to a safe
 *  stopping boundary": more live work = further from a clean checkpoint. PURE over the log. */
function inFlightTaskCount(log: GovEvent[]): number {
  const created = log.filter((e) => e.frontmatter.type === "task_created").map((e) => e.frontmatter.id);
  let n = 0;
  for (const taskId of created) {
    const related = log.filter((e) => (e.frontmatter.related_to ?? []).includes(taskId));
    const terminal = related.some((e) => e.frontmatter.type === "task_completed" || e.frontmatter.type === "task_cancelled");
    if (terminal) continue;
    const started = related.some((e) => e.frontmatter.type === "task_started");
    const blocked = related.some((e) => e.frontmatter.type === "task_blocked");
    if (started || blocked) n++;
  }
  return n;
}

/** Age (ms) since the most recent handoff_requested. No handoff ever → HOUR_MS (max component). */
function lastHandoffAgeMs(log: GovEvent[], now: Date): number {
  const births = log
    .filter((e) => e.frontmatter.type === "handoff_requested")
    .map((e) => idStampMs(e.frontmatter.id))
    .filter((x): x is number => x !== null);
  if (births.length === 0) return HOUR_MS;
  return Math.max(0, now.getTime() - Math.max(...births));
}

/** PURE: runtime signals + event-derived signals → an ADVISORY weighted pressure level. Emits
 *  NOTHING. `now` is supplied by the caller (Boule forbids Date.now() in source). Thresholds §9:
 *  low<0.50 · medium<0.70 · high<0.85 · critical>=0.85. */
export function computeContextPressure(rt: RuntimeSignals, log: GovEvent[], now: Date): ContextPressure {
  const components: PressureComponents = {
    estimatedTokenRatio: clamp01(rt.estimatedTokenRatio),
    turnCount: clamp01(rt.turnCount / 50),
    wallClockMs: clamp01(rt.wallClockMs / HOUR_MS),
    filesTouched: clamp01(rt.filesTouched / 20),
    unresolvedDecisions: clamp01(countUnresolvedDecisions(log) / 5),
    planStepDistanceToSafeBoundary: clamp01(inFlightTaskCount(log) / 5),
    lastHandoffAgeMs: clamp01(lastHandoffAgeMs(log, now) / HOUR_MS),
  };
  const score = clamp01(
    components.estimatedTokenRatio * W.estimatedTokenRatio +
      components.turnCount * W.turnCount +
      components.wallClockMs * W.wallClockMs +
      components.filesTouched * W.filesTouched +
      components.unresolvedDecisions * W.unresolvedDecisions +
      components.planStepDistanceToSafeBoundary * W.planStepDistanceToSafeBoundary +
      components.lastHandoffAgeMs * W.lastHandoffAgeMs,
  );
  const level: PressureLevel = score >= 0.85 ? "critical" : score >= 0.70 ? "high" : score >= 0.50 ? "medium" : "low";
  return { level, score, components };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/steward/pressure.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/steward/pressure.ts test/steward/pressure.test.ts
git commit --no-verify -m "feat(governance): Phase G — computeContextPressure (pure advisory Steward)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `assembleBundle` (pure hydration core) + laundering-prevention

**Files:**
- Create: `src/steward/hydrate.ts`
- Test: `test/steward/hydrate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/steward/hydrate.test.ts
import { describe, it, expect } from "vitest";
import { assembleBundle, type AssembleInputs } from "../../src/steward/hydrate.js";
import type { GovEvent } from "../../src/event/event.js";

const base: AssembleInputs = {
  handoff: { handoffId: "evt_h1", sessionId: "evt_s1", phase: "pending", verdict: null },
  handoffBody: "## Mission\nfinish X\n\n## Next exact steps\nrun build",
  log: [],
  principles: ["INVARIANT #1: automation must not penetrate the decision rail"],
  spec: "spec: build X",
  activePlan: "plan: 3 steps",
  currentTask: "task: step 2",
  indexNeighbors: [{ node_id: "task:evt_t1", title: "step 2" }],
  gitSummary: { status: "M src/foo.ts", diffstat: "1 file changed" },
  autonomyEnvelope: "read-only; no network",
};

describe("assembleBundle", () => {
  it("returns a structured bundle and a rendered markdown string", () => {
    const { bundle, markdown } = assembleBundle(base);
    expect(bundle.spec).toBe("spec: build X");
    expect(markdown).toContain("# Hydration Bundle");
    expect(markdown).toContain("run build");
  });

  it("LAUNDERING-PREVENTION: carries open decision_blocked items + envelope, no authority field", () => {
    const log: GovEvent[] = [
      { frontmatter: { id: "evt_dp", type: "decision_proposed", source: "agent_run", actor: "a", tags: [] }, body: "fork: A or B" },
      { frontmatter: { id: "evt_db", type: "decision_blocked", source: "agent_run", actor: "a", tags: [], related_to: ["evt_dp"] }, body: "needs human" },
    ];
    const { bundle } = assembleBundle({ ...base, log });
    expect(bundle.openBlockers.length).toBe(1);
    expect(bundle.openBlockers[0].decisionId).toBe("evt_dp");
    expect(bundle.autonomyEnvelope).toBe("read-only; no network");
    // No authority-granting field may exist on the bundle.
    const forbidden = /grant|approve|allow|permit|authori/i;
    expect(Object.keys(bundle).some((k) => forbidden.test(k))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/steward/hydrate.test.ts`
Expected: FAIL — cannot find module `../../src/steward/hydrate.js`.

- [ ] **Step 3: Implement `src/steward/hydrate.ts`**

```ts
import type { GovEvent } from "../event/event.ts";
import type { HandoffState } from "../handoff/handoff.ts";

export interface GitSummary { status: string; diffstat: string; }
export interface IndexNeighbor { node_id: string; title: string; }
export interface OpenBlocker { decisionId: string; blockedEventId: string; summary: string; }

/** Inputs to the PURE hydration assembler — all already read by the IO shell (no I/O here). */
export interface AssembleInputs {
  handoff: HandoffState;
  handoffBody: string;       // the latest validated draft body (the 7 sections)
  log: GovEvent[];           // for recent events + open blockers
  principles: string[];      // from the Phase 3 index ingress
  spec: string;              // derived/selected upstream
  activePlan: string;
  currentTask: string;
  indexNeighbors: IndexNeighbor[]; // 1-hop from the Phase F graph index
  gitSummary: GitSummary;
  autonomyEnvelope: string;  // carried from the handoff/session — NOT expandable
}

/** The continuity payload a fresh session consumes. NOTE: there is intentionally NO field that
 *  grants/approves/allows authority — the bundle informs, it does not empower (laundering ban §4.4#5). */
export interface HydrationBundle {
  roleTemplate: string;
  principles: string[];
  spec: string;
  activePlan: string;
  currentTask: string;
  latestHandoff: string;
  recentEvents: { id: string; type: string }[];
  gitSummary: GitSummary;
  knownRisks: string[];
  nextExactSteps: string;
  openBlockers: OpenBlocker[]; // unresolved decision_blocked — MUST survive into the new session
  autonomyEnvelope: string;
}

const RECENT_N = 20;

function openBlockers(log: GovEvent[]): OpenBlocker[] {
  const VERDICTS = new Set(["decision_approved", "decision_rejected", "decision_chosen"]);
  const resolved = new Set(
    log.filter((e) => VERDICTS.has(e.frontmatter.type)).flatMap((e) => e.frontmatter.related_to ?? []),
  );
  const out: OpenBlocker[] = [];
  for (const e of log) {
    if (e.frontmatter.type !== "decision_blocked") continue;
    const refs = e.frontmatter.related_to ?? [];
    if (refs.some((r) => resolved.has(r))) continue;
    out.push({
      decisionId: refs[0] ?? e.frontmatter.id,
      blockedEventId: e.frontmatter.id,
      summary: e.body.split("\n", 1)[0] ?? "",
    });
  }
  return out;
}

/** Extract a named markdown section's content from the handoff body (best-effort; "" if absent). */
function sectionContent(body: string, name: string): string {
  const lines = body.split("\n");
  let capture = false;
  const out: string[] = [];
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) { capture = m[1].toLowerCase().startsWith(name.toLowerCase()); continue; }
    if (capture) out.push(line);
  }
  return out.join("\n").trim();
}

/** PURE: assemble the hydration bundle + a deterministic markdown render. No I/O. */
export function assembleBundle(inp: AssembleInputs): { bundle: HydrationBundle; markdown: string } {
  const recentEvents = inp.log
    .slice(-RECENT_N)
    .map((e) => ({ id: e.frontmatter.id, type: e.frontmatter.type }));
  const knownRisksText = sectionContent(inp.handoffBody, "Do not do");
  const bundle: HydrationBundle = {
    roleTemplate: "Resume the in-flight task. Preserve all open blockers; do not expand authority.",
    principles: inp.principles,
    spec: inp.spec,
    activePlan: inp.activePlan,
    currentTask: inp.currentTask,
    latestHandoff: inp.handoffBody,
    recentEvents,
    gitSummary: inp.gitSummary,
    knownRisks: knownRisksText ? knownRisksText.split("\n").filter((l) => l.trim()) : [],
    nextExactSteps: sectionContent(inp.handoffBody, "Next exact steps"),
    openBlockers: openBlockers(inp.log),
    autonomyEnvelope: inp.autonomyEnvelope,
  };

  const md = [
    "# Hydration Bundle",
    `\n## Role\n${bundle.roleTemplate}`,
    `\n## Autonomy envelope\n${bundle.autonomyEnvelope}`,
    `\n## Principles\n${bundle.principles.map((p) => `- ${p}`).join("\n") || "(none)"}`,
    `\n## Spec\n${bundle.spec}`,
    `\n## Active plan\n${bundle.activePlan}`,
    `\n## Current task\n${bundle.currentTask}`,
    `\n## Open blockers (MUST resolve via human gate — do not assume)\n${bundle.openBlockers.map((b) => `- ${b.decisionId}: ${b.summary}`).join("\n") || "(none)"}`,
    `\n## Next exact steps\n${bundle.nextExactSteps}`,
    `\n## Known risks (do not do)\n${bundle.knownRisks.map((r) => `- ${r}`).join("\n") || "(none)"}`,
    `\n## Git\n${bundle.gitSummary.status}\n${bundle.gitSummary.diffstat}`,
    `\n## Recent events\n${bundle.recentEvents.map((e) => `- ${e.id} ${e.type}`).join("\n") || "(none)"}`,
  ].join("\n");

  return { bundle, markdown: md };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/steward/hydrate.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/steward/hydrate.ts test/steward/hydrate.test.ts
git commit --no-verify -m "feat(governance): Phase G — assembleBundle pure hydration core + laundering-prevention

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `hydrate` IO shell

**Files:**
- Create: `src/steward/hydrateIo.ts`
- Test: `test/steward/hydrateIo.test.ts`

The shell injects its non-deterministic edges (git summary, index neighbors) via a `deps` object — mirroring the conductor/observer adapter-injection pattern — so it is testable without git or PGlite.

- [ ] **Step 1: Write the failing test**

```ts
// test/steward/hydrateIo.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrate, type HydrateDeps } from "../../src/steward/hydrateIo.js";
import { requestHandoff, draftHandoff, runValidateHandoff, handoffTrail } from "../../src/handoff/handlers.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nc ${h}`).join("\n\n");
const deps: HydrateDeps = {
  gitSummary: async () => ({ status: "clean", diffstat: "" }),
  readNeighbors: async () => [],
  principles: async () => ["INVARIANT #1"],
};

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-hydrate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("hydrate IO shell", () => {
  it("assembles a bundle and consumes the pending handoff", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    await draftHandoff(dir, { handoffId, body: complete }, at(1), 0.2);
    await runValidateHandoff(dir, { handoffId }, at(2), 0.3);

    const r = await hydrate(dir, { handoffId }, deps, at(3), 0.4);
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain("# Hydration Bundle");
    expect((await handoffTrail(dir, { handoffId })).phase).toBe("consumed");

    // INVARIANT #1: the whole path wrote only handoff_* events.
    const all = await readAllEvents(dir);
    expect(all.every((e) => e.frontmatter.type.startsWith("handoff_"))).toBe(true);
  });

  it("refuses to hydrate a non-pending handoff", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    const r = await hydrate(dir, { handoffId }, deps, at(1), 0.2);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/steward/hydrateIo.test.ts`
Expected: FAIL — cannot find module `../../src/steward/hydrateIo.js`.

- [ ] **Step 3: Implement `src/steward/hydrateIo.ts`**

```ts
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveHandoffState } from "../handoff/handoff.ts";
import { canConsume } from "../handoff/guards.ts";
import { consumeHandoff } from "../handoff/handlers.ts";
import { projectPlans } from "../plan/project.ts";
import { projectTasks } from "../task/project.ts";
import { assembleBundle, type GitSummary, type IndexNeighbor, type HydrationBundle } from "./hydrate.ts";

/** Injected non-deterministic edges (git, the Phase F index, the principles index). Tests stub these;
 *  the MCP boundary wires real `git` + graphStore.getNeighbors + buildIndex. */
export interface HydrateDeps {
  gitSummary: () => Promise<GitSummary>;
  readNeighbors: (nodeId: string) => Promise<IndexNeighbor[]>;
  principles: () => Promise<string[]>;
}

export interface HydrateResult {
  ok: boolean;
  reason: string;
  bundle?: HydrationBundle;
  markdown?: string;
  eventId?: string;
}

/** hydrate — load a PENDING handoff, assemble the bundle from already-read inputs, emit ONE
 *  handoff_consumed, return { bundle, markdown }. Fail-closed if the handoff is not pending. The
 *  pure assembler does the laundering-prevention; this shell only does I/O at the edges. */
export async function hydrate(
  workspaceDir: string,
  input: { handoffId: string },
  deps: HydrateDeps,
  now: Date,
  rand: number,
): Promise<HydrateResult> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.handoffId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "handoff_requested")
    return { ok: false, reason: `unknown handoff: ${input.handoffId}` };
  const state = deriveHandoffState(grp.proposal, grp.related);
  const gate = canConsume(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const latestDraft = grp.related
    .filter((e) => e.frontmatter.type === "handoff_drafted")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))
    .at(-1);

  const plans = projectPlans(all);
  const tasks = projectTasks(all);
  const activePlan = plans.find((p) => p.phase === "active");
  const currentTask = tasks.find((t) => t.phase === "active" || t.phase === "blocked");
  const neighbors = state.sessionId ? await deps.readNeighbors(`session:${state.sessionId}`) : [];

  const { bundle, markdown } = assembleBundle({
    handoff: state,
    handoffBody: latestDraft?.body ?? "",
    log: all,
    principles: await deps.principles(),
    spec: activePlan ? `plan ${activePlan.planId}` : "(no active plan)",
    activePlan: activePlan ? `${activePlan.planId} [${activePlan.phase}] ${activePlan.title}` : "(none)",
    currentTask: currentTask ? `${currentTask.taskId} [${currentTask.phase}] ${currentTask.title}` : "(none)",
    indexNeighbors: neighbors,
    gitSummary: await deps.gitSummary(),
    autonomyEnvelope: "carried from session; not expandable by hydration",
  });

  const consumed = await consumeHandoff(workspaceDir, { handoffId: input.handoffId }, now, rand);
  if (!consumed.ok) return { ok: false, reason: consumed.reason };
  return { ok: true, reason: "", bundle, markdown, eventId: consumed.eventId };
}
```

> NOTE: confirm `projectPlans` exports a `PlanState` with `planId`/`phase`/`title`. If a field name differs, adjust the render strings only (no behavior change). Check `src/plan/plan.ts` before implementing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/steward/hydrateIo.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/steward/hydrateIo.ts test/steward/hydrateIo.test.ts
git commit --no-verify -m "feat(governance): Phase G — hydrate IO shell (bundle assembly + consume)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: MCP wiring (6 commands) + negative + drift gates

**Files:**
- Modify: `src/mcp/server.ts` (add imports near the other handler imports; register 6 tools after the Phase F block, before `await server.connect(...)`)
- Test: `test/mcp/handoff.test.ts`

- [ ] **Step 1: Write the failing test (negative + round-trip via handlers, server-shape parity)**

```ts
// test/mcp/handoff.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHandoff, draftHandoff, runValidateHandoff } from "../../src/handoff/handlers.js";
import { hydrate, type HydrateDeps } from "../../src/steward/hydrateIo.js";
import { computeContextPressure } from "../../src/steward/pressure.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nc`).join("\n\n");
const deps: HydrateDeps = { gitSummary: async () => ({ status: "", diffstat: "" }), readNeighbors: async () => [], principles: async () => [] };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-mcp-handoff-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("Phase G command surface (INVARIANT #1)", () => {
  it("the full handoff+hydrate path writes ZERO decision_/task_/session_ events", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    await draftHandoff(dir, { handoffId, body: complete }, at(1), 0.2);
    await runValidateHandoff(dir, { handoffId }, at(2), 0.3);
    await hydrate(dir, { handoffId }, deps, at(3), 0.4);

    const all = await readAllEvents(dir);
    const forbidden = all.filter((e) =>
      /^(decision_|task_|session_)/.test(e.frontmatter.type),
    );
    expect(forbidden).toEqual([]);
  });

  it("context_pressure is read-only (computing it writes nothing)", async () => {
    const before = (await readAllEvents(dir)).length;
    computeContextPressure({ estimatedTokenRatio: 0.9, turnCount: 10, wallClockMs: 0, filesTouched: 0 }, [], at(0));
    const after = (await readAllEvents(dir)).length;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes for handler-level; then wire MCP)**

Run: `pnpm exec vitest run test/mcp/handoff.test.ts`
Expected: PASS at the handler level (this test exercises handlers/shell, which already exist). It locks the INVARIANT before MCP wiring. Proceed to wire the server tools.

- [ ] **Step 3: Wire the 6 tools in `src/mcp/server.ts`**

Add imports alongside the existing handler imports (after the Phase F `rebuildIndex` import near line 61):

```ts
import {
  requestHandoff, draftHandoff, runValidateHandoff, listHandoffs, handoffTrail,
} from "../handoff/handlers.ts";
import { hydrate, type HydrateDeps } from "../steward/hydrateIo.ts";
import { computeContextPressure, type RuntimeSignals } from "../steward/pressure.ts";
import { buildIndex as buildPrincipleIndex, nodeIndexFs as principleFs } from "../index/build.ts";
```

> `buildIndex`/`nodeIndexFs` are already imported for the `principles` tool — REUSE the existing imports; do NOT add the aliased line above if it duplicates. Use the already-imported `buildIndex(REPO_ROOT, nodeIndexFs)` to source principles.

Register after the Phase F `graph_neighbors` block (before `await server.connect`):

```ts
// ── v3 Phase G: Context Steward / Handoff continuity ──────────────────────────
// Handoff axis (verdict-free) + advisory Steward. NO decision/task/session write-path; the ONLY
// new write is hydrate emitting one handoff_consumed. context_pressure is read-only/advisory.
server.registerTool(
  "request_handoff",
  { description: "세션에 대한 handoff를 births (handoff_requested). sessionId=인계 대상 세션", inputSchema: { sessionId: z.string() } },
  async ({ sessionId }) => {
    const r = await requestHandoff(WORKSPACE, { sessionId }, nowFn(), randFn());
    return { content: [{ type: "text", text: `handoff requested: ${r.handoffId}` }] };
  },
);

server.registerTool(
  "draft_handoff",
  { description: "handoff 초안 markdown 본문 제출 (→ validating). 7개 필수 섹션 포함", inputSchema: { handoffId: z.string(), body: z.string() } },
  async ({ handoffId, body }) => {
    const r = await draftHandoff(WORKSPACE, { handoffId, body }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `drafted: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "validate_handoff",
  { description: "최신 초안에 대해 7-섹션 구조 검증 → handoff_validated(통과) | handoff_invalid(미충족 섹션)", inputSchema: { handoffId: z.string() } },
  async ({ handoffId }) => {
    const r = await runValidateHandoff(WORKSPACE, { handoffId }, nowFn(), randFn());
    if (!r.ok) return { content: [{ type: "text", text: `REFUSED: ${r.reason}` }] };
    return { content: [{ type: "text", text: r.valid ? `validated (pending): ${r.eventId}` : `invalid — missing: ${(r.missing ?? []).join(", ")}` }] };
  },
);

server.registerTool(
  "hydrate",
  { description: "pending handoff에서 hydration 번들 조립 + handoff_consumed 방출 (새 세션 재개용). 번들은 반환만(미영속)", inputSchema: { handoffId: z.string() } },
  async ({ handoffId }) => {
    const deps: HydrateDeps = {
      gitSummary: async () => {
        const { spawnSync } = await import("node:child_process");
        const st = spawnSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" });
        const ds = spawnSync("git", ["-C", REPO_ROOT, "diff", "--stat"], { encoding: "utf8" });
        return { status: (st.stdout ?? "").trim(), diffstat: (ds.stdout ?? "").trim() };
      },
      readNeighbors: async (nodeId) => {
        const nb = await graphStore.getNeighbors(nodeId);
        return nb ? nb.neighbors.map((n) => ({ node_id: n.node_id, title: n.title })) : [];
      },
      principles: async () => {
        const index = await buildIndex(REPO_ROOT, nodeIndexFs);
        return index.principles.map((p) => (typeof p === "string" ? p : JSON.stringify(p)));
      },
    };
    const r = await hydrate(WORKSPACE, { handoffId }, deps, nowFn(), randFn());
    if (!r.ok) return { content: [{ type: "text", text: `REFUSED: ${r.reason}` }] };
    return { content: [{ type: "text", text: r.markdown ?? "" }] };
  },
);

server.registerTool(
  "handoff_status",
  { description: "비종료(non-consumed) handoff 목록 (read-only)", inputSchema: {} },
  async () => {
    const list = await listHandoffs(WORKSPACE);
    const text = list.length
      ? list.map((h) => `${h.handoffId} [${h.phase}] session=${h.sessionId ?? "-"}`).join("\n")
      : "(no open handoffs)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "context_pressure",
  {
    description: "advisory context pressure 계산 (caller가 런타임 신호 제공, 이벤트-파생 신호는 로그에서 fold). 쓰기 없음 — session_context_pressure_changed 미작성",
    inputSchema: {
      estimatedTokenRatio: z.number().min(0).max(1),
      turnCount: z.number().int().min(0),
      wallClockMs: z.number().min(0),
      filesTouched: z.number().int().min(0),
    },
  },
  async (rt: RuntimeSignals) => {
    const all = await readAllEvents(WORKSPACE);
    const p = computeContextPressure(rt, all, nowFn());
    return { content: [{ type: "text", text: `pressure: ${p.level} (score ${p.score.toFixed(2)})` }] };
  },
);
```

> The `principles` index field shape: confirm `index.principles` exists on the object returned by `buildIndex` (it's used by `formatPrinciples`). If the public accessor differs (e.g. `index.getPrinciples()`), use that — check `src/index/build.ts` / `src/index/format.ts` before implementing. This is a render-only detail; it does not change behavior or events.

- [ ] **Step 4: Run the full gate suite**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```
Expected: tsc 0 errors; all tests pass (prior baseline 394 + the new Phase G tests).

- [ ] **Step 5: Drift gates (INVARIANT #4/#6) + commit**

```bash
git -C "$(git rev-parse --show-toplevel)" diff f4ec295..HEAD -- src/bindings.ts        # expect EMPTY
git -C "$(git rev-parse --show-toplevel)" diff f4ec295..HEAD -- src-tauri/migrations    # expect EMPTY
git add src/mcp/server.ts test/mcp/handoff.test.ts
git commit --no-verify -m "feat(governance): Phase G — MCP surface (request/draft/validate/hydrate/status/pressure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If either diff is non-empty, STOP — a regression has leaked into the app boundary; investigate before continuing.

---

## Final verification (before requesting the impl-critic)

Run from `governance/`:

```bash
pnpm exec tsc --noEmit                 # expect 0
pnpm exec vitest run                   # expect green; record the count
```

From repo root, confirm the app boundary is untouched since the design commit:

```bash
git diff f4ec295..HEAD -- src/bindings.ts src-tauri/migrations   # expect EMPTY
git diff f4ec295..HEAD --stat -- governance/                      # all changes confined to governance/
```

Then mark Phase G ✅ DONE in `governance/docs/INDEX.md` (master table row G + a new implementation-slice row) and commit `docs(governance): mark Phase G DONE`.

**Separate impl-critic (opus, fresh context) ACCEPT 0 blockers is required before DONE — self-approve forbidden.** The critic re-runs the gates independently and checks: (1) zero decision/task/session writes on the Phase G path (negative test), (2) `computeContextPressure` emits nothing, (3) laundering-prevention property holds, (4) `bindings.ts` + migrations byte-unchanged, (5) folds fail-closed on foreign types.

---

## Self-Review (plan vs. spec)

- **Spec coverage:** (A) handoff lifecycle SSOT → Tasks 1–5; (B) hydration bundle → Tasks 7–8 (+ MCP T9); (C) pressure scoring → Task 6. Validation gates (auto-structural) → Task 3+4. Consume-on-hydrate → Task 8. Advisory-only pressure → Task 6 + T9 read-only `context_pressure`. Laundering-prevention → Task 7 property test. Negative INVARIANT #1 → Task 9. Drift gates → Task 9 + Final. All §0.1 decisions and §0.2 non-goals respected (no archived event, no second pressure writer, no persisted bundle, no UI).
- **Placeholder scan:** none — every step carries real code. The two `> NOTE` callouts (plan `PlanState`/`index.principles` field names) are explicit "confirm exact accessor in the named file" checks, not deferred work; they cannot change behavior or events.
- **Type consistency:** `HandoffState`/`HandoffPhase` (T2) reused by guards (T4), project (T5), hydrate (T7/T8). `runValidateHandoff` (not `validateHandoffCmd`) used consistently in T4/T9. `computeContextPressure(rt, log, now)` signature identical in T6/T8/T9. `HydrateDeps`/`AssembleInputs` field names match across T7/T8/T9. `requestHandoff` returns `{ handoffId }` everywhere.
