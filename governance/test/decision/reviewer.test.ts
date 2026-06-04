import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordReview, type ReviewFn } from "../../src/decision/reviewer.js";

let dir: string;
const NOW = new Date(Date.UTC(2026, 4, 31, 13, 0, 0));
const DID = "evt_20260531_120000_aaaa";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-rev-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const okFn: ReviewFn = async (req) => ({ verdict: "concerns", rationale: `reviewed ${req.title}`, reviewerModel: "codex" });

describe("recordReview", () => {
  it("writes a review artifact AND a decision_review_recorded event linked to the decision", async () => {
    const r = await recordReview(dir, { decisionId: DID, title: "Adopt X", proposalBody: "body", authorModel: "claude" }, okFn, NOW, 0.5);
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
    const sameModel: ReviewFn = async () => ({ verdict: "endorse", rationale: "lgtm", reviewerModel: "claude" });
    await expect(
      recordReview(dir, { decisionId: DID, title: "X", proposalBody: "b", authorModel: "claude" }, sameModel, NOW, 0.5),
    ).rejects.toThrow(/different model/i);
  });

  it("persists a normalized author_model tag on the review event", async () => {
    await recordReview(
      dir,
      { decisionId: DID, title: "Adopt X", proposalBody: "body", authorModel: "Claude" },
      okFn, // returns reviewerModel "codex"
      NOW,
      0.5,
    );
    const days = await readdir(join(dir, "events"));
    const files = await readdir(join(dir, "events", days[0]));
    const evtRaw = await readFile(join(dir, "events", days[0], files[0]), "utf8");
    expect(evtRaw).toMatch(/author_model:claude/); // normalized (lowercased)
  });

  it("REFUSES a malformed decisionId before touching the filesystem (path-traversal guard)", async () => {
    await expect(
      recordReview(
        dir,
        { decisionId: "../../etc/passwd", title: "X", proposalBody: "b", authorModel: "claude" },
        okFn,
        NOW,
        0.5,
      ),
    ).rejects.toThrow(/invalid decisionId/i);
  });

  it("REFUSES same model after normalization (case/version drift)", async () => {
    const drift: ReviewFn = async () => ({ verdict: "endorse", rationale: "x", reviewerModel: "Claude:latest" });
    await expect(
      recordReview(
        dir,
        { decisionId: DID, title: "X", proposalBody: "b", authorModel: "claude" },
        drift,
        NOW,
        0.5,
      ),
    ).rejects.toThrow(/different model/i);
  });
});
