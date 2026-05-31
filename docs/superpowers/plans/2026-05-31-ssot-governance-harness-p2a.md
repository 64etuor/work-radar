# SSOT Governance Harness (Boule) — P2a Implementation Plan (Decision Governance Core)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mechanize the work-radar rule _"a Type 1 (irreversible) decision must not be auto-executed without an external review **and** a human gate"_ inside the markdown SSOT, exposed via Governance MCP commands — fully headless-verifiable, **no work-radar app code, no `bindings.ts` drift**.

**Architecture:** Pure event-sourcing on top of the P1 L0 event store. A decision's gate-state is _derived_ by folding its lifecycle events (`decision_proposed` → `decision_review_recorded` → `decision_approved`/`decision_rejected`), all linked by `related_to: [decisionId]` where `decisionId` = the proposal event's id. A pure **Type 1 Guardian** policy makes `approve` mechanically refuse any decision that has no review yet — that refusal _is_ the mechanization of INVARIANT #1. The **External Reviewer** is orchestration over an injected `ReviewFn` (deterministic in tests; live different-model wiring is a flagged follow-up). Human `approve`/`reject` are recorded as `actor: "user"` events — the human gate.

**Tech Stack:** TypeScript(ESM, NodeNext) + Node ≥18, `@modelcontextprotocol/sdk` 1.29 (`registerTool` + zod 4.4.3), `gray-matter`, `vitest`, pnpm. Same standalone `governance/` sidecar as P1 (outside the Tauri/Vite build graph).

상위 설계 정본: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md` §1.2, §5.1, §6. P1 정본: `docs/superpowers/plans/2026-05-31-ssot-governance-harness-p1.md`.

---

## ⚠️ Scope & boundaries (read before Task 0)

- **In scope (P2a, this plan):** decision lifecycle event model, derive-state fold, Type 1 Guardian policy, External Reviewer orchestration (injected `ReviewFn` + placeholder stub at the server boundary), MCP commands `propose_decision` / `request_review` / `approve` / `reject` / `conflicts` / `why` / `history`, workspace agent specs + `interfaces/MCP.md` update. All verified by `vitest` + a headless MCP stdio round-trip (the P1 pattern).
- **Deferred — live reviewer model wiring** (own follow-up task/PR): replacing the placeholder `ReviewFn` with a real adversarial different-model call (`claude -p` / `omc ask` with a model ≠ author). Involves subprocess + bounded retry (INVARIANT #5) + cost; kept out so the gate logic lands deterministically first. The `ReviewFn` interface in Task 3 fully defines the seam.
- **Deferred — ADR-file ingress** (P3 `services/index`): auto-detecting new `docs/adr/*.md` as `decision_proposed`. P2a ingress is the explicit `propose_decision` MCP command (the Gateway already maps `adr_added → decision_proposed`, so the seam exists). See spec §2.2.
- **Deferred — P2b work-radar interactive approval card** (separate plan `…-p2b.md`): the spec §5.2/§5.3 tappable shadcn card = new `hermes-agent:ask-user` event + `hermes_ask_user_respond` specta command + Hermes panel UI. Touches `bindings.ts` (CI gate) + DESIGN.md/shadcn + needs the in-app GUI smoke (currently blocked by the dev-DB migration skew, see P1 plan banner). In P2a the human gate is satisfied by the **MCP text commands** `/approve <id>` / `/reject <id>` already surfaced in `HermesSlashMenu` — no app code needed.

**INVARIANT compliance (P2a):** #1 — agents propose only; `approve`/`reject` are human-actor commands and `approve` _mechanically_ refuses un-reviewed decisions. #4 — no Tauri command/event touched → no bindings drift (verify `git diff src/bindings.ts` empty). #5 — placeholder reviewer needs no retry; the live `ReviewFn` follow-up must add bounded retry. #6 — no SQLite touched (governance is separate markdown). Verification is a **separate reviewer pass** (critic) — self-approve 금지.

---

## File Structure

All paths under `governance/`. New files unless noted.

```
src/
  event/
    event.ts          # MODIFY: extend EventType + EventSource with decision-lifecycle variants
  decision/
    decision.ts       # NEW: DecisionPhase/DecisionState + deriveDecisionState() fold (pure)
    readEvents.ts      # NEW: readAllEvents() + eventsForDecision() (filesystem read + group)
    guardian.ts       # NEW: Type 1 Guardian policy — canApprove()/canReject()/gateLabel() (pure)
    reviewer.ts       # NEW: ReviewFn interface + recordReview() orchestration (injected fn)
    handlers.ts       # NEW: MCP command handlers (propose/request_review/approve/reject/conflicts/why/history)
  mcp/
    server.ts         # MODIFY: register 7 new tools; inject now/rand + placeholder ReviewFn at boundary
test/
  decision/
    decision.test.ts        # NEW
    readEvents.test.ts       # NEW
    guardian.test.ts         # NEW
    reviewer.test.ts         # NEW
    handlers.test.ts         # NEW  (incl. the CRITICAL approve-before-review-refused test)
workspace/
  agents/type1-guardian.md     # NEW: agent spec (SSOT part)
  agents/external-reviewer.md  # NEW: agent spec (SSOT part)
  interfaces/MCP.md            # MODIFY: document the 7 new commands
```

**Convention reminders (P1 traps — non-negotiable):** runtime `src/**` imports use the **`.ts`** extension (`allowImportingTsExtensions: true`); **test files import `.js`** (vitest Vite resolver), e.g. `from "../../src/decision/decision.js"`. Non-determinism (`new Date()`, `Math.random()`) only at the server boundary — handlers take `now`/`rand` params. Run all commands from `governance/`. Install (if ever needed) = `pnpm install --ignore-workspace`.

---

## Task 0: Extend event vocabulary with the decision lifecycle

**Files:**

- Modify: `governance/src/event/event.ts:3-14`

- [ ] **Step 1: Extend `EventType` and `EventSource`**

In `src/event/event.ts`, add the three lifecycle variants to `EventType` (keep existing) and a `reviewer` source:

```typescript
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
  | "task_created";

export type EventSource =
  | "git"
  | "github"
  | "agent_run"
  | "decisions_doc"
  | "adr"
  | "hermes"
  | "system"
  | "reviewer"; // P2a: External Reviewer agent
```

- [ ] **Step 2: Run the existing suite to prove no regression**

Run: `pnpm test`
Expected: still **16 passed** (id 3, event 3, writeEvent 2, gateway 5, handlers 3). The union widening is backward-compatible.

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add governance/src/event/event.ts
git commit -m "feat(governance): P2a Task 0 — decision lifecycle event types"
```

---

## Task 1: Derive a decision's gate-state from its events (pure fold)

**Files:**

- Create: `governance/src/decision/decision.ts`
- Test: `governance/test/decision/decision.test.ts`

- [ ] **Step 1: Write the failing test**

`test/decision/decision.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deriveDecisionState } from "../../src/decision/decision.js";
import type { GovEvent } from "../../src/event/event.js";

const ID = "evt_20260531_120000_aaaa";

function evt(
  type: GovEvent["frontmatter"]["type"],
  over: Partial<GovEvent["frontmatter"]> = {},
  body = "",
): GovEvent {
  return {
    frontmatter: {
      id: "evt_x",
      type,
      source: "hermes",
      actor: "user",
      tags: [],
      related_to: [ID],
      ...over,
    },
    body,
  };
}
const proposal: GovEvent = {
  frontmatter: {
    id: ID,
    type: "decision_proposed",
    source: "hermes",
    actor: "user",
    tags: ["decision", "type1"],
  },
  body: "Adopt X\n\nrationale body",
};

describe("deriveDecisionState", () => {
  it("proposed when no review and no verdict", () => {
    const s = deriveDecisionState(proposal, []);
    expect(s.phase).toBe("proposed");
    expect(s.reviewed).toBe(false);
    expect(s.reviewCount).toBe(0);
    expect(s.verdict).toBeNull();
    expect(s.title).toBe("Adopt X");
  });

  it("reviewed after a review event, still no verdict", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "external-reviewer" }),
    ]);
    expect(s.phase).toBe("reviewed");
    expect(s.reviewed).toBe(true);
    expect(s.reviewCount).toBe(1);
    expect(s.verdict).toBeNull();
  });

  it("approved when an approval event exists", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer" }),
      evt("decision_approved"),
    ]);
    expect(s.phase).toBe("approved");
    expect(s.verdict).toBe("approved");
  });

  it("rejected takes precedence as a terminal verdict", () => {
    const s = deriveDecisionState(proposal, [evt("decision_rejected")]);
    expect(s.phase).toBe("rejected");
    expect(s.verdict).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/decision/decision.test.ts`
Expected: FAIL — cannot find module `decision.js` / `deriveDecisionState` is not a function.

- [ ] **Step 3: Implement `src/decision/decision.ts`**

```typescript
import type { GovEvent } from "../event/event.ts";

export type DecisionPhase = "proposed" | "reviewed" | "approved" | "rejected";

export interface DecisionState {
  decisionId: string;
  title: string;
  phase: DecisionPhase;
  reviewCount: number;
  reviewed: boolean;
  verdict: "approved" | "rejected" | null;
}

/** Pure fold: a proposal event + its related lifecycle events → gate-state.
 *  `related` = events whose related_to includes the proposal id (any order). */
export function deriveDecisionState(proposal: GovEvent, related: GovEvent[]): DecisionState {
  const decisionId = proposal.frontmatter.id;
  const title = proposal.body.split("\n", 1)[0]?.trim() || decisionId;
  const reviewCount = related.filter(
    (e) => e.frontmatter.type === "decision_review_recorded",
  ).length;
  const rejected = related.some((e) => e.frontmatter.type === "decision_rejected");
  const approved = related.some((e) => e.frontmatter.type === "decision_approved");

  let phase: DecisionPhase;
  let verdict: DecisionState["verdict"];
  if (rejected) {
    phase = "rejected";
    verdict = "rejected";
  } else if (approved) {
    phase = "approved";
    verdict = "approved";
  } else if (reviewCount >= 1) {
    phase = "reviewed";
    verdict = null;
  } else {
    phase = "proposed";
    verdict = null;
  }
  return { decisionId, title, phase, reviewCount, reviewed: reviewCount >= 1, verdict };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run test/decision/decision.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add governance/src/decision/decision.ts governance/test/decision/decision.test.ts
git commit -m "feat(governance): P2a Task 1 — derive decision gate-state (pure fold)"
```

---

## Task 2: Read & group a decision's events from the workspace

**Files:**

- Create: `governance/src/decision/readEvents.ts`
- Test: `governance/test/decision/readEvents.test.ts`

- [ ] **Step 1: Write the failing test**

`test/decision/readEvents.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents, eventsForDecision } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function mk(id: string, type: GovEvent["frontmatter"]["type"], related?: string[]): GovEvent {
  return {
    frontmatter: {
      id,
      type,
      source: "hermes",
      actor: "user",
      tags: [],
      ...(related ? { related_to: related } : {}),
    },
    body: id,
  };
}

describe("readAllEvents / eventsForDecision", () => {
  it("reads every written event back", async () => {
    await writeEvent(
      dir,
      mk("evt_20260531_120000_aaaa", "decision_proposed"),
      new Date(Date.UTC(2026, 4, 31, 12, 0, 0)),
    );
    await writeEvent(
      dir,
      mk("evt_20260531_120100_bbbb", "task_created"),
      new Date(Date.UTC(2026, 4, 31, 12, 1, 0)),
    );
    const all = await readAllEvents(dir);
    expect(all.map((e) => e.frontmatter.id).sort()).toEqual([
      "evt_20260531_120000_aaaa",
      "evt_20260531_120100_bbbb",
    ]);
  });

  it("groups proposal + related, sorted chronologically by id", async () => {
    const PID = "evt_20260531_120000_aaaa";
    await writeEvent(dir, mk(PID, "decision_proposed"), new Date(Date.UTC(2026, 4, 31, 12, 0, 0)));
    await writeEvent(
      dir,
      mk("evt_20260531_120200_cccc", "decision_review_recorded", [PID]),
      new Date(Date.UTC(2026, 4, 31, 12, 2, 0)),
    );
    await writeEvent(
      dir,
      mk("evt_20260531_120300_dddd", "task_created"),
      new Date(Date.UTC(2026, 4, 31, 12, 3, 0)),
    );
    const all = await readAllEvents(dir);
    const grp = eventsForDecision(all, PID);
    expect(grp.proposal?.frontmatter.id).toBe(PID);
    expect(grp.related.map((e) => e.frontmatter.id)).toEqual(["evt_20260531_120200_cccc"]);
  });

  it("returns empty list for a fresh workspace", async () => {
    expect(await readAllEvents(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/decision/readEvents.test.ts`
Expected: FAIL — module `readEvents.js` not found.

- [ ] **Step 3: Implement `src/decision/readEvents.ts`**

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvent, type GovEvent } from "../event/event.ts";

/** Read every L0 event under events/<YYYY-MM-DD>/*.md. Tolerant of a missing dir. */
export async function readAllEvents(workspaceDir: string): Promise<GovEvent[]> {
  const eventsDir = join(workspaceDir, "events");
  const out: GovEvent[] = [];
  let days: string[] = [];
  try {
    days = await readdir(eventsDir);
  } catch {
    return out;
  }
  for (const day of days.sort()) {
    if (day.startsWith(".")) continue;
    let files: string[] = [];
    try {
      files = await readdir(join(eventsDir, day));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      if (!f.endsWith(".md")) continue;
      out.push(parseEvent(await readFile(join(eventsDir, day, f), "utf8")));
    }
  }
  return out;
}

export interface DecisionGroup {
  proposal: GovEvent | null;
  related: GovEvent[]; // events whose related_to includes decisionId, chronological by id
}

/** Group a flat event list around one decision id. */
export function eventsForDecision(all: GovEvent[], decisionId: string): DecisionGroup {
  const proposal = all.find((e) => e.frontmatter.id === decisionId) ?? null;
  const related = all
    .filter(
      (e) =>
        e.frontmatter.id !== decisionId && (e.frontmatter.related_to ?? []).includes(decisionId),
    )
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  return { proposal, related };
}

/** All decision-proposal events in the workspace (chronological). */
export function proposalsOf(all: GovEvent[]): GovEvent[] {
  return all
    .filter((e) => e.frontmatter.type === "decision_proposed")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run test/decision/readEvents.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add governance/src/decision/readEvents.ts governance/test/decision/readEvents.test.ts
git commit -m "feat(governance): P2a Task 2 — read & group decision events"
```

---

## Task 3: Type 1 Guardian policy (the mechanized gate)

**Files:**

- Create: `governance/src/decision/guardian.ts`
- Test: `governance/test/decision/guardian.test.ts`

- [ ] **Step 1: Write the failing test**

`test/decision/guardian.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { canApprove, canReject, gateLabel } from "../../src/decision/guardian.js";
import type { DecisionState } from "../../src/decision/decision.js";

function state(over: Partial<DecisionState>): DecisionState {
  return {
    decisionId: "evt_x",
    title: "t",
    phase: "proposed",
    reviewCount: 0,
    reviewed: false,
    verdict: null,
    ...over,
  };
}

describe("Type 1 Guardian", () => {
  it("REFUSES approval of an un-reviewed decision (the INVARIANT #1 mechanization)", () => {
    const r = canApprove(state({ phase: "proposed", reviewed: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/external review/i);
  });

  it("ALLOWS approval once at least one external review exists", () => {
    const r = canApprove(state({ phase: "reviewed", reviewed: true, reviewCount: 1 }));
    expect(r.ok).toBe(true);
  });

  it("REFUSES re-approval after a terminal verdict", () => {
    expect(canApprove(state({ verdict: "approved", reviewed: true })).ok).toBe(false);
    expect(canApprove(state({ verdict: "rejected", reviewed: true })).ok).toBe(false);
  });

  it("ALLOWS rejection before a verdict, REFUSES after", () => {
    expect(canReject(state({ phase: "proposed" })).ok).toBe(true);
    expect(canReject(state({ verdict: "approved" })).ok).toBe(false);
  });

  it("gateLabel summarizes the pending gate", () => {
    expect(gateLabel(state({ phase: "proposed" }))).toMatch(/review/i);
    expect(gateLabel(state({ phase: "reviewed", reviewed: true }))).toMatch(/human|approval/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/decision/guardian.test.ts`
Expected: FAIL — module `guardian.js` not found.

- [ ] **Step 3: Implement `src/decision/guardian.ts`**

```typescript
import type { DecisionState } from "./decision.ts";

export interface GateDecision {
  ok: boolean;
  reason: string;
}

/** Type 1 Guardian: a decision may be approved ONLY if it has ≥1 external review
 *  and has no terminal verdict yet. This refusal mechanizes INVARIANT #1
 *  ("자동화 → 결정 레일 침투 금지": no Type 1 executes without external verification). */
export function canApprove(s: DecisionState): GateDecision {
  if (s.verdict) return { ok: false, reason: `decision already ${s.verdict}` };
  if (!s.reviewed)
    return {
      ok: false,
      reason: "Type 1 decision requires at least one external review before approval",
    };
  return { ok: true, reason: "reviewed; awaiting human approval" };
}

/** Rejection is allowed at any pre-verdict phase (a human may kill a proposal outright). */
export function canReject(s: DecisionState): GateDecision {
  if (s.verdict) return { ok: false, reason: `decision already ${s.verdict}` };
  return { ok: true, reason: "may be rejected" };
}

/** Human-readable label of the gate currently blocking the decision. */
export function gateLabel(s: DecisionState): string {
  switch (s.phase) {
    case "proposed":
      return "awaiting external review";
    case "reviewed":
      return "awaiting human approval";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run test/decision/guardian.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add governance/src/decision/guardian.ts governance/test/decision/guardian.test.ts
git commit -m "feat(governance): P2a Task 3 — Type 1 Guardian gate policy"
```

---

## Task 4: External Reviewer orchestration (injected ReviewFn)

**Files:**

- Create: `governance/src/decision/reviewer.ts`
- Test: `governance/test/decision/reviewer.test.ts`

- [ ] **Step 1: Write the failing test**

`test/decision/reviewer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordReview, type ReviewFn } from "../../src/decision/reviewer.js";

let dir: string;
const NOW = new Date(Date.UTC(2026, 4, 31, 13, 0, 0));
const DID = "evt_20260531_120000_aaaa";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-rev-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const okFn: ReviewFn = async (req) => ({
  verdict: "concerns",
  rationale: `reviewed ${req.title}`,
  reviewerModel: "codex",
});

describe("recordReview", () => {
  it("writes a review artifact AND a decision_review_recorded event linked to the decision", async () => {
    const r = await recordReview(
      dir,
      { decisionId: DID, title: "Adopt X", proposalBody: "body", authorModel: "claude" },
      okFn,
      NOW,
      0.5,
    );
    const review = await readFile(join(dir, "reviews", `${DID}.md`), "utf8");
    expect(review).toMatch(/reviewer_model: codex/);
    expect(review).toMatch(/verdict: concerns/);
    // a linked event was written
    const days = await readdir(join(dir, "events"));
    expect(days.length).toBe(1);
    expect(r.verdict).toBe("concerns");
    expect(r.reviewEventId).toMatch(/^evt_/);
  });

  it("REFUSES a review from the same model as the author (dual-verification invariant)", async () => {
    const sameModel: ReviewFn = async () => ({
      verdict: "endorse",
      rationale: "lgtm",
      reviewerModel: "claude",
    });
    await expect(
      recordReview(
        dir,
        { decisionId: DID, title: "X", proposalBody: "b", authorModel: "claude" },
        sameModel,
        NOW,
        0.5,
      ),
    ).rejects.toThrow(/different model/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/decision/reviewer.test.ts`
Expected: FAIL — module `reviewer.js` not found.

- [ ] **Step 3: Implement `src/decision/reviewer.ts`**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";

export interface ReviewRequest {
  decisionId: string;
  title: string;
  proposalBody: string;
  authorModel: string;
}

export interface ReviewResult {
  verdict: "endorse" | "concerns" | "object";
  rationale: string;
  reviewerModel: string;
}

/** Seam for the External Reviewer. Tests inject a deterministic fn; the live
 *  implementation (deferred follow-up) calls a model ≠ author with bounded retry. */
export type ReviewFn = (req: ReviewRequest) => Promise<ReviewResult>;

export interface RecordReviewResult {
  reviewEventId: string;
  reviewPath: string;
  verdict: ReviewResult["verdict"];
}

/** Run the injected reviewer, persist the review artifact, and append a linked
 *  decision_review_recorded L0 event. Enforces the different-model invariant. */
export async function recordReview(
  workspaceDir: string,
  req: ReviewRequest,
  reviewFn: ReviewFn,
  now: Date,
  rand: number,
): Promise<RecordReviewResult> {
  const result = await reviewFn(req);
  if (result.reviewerModel.trim() === req.authorModel.trim()) {
    throw new Error(
      `external review must use a different model than the author (got "${result.reviewerModel}" for both)`,
    );
  }

  const reviewsDir = join(workspaceDir, "reviews");
  await mkdir(reviewsDir, { recursive: true });
  const reviewPath = join(reviewsDir, `${req.decisionId}.md`);
  const artifact = matter.stringify(result.rationale, {
    decision_id: req.decisionId,
    verdict: result.verdict,
    reviewer_model: result.reviewerModel,
    author_model: req.authorModel,
  });
  await writeFile(reviewPath, artifact); // reviews are overwritable (latest review wins); the event log is the immutable record

  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_review_recorded",
      source: "reviewer",
      actor: result.reviewerModel,
      tags: ["decision", "review", `verdict:${result.verdict}`],
      related_to: [req.decisionId],
    },
    body: `External review (${result.reviewerModel}) of ${req.decisionId}: ${result.verdict}`,
  };
  await writeEvent(workspaceDir, evt, now);

  return { reviewEventId: evt.frontmatter.id, reviewPath, verdict: result.verdict };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run test/decision/reviewer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add governance/src/decision/reviewer.ts governance/test/decision/reviewer.test.ts
git commit -m "feat(governance): P2a Task 4 — External Reviewer orchestration (injected ReviewFn)"
```

---

## Task 5: Decision MCP command handlers

**Files:**

- Create: `governance/src/decision/handlers.ts`
- Test: `governance/test/decision/handlers.test.ts`

- [ ] **Step 1: Write the failing test (includes the CRITICAL done-criterion test)**

`test/decision/handlers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proposeDecision,
  requestReview,
  approve,
  reject,
  conflicts,
  why,
} from "../../src/decision/handlers.js";
import type { ReviewFn } from "../../src/decision/reviewer.js";
import { readAllEvents, eventsForDecision } from "../../src/decision/readEvents.js";

let dir: string;
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 4, 31, 12, 0, s)); // distinct timestamps → distinct event files
const rand = () => (n++ % 16) / 16;
const reviewer: ReviewFn = async () => ({
  verdict: "concerns",
  rationale: "needs a metric",
  reviewerModel: "codex",
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-dec-"));
  n = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("decision handlers", () => {
  it("CRITICAL: approve() REFUSES a proposed-but-unreviewed decision and writes NO decision_approved event", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const r = await approve(dir, { decisionId: id }, at(1), 0.2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/external review/i);
    const grp = eventsForDecision(await readAllEvents(dir), id);
    expect(grp.related.some((e) => e.frontmatter.type === "decision_approved")).toBe(false); // gate held
  });

  it("happy path: propose → request_review → approve writes the approval event", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const rev = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      reviewer,
      at(1),
      0.2,
    );
    expect(rev.verdict).toBe("concerns");
    const r = await approve(dir, { decisionId: id }, at(2), 0.3);
    expect(r.ok).toBe(true);
    const grp = eventsForDecision(await readAllEvents(dir), id);
    expect(grp.related.some((e) => e.frontmatter.type === "decision_approved")).toBe(true);
  });

  it("reject() records a rejection and blocks later approval", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt Y", body: "why" }, at(0), 0.1);
    expect((await reject(dir, { decisionId: id }, at(1), 0.2)).ok).toBe(true);
    expect((await approve(dir, { decisionId: id }, at(2), 0.3)).ok).toBe(false);
  });

  it("conflicts() lists decisions awaiting a gate (proposed or reviewed)", async () => {
    const a = await proposeDecision(dir, { title: "A", body: "" }, at(0), 0.1);
    await requestReview(dir, { decisionId: a.id, authorModel: "claude" }, reviewer, at(1), 0.2);
    await proposeDecision(dir, { title: "B", body: "" }, at(2), 0.3);
    const list = await conflicts(dir);
    expect(list.map((d) => d.title).sort()).toEqual(["A", "B"]);
    expect(list.find((d) => d.title === "A")?.phase).toBe("reviewed");
    expect(list.find((d) => d.title === "B")?.phase).toBe("proposed");
  });

  it("why() returns the full chronological trail", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    await requestReview(dir, { decisionId: id, authorModel: "claude" }, reviewer, at(1), 0.2);
    const trail = await why(dir, { decisionId: id });
    expect(trail.title).toBe("Adopt X");
    expect(trail.chain.map((c) => c.type)).toEqual([
      "decision_proposed",
      "decision_review_recorded",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/decision/handlers.test.ts`
Expected: FAIL — module `handlers.js` not found.

- [ ] **Step 3: Implement `src/decision/handlers.ts`**

```typescript
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision, proposalsOf } from "./readEvents.ts";
import { deriveDecisionState, type DecisionState } from "./decision.ts";
import { canApprove, canReject, gateLabel } from "./guardian.ts";
import { recordReview, type ReviewFn } from "./reviewer.ts";

export interface ProposeInput {
  title: string;
  body: string;
}
export interface ProposeResult {
  id: string;
  path: string;
}

/** /propose_decision — write a Type 1 decision_proposed L0 event. Body = "title\n\nbody". */
export async function proposeDecision(
  workspaceDir: string,
  input: ProposeInput,
  now: Date,
  rand: number,
): Promise<ProposeResult> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_proposed",
      source: "hermes",
      actor: "user",
      tags: ["decision", "type1"],
    },
    body: input.body ? `${input.title}\n\n${input.body}` : input.title,
  };
  const path = await writeEvent(workspaceDir, evt, now);
  return { id: evt.frontmatter.id, path };
}

async function loadState(
  workspaceDir: string,
  decisionId: string,
): Promise<{ state: DecisionState; proposal: GovEvent }> {
  const grp = eventsForDecision(await readAllEvents(workspaceDir), decisionId);
  if (!grp.proposal) throw new Error(`unknown decision: ${decisionId}`);
  return { state: deriveDecisionState(grp.proposal, grp.related), proposal: grp.proposal };
}

export interface ReviewInput {
  decisionId: string;
  authorModel: string;
}

/** /request_review — run the External Reviewer for a decision. */
export async function requestReview(
  workspaceDir: string,
  input: ReviewInput,
  reviewFn: ReviewFn,
  now: Date,
  rand: number,
) {
  const { state, proposal } = await loadState(workspaceDir, input.decisionId);
  if (state.verdict) throw new Error(`decision already ${state.verdict}; cannot review`);
  return recordReview(
    workspaceDir,
    {
      decisionId: input.decisionId,
      title: state.title,
      proposalBody: proposal.body,
      authorModel: input.authorModel,
    },
    reviewFn,
    now,
    rand,
  );
}

export interface GateResult {
  ok: boolean;
  reason: string;
  eventId?: string;
}

/** /approve <id> — human gate. Guarded: refuses unless reviewed and un-terminated. */
export async function approve(
  workspaceDir: string,
  input: { decisionId: string },
  now: Date,
  rand: number,
): Promise<GateResult> {
  const { state } = await loadState(workspaceDir, input.decisionId);
  const gate = canApprove(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_approved",
      source: "hermes",
      actor: "user",
      tags: ["decision", "approval"],
      related_to: [input.decisionId],
    },
    body: `Human approved ${input.decisionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { ok: true, reason: gate.reason, eventId: evt.frontmatter.id };
}

/** /reject <id> — human gate (negative). */
export async function reject(
  workspaceDir: string,
  input: { decisionId: string },
  now: Date,
  rand: number,
): Promise<GateResult> {
  const { state } = await loadState(workspaceDir, input.decisionId);
  const gate = canReject(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "decision_rejected",
      source: "hermes",
      actor: "user",
      tags: ["decision", "rejection"],
      related_to: [input.decisionId],
    },
    body: `Human rejected ${input.decisionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { ok: true, reason: gate.reason, eventId: evt.frontmatter.id };
}

export interface PendingDecision {
  decisionId: string;
  title: string;
  phase: DecisionState["phase"];
  gate: string;
}

/** /conflicts — decisions still awaiting a gate (proposed = needs review, reviewed = needs human). */
export async function conflicts(workspaceDir: string): Promise<PendingDecision[]> {
  const all = await readAllEvents(workspaceDir);
  const out: PendingDecision[] = [];
  for (const proposal of proposalsOf(all)) {
    const grp = eventsForDecision(all, proposal.frontmatter.id);
    const s = deriveDecisionState(proposal, grp.related);
    if (s.phase === "proposed" || s.phase === "reviewed") {
      out.push({ decisionId: s.decisionId, title: s.title, phase: s.phase, gate: gateLabel(s) });
    }
  }
  return out;
}

export interface TrailEntry {
  id: string;
  type: GovEvent["frontmatter"]["type"];
  actor: string;
  summary: string;
}
export interface DecisionTrail {
  decisionId: string;
  title: string;
  phase: DecisionState["phase"];
  chain: TrailEntry[];
}

/** /why <id> and /history <id> — the full chronological audit trail of a decision. */
export async function why(
  workspaceDir: string,
  input: { decisionId: string },
): Promise<DecisionTrail> {
  const grp = eventsForDecision(await readAllEvents(workspaceDir), input.decisionId);
  if (!grp.proposal) throw new Error(`unknown decision: ${input.decisionId}`);
  const s = deriveDecisionState(grp.proposal, grp.related);
  const chain: TrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id,
    type: e.frontmatter.type,
    actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { decisionId: s.decisionId, title: s.title, phase: s.phase, chain };
}

/** /history — alias of why (same trail). Kept distinct for command-surface parity. */
export const history = why;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run test/decision/handlers.test.ts`
Expected: PASS (5 tests — including the CRITICAL gate-held test).

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all PASS — 16 (P1) + 4 + 3 + 5 + 2 + 5 = **35 tests**.

- [ ] **Step 6: Commit**

```bash
git add governance/src/decision/handlers.ts governance/test/decision/handlers.test.ts
git commit -m "feat(governance): P2a Task 5 — decision MCP handlers (gate enforced)"
```

---

## Task 6: Register MCP tools + workspace SSOT docs

**Files:**

- Modify: `governance/src/mcp/server.ts`
- Create: `governance/workspace/agents/type1-guardian.md`
- Create: `governance/workspace/agents/external-reviewer.md`
- Modify: `governance/workspace/interfaces/MCP.md`

- [ ] **Step 1: Register the 7 new tools in `server.ts`**

Add imports and a placeholder `ReviewFn` at the boundary, then register the tools. Insert after the existing `observations` registration (before `server.connect`):

```typescript
import {
  proposeDecision,
  requestReview,
  approve,
  reject,
  conflicts,
  why,
  history,
} from "../decision/handlers.ts";
import type { ReviewFn } from "../decision/reviewer.ts";

// 작성자(author) 모델 / 리뷰어 모델은 env로 주입. 라이브 모델 호출(다른 모델 적대 검토)은
// P2a 범위 밖(별도 follow-up) — 여기서는 플레이스홀더 리뷰어로 게이트 흐름만 실증한다.
const AUTHOR_MODEL = process.env.BOULE_AUTHOR_MODEL ?? "claude";
const REVIEWER_MODEL = process.env.BOULE_REVIEWER_MODEL ?? "external-stub";
const placeholderReview: ReviewFn = async (req) => ({
  verdict: "concerns",
  rationale: `[placeholder reviewer — live different-model wiring deferred] reviewed "${req.title}".`,
  reviewerModel: REVIEWER_MODEL,
});

server.registerTool(
  "propose_decision",
  {
    description: "Type 1(비가역) 결정을 decision_proposed L0 이벤트로 제안",
    inputSchema: { title: z.string(), body: z.string().default("") },
  },
  async ({ title, body }) => {
    const r = await proposeDecision(WORKSPACE, { title, body }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: `decision proposed: ${r.id} (needs external review)` }],
    };
  },
);

server.registerTool(
  "request_review",
  {
    description: "결정에 대해 External Reviewer(다른 모델) 적대적 검토를 기록",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await requestReview(
      WORKSPACE,
      { decisionId, authorModel: AUTHOR_MODEL },
      placeholderReview,
      nowFn(),
      randFn(),
    );
    return {
      content: [{ type: "text", text: `review recorded: ${r.verdict} (${r.reviewEventId})` }],
    };
  },
);

server.registerTool(
  "approve",
  {
    description: "결정 사람 승인(게이트) — 외부검토 없으면 거부",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await approve(WORKSPACE, { decisionId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `approved: ${decisionId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "reject",
  {
    description: "결정 사람 반려(게이트)",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await reject(WORKSPACE, { decisionId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `rejected: ${decisionId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "conflicts",
  { description: "게이트 대기 중 결정 목록(검토대기/승인대기)", inputSchema: {} },
  async () => {
    const list = await conflicts(WORKSPACE);
    const text = list.length
      ? list.map((d) => `- ${d.decisionId} "${d.title}" — ${d.gate}`).join("\n")
      : "no pending decisions";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "why",
  { description: "결정의 감사 추적(이벤트 체인)", inputSchema: { decisionId: z.string() } },
  async ({ decisionId }) => {
    const t = await why(WORKSPACE, { decisionId });
    const text =
      `${t.title} [${t.phase}]\n` +
      t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "history",
  { description: "결정 이력(why의 별칭)", inputSchema: { decisionId: z.string() } },
  async ({ decisionId }) => {
    const t = await history(WORKSPACE, { decisionId });
    const text =
      `${t.title} [${t.phase}]\n` +
      t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);
```

- [ ] **Step 2: Typecheck the server wiring**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Create `workspace/agents/type1-guardian.md`**

```markdown
---
name: type1-guardian
scale: immediate
writes: [] # 차단/보고만 — 직접 쓰기 권한 없음
---

# Type 1 Guardian

`decision_proposed`(Type 1, 비가역) 이벤트를 가로채 **외부검증 + 사람 게이트**를 강제한다.
정책은 순수 함수 `src/decision/guardian.ts`(`canApprove`/`canReject`)로 기계화됨:

- 외부 리뷰(`decision_review_recorded`) ≥1 이 없으면 `approve`를 **거부**한다.
- 종결 verdict(approved/rejected) 이후 재승인/재반려 거부.

이것이 INVARIANT #1("자동화 → 결정 레일 침투 금지")의 기계적 강화다. 에이전트는
결정을 **제안만** 하고, 승인/반려는 사람(`actor: user`)의 MCP 명령으로만 기록된다.
```

- [ ] **Step 4: Create `workspace/agents/external-reviewer.md`**

```markdown
---
name: external-reviewer
scale: on-type1
writes: [reviews/]
---

# External Reviewer

Type 1 결정에 대해 **작성자와 다른 모델**로 적대적 검토를 수행하고 결과를
`reviews/<decision_id>.md` + `decision_review_recorded` 이벤트로 기록한다
(`src/decision/reviewer.ts`).

- 작성자 모델 == 리뷰어 모델이면 검토 거부(이중검증 무효 방지).
- **라이브 모델 호출은 deferred follow-up**: 현재 서버는 플레이스홀더 리뷰어로
  게이트 흐름만 실증. 실제 다른-모델 호출(예: `claude -p` / `omc ask`)은
  bounded retry(INVARIANT #5)와 함께 별도 태스크에서 배선.
```

- [ ] **Step 5: Update `workspace/interfaces/MCP.md`** — append the new command set under the existing P1 list:

```markdown
## P2a — Decision governance commands

- `propose_decision { title, body }` — Type 1 결정 제안 → `decision_proposed` 이벤트.
- `request_review { decisionId }` — External Reviewer(다른 모델) 검토 기록.
- `approve { decisionId }` — 사람 승인 게이트. **외부 리뷰 없으면 거부**.
- `reject { decisionId }` — 사람 반려 게이트.
- `conflicts {}` — 게이트 대기 결정(검토대기/승인대기) 목록.
- `why { decisionId }` / `history { decisionId }` — 결정 감사 추적(이벤트 체인).

게이트 정책 = `src/decision/guardian.ts`. 사람 게이트(approve/reject)는 `actor: user`
이벤트로만 기록 — 에이전트 자동 실행 불가(INVARIANT #1).
```

- [ ] **Step 6: Commit**

```bash
git add governance/src/mcp/server.ts governance/workspace/agents/type1-guardian.md \
        governance/workspace/agents/external-reviewer.md governance/workspace/interfaces/MCP.md
git commit -m "feat(governance): P2a Task 6 — register decision MCP tools + agent specs"
```

---

## Task 7: Headless MCP round-trip + P2a verification + done-line

**Files:** (검증 전용 + `docs/decisions.md` 한 줄)

- [ ] **Step 1: Full governance suite**

Run: `pnpm test`
Expected: **35 passed** (P1 16 + decision 19).

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Headless MCP round-trip — empirically demonstrate the gate**

Write `/tmp/boule-p2a-smoke.jsonl` (newline-delimited JSON-RPC) that proves the done-criterion: propose → approve-refused → request_review → approve-ok.

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"propose_decision","arguments":{"title":"Adopt X","body":"why"}}}
```

Run (capture the proposed id from id:3, then a second pass for approve→review→approve):

```bash
cd governance
node --experimental-strip-types src/mcp/server.ts < /tmp/boule-p2a-smoke.jsonl 2>/dev/null
```

Expected: `tools/list` includes `propose_decision`, `request_review`, `approve`, `reject`, `conflicts`, `why`, `history`; `propose_decision` returns `decision proposed: evt_… (needs external review)`. Then craft a follow-up jsonl using that id calling `approve` (expect `REFUSED: …external review…`), `request_review` (expect `review recorded: concerns`), `approve` (expect `approved: …`). **This is the headless equivalent of the P1 round-trip and stands in for the GUI smoke.** Record the observed transcript.

> Note: each `node` invocation is a fresh process over a fresh stdin batch; because the workspace is on disk, the decision id persists across invocations. Use `BOULE_WORKSPACE=$(mktemp -d)` if you want an isolated throwaway workspace for the smoke.

- [ ] **Step 4: bindings drift = 0 (no app code touched)**

Run: `git diff --stat HEAD~7 -- src/bindings.ts` (from repo root)
Expected: empty — P2a touched no Tauri command/event (INVARIANT #4 not in scope).

- [ ] **Step 5: Record done-line in `docs/decisions.md`** (append-only, honest):

One Type 2 line, e.g.: _"거버넌스 Boule P2a — 결정 거버넌스 코어(2026-05-31): Type 1 Guardian가 `approve`를 외부리뷰 없으면 기계적으로 거부(INVARIANT #1 기계화), External Reviewer 오케스트레이션(주입 ReviewFn, 다른-모델 강제) + MCP propose/request_review/approve/reject/conflicts/why/history. vitest 35 pass·tsc 0·헤드리스 MCP 라운드트립(propose→approve거부→review→approve승인)·bindings drift 0. deferred: 라이브 리뷰어 모델 배선·ADR 파일 ingress(P3)·P2b 인앱 승인 카드. critic ACCEPT 후 기록."_

- [ ] **Step 6: Critic pass (separate reviewer) — NOT self-approve**

Dispatch a critic/code-reviewer agent against the P2a diff. Required ACCEPT (0 BLOCKER/MAJOR) before the final commit. Focus: INVARIANT #1 mechanization is real (no path writes `decision_approved` without a prior review), #4 (no bindings drift), #5 (placeholder reviewer documented; live path flagged), determinism (now/rand/reviewFn injected).

- [ ] **Step 7: Commit**

```bash
git add docs/decisions.md
git commit -m "docs(governance): record P2a decision-governance-core done-criteria"
```

---

## Deferred follow-ups (tracked, NOT in P2a)

- **Live External Reviewer wiring** — replace `placeholderReview` with a real different-model call (`claude -p` / `omc ask <other-model>`), bounded retry + jitter + terminal-failure surfacing (INVARIANT #5), PII/secret-free logs. Own task/PR. **Carry these critic MINORs into this task:** (a) normalize the same-model check to a canonical model-id (currently trim-only in `reviewer.ts:41` — misses case/version drift); (b) move dual-verification into the _gate_ — `deriveDecisionState`/`canApprove` should count only review events whose recorded `reviewer_model ≠ author_model`, so a forged same-model review event in the log can't satisfy the gate (today enforcement is write-time-only, re-derivable only because `recordReview` is the single writer); (c) enforce spec §5.1's **≥2 independent models** (P2a mechanizes ≥1); (d) add an id-shape assertion (`/^evt_\d{8}_\d{6}_[0-9a-f]{4}$/`) before any `decisionId` is interpolated into a `reviews/<id>.md` path (defense-in-depth; not exploitable today since `loadState` gates it).
- **Robustness:** `why`/`history`/`approve`/`reject`/`request_review` on an **unknown decisionId** currently throw a raw error to the MCP transport (server tool callbacks don't catch `loadState`'s throw). Consider a clean not-found result. Add a test.
- **Identity:** the human gate records `actor: "user"` hardcoded — the "human" guarantee rests on the transport (a human typed the command in Hermes), not code identity. Matches P1's trust model; revisit if/when authenticated identity is needed.
- **ADR-file ingress** — `services/index` parses `docs/adr/*.md` → `decision_proposed` (spec §2.2); part of P3 (Postgres+pgvector).
- **P2b — work-radar interactive approval card** — `hermes-agent:ask-user` event + `hermes_ask_user_respond` specta command + Hermes panel shadcn card (spec §5.2/§5.3). Separate plan `…-p2b.md`; needs `bindings.ts` regen + in-app GUI smoke (currently blocked by dev-DB migration skew — see P1 plan banner).

---

## Self-Review (작성자 체크)

- **Spec coverage:** §1.2 Type 1/2 → Tasks 0/1/3 (Type 1 mechanized; Type 2 left to existing decisions.md auto-flow). §5.1 command set → Task 6 (`propose_decision`/`approve`/`reject`/`conflicts`/`why`/`history`; `ask_user`/`send_file`/`hypotheses`/`principles` deferred to P2b/P3/P4). §6 INVARIANTs → boundaries box + Task 7 Steps 4/6. §3 agents (Guardian, External Reviewer) → Tasks 3/4 + specs in Task 6. Gateway `isType1Candidate` (P1) → consumed conceptually; P2a ingress is explicit `propose_decision`.
- **Placeholder scan:** no "TBD/TODO/handle errors" — every code step is complete. The `placeholderReview` is an _intentional, documented_ seam (not a plan placeholder); its replacement is an explicit deferred task.
- **Type consistency:** `DecisionState`/`DecisionPhase` (Task 1) reused verbatim in Tasks 3/5; `ReviewFn`/`ReviewRequest`/`ReviewResult` (Task 4) reused in Task 5/6; `eventsForDecision`/`readAllEvents`/`proposalsOf` (Task 2) reused in Task 5. `generateId(prefix, now, rand)` / `writeEvent(dir, evt, now)` match P1 signatures. Test imports use `.js`, runtime imports `.ts` (P1 trap honored).

```

```
