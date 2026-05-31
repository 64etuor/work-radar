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
