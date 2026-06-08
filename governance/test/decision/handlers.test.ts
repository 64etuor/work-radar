import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proposeDecision, requestReview, approve, reject, conflicts, why,
} from "../../src/decision/handlers.js";
import type { ReviewFn } from "../../src/decision/reviewer.js";
import { readAllEvents, eventsForDecision } from "../../src/decision/readEvents.js";
import { defaultReviewPrompt, liveReviewChain, parseVerdict, type ChildLike, type SpawnLike } from "../../src/decision/liveReviewer.js";
import type { BackendSpec } from "../../src/backends/config.js";

let dir: string;
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 4, 31, 12, 0, s)); // distinct timestamps → distinct event files
const rand = () => (n++ % 16) / 16;
const reviewer: ReviewFn = async () => ({ verdict: "concerns", rationale: "needs a metric", reviewerModel: "codex" });
const codexFn: ReviewFn = async () => ({ verdict: "concerns", rationale: "c", reviewerModel: "codex" });
const geminiFn: ReviewFn = async () => ({ verdict: "endorse", rationale: "g", reviewerModel: "gemini" });
const boomFn: ReviewFn = async () => { throw new Error("model unavailable"); };

type ChainBehavior =
  | { kind: "ok"; stdout: string }
  | { kind: "exit"; code: number; stderr: string };

function chainReviewFn(chain: BackendSpec[], behaviors: Record<string, ChainBehavior[]>): ReviewFn {
  const spawn: SpawnLike = (command) => {
    const b = behaviors[command]?.shift();
    if (!b) throw new Error(`unexpected reviewer command: ${command}`);
    const cbs = {
      stdout: [] as ((c: string) => void)[],
      stderr: [] as ((c: string) => void)[],
      close: [] as ((c: number | null) => void)[],
      error: [] as ((e: Error) => void)[],
    };
    const child: ChildLike = {
      stdout: { on: (_e, cb) => cbs.stdout.push(cb as (c: string) => void) },
      stderr: { on: (_e, cb) => cbs.stderr.push(cb as (c: string) => void) },
      stdin: {
        write: () => {},
        end: () =>
          queueMicrotask(() => {
            if (b.kind === "ok") {
              cbs.stdout.forEach((f) => f(b.stdout));
              cbs.close.forEach((f) => f(0));
            } else {
              cbs.stderr.forEach((f) => f(b.stderr));
              cbs.close.forEach((f) => f(b.code));
            }
          }),
      },
      on: (e: "close" | "error", cb: (a: never) => void) => {
        if (e === "close") cbs.close.push(cb as (c: number | null) => void);
        else cbs.error.push(cb as (e: Error) => void);
      },
      kill: () => {},
    };
    return child;
  };
  return liveReviewChain({
    spawn,
    command: "",
    buildArgs: () => [],
    buildPrompt: defaultReviewPrompt,
    reviewerModel: "unused",
    parse: parseVerdict,
    timeoutMs: 1000,
    maxAttempts: 1,
    backoffMs: 1,
    sleep: async () => {},
    setTimer: () => () => {},
    rand: () => 0,
    chain,
    resolveBackend: (spec) => ({
      command: spec.provider === "command" ? spec.command ?? "command" : spec.provider,
      args: [],
      reviewerModel: spec.model ?? (spec.provider === "command" ? spec.command ?? "command" : spec.provider),
    }),
  });
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-dec-")); n = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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
    const rev = await requestReview(dir, { decisionId: id, authorModel: "claude" }, [{ model: "codex", fn: reviewer }], at(1), 0.2);
    expect(rev.recorded[0].verdict).toBe("concerns");
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
    await requestReview(dir, { decisionId: a.id, authorModel: "claude" }, [{ model: "codex", fn: reviewer }], at(1), 0.2);
    await proposeDecision(dir, { title: "B", body: "" }, at(2), 0.3);
    const list = await conflicts(dir);
    expect(list.map((d) => d.title).sort()).toEqual(["A", "B"]);
    expect(list.find((d) => d.title === "A")?.phase).toBe("reviewed");
    expect(list.find((d) => d.title === "B")?.phase).toBe("proposed");
  });

  it("quorum 2: approve REFUSES after a single distinct review (gate held)", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    await requestReview(dir, { decisionId: id, authorModel: "claude" }, [{ model: "codex", fn: reviewer }], at(1), 0.2);
    const r = await approve(dir, { decisionId: id }, at(5), 0.5, 2); // quorum=2
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/external review/i);
  });

  it("batch: two distinct models recorded → quorum 2 gate opens", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "codex", fn: codexFn }, { model: "gemini", fn: geminiFn }],
      at(1), 0.2,
    );
    expect(res.recorded.length).toBe(2);
    expect(res.failures.length).toBe(0);
    expect(res.skipped.length).toBe(0);
    const r = await approve(dir, { decisionId: id }, at(10), 0.9, 2); // quorum 2
    expect(r.ok).toBe(true);
  });

  it("batch: partial failure records the success and reports the failure", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "codex", fn: codexFn }, { model: "gemini", fn: boomFn }],
      at(1), 0.2,
    );
    expect(res.recorded.length).toBe(1);
    expect(res.failures.length).toBe(1);
    expect(res.failures[0].reviewerModel).toBe("gemini");
    expect(res.failures[0].error).toMatch(/unavailable|exhausted|model/i);
    const r = await approve(dir, { decisionId: id }, at(10), 0.9, 2); // quorum 2 unmet
    expect(r.ok).toBe(false);
  });

  it("R4: exhausted reviewer chain contributes no verdict and quorum 2 stays blocked", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "human" },
      [
        {
          model: "reviewer-chain-1:claude",
          fn: chainReviewFn([{ provider: "claude" }], {
            claude: [{ kind: "ok", stdout: '{"verdict":"concerns","rationale":"c"}' }],
          }),
        },
        {
          model: "reviewer-chain-2:codex",
          fn: chainReviewFn([{ provider: "codex" }, { provider: "command", command: "gemini" }], {
            codex: [{ kind: "exit", code: 1, stderr: "quota exceeded" }],
            gemini: [{ kind: "exit", code: 1, stderr: "insufficient_quota" }],
          }),
        },
      ],
      at(1),
      0.2,
    );
    expect(res.recorded.length).toBe(1);
    expect(res.failures.length).toBe(1);
    const r = await approve(dir, { decisionId: id }, at(10), 0.9, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/external review/i);
    const grp = eventsForDecision(await readAllEvents(dir), id);
    expect(grp.related.some((e) => e.frontmatter.type === "decision_approved")).toBe(false);
  });

  it("batch: a reviewer equal to the author is SKIPPED, not aborted", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "claude", fn: codexFn }, { model: "codex", fn: codexFn }],
      at(1), 0.2,
    );
    expect(res.skipped.length).toBe(1);
    expect(res.skipped[0].reviewerModel).toBe("claude");
    expect(res.recorded.length).toBe(1); // codex still recorded
  });

  it("batch: duplicate model entries count as ONE toward quorum (quorum can't be gamed)", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "codex", fn: codexFn }, { model: "codex", fn: codexFn }],
      at(1), 0.2,
    );
    expect(res.recorded.length).toBe(2); // both events written...
    const r = await approve(dir, { decisionId: id }, at(10), 0.9, 2); // ...but quorum 2 NOT met (1 distinct model)
    expect(r.ok).toBe(false);
  });

  it("batch: an empty reviewer list records nothing and leaves the decision unreviewed", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(dir, { decisionId: id, authorModel: "claude" }, [], at(1), 0.2);
    expect(res.recorded.length).toBe(0);
    expect(res.failures.length).toBe(0);
    expect(res.skipped.length).toBe(0);
    const r = await approve(dir, { decisionId: id }, at(10), 0.9); // default quorum 1, still unmet
    expect(r.ok).toBe(false);
  });

  it("why() returns the full chronological trail", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    await requestReview(dir, { decisionId: id, authorModel: "claude" }, [{ model: "codex", fn: reviewer }], at(1), 0.2);
    const trail = await why(dir, { decisionId: id });
    expect(trail.title).toBe("Adopt X");
    expect(trail.chain.map((c) => c.type)).toEqual(["decision_proposed", "decision_review_recorded"]);
  });
});
