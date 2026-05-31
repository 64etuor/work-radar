import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { normalizeModelId } from "./modelId.ts";

const DECISION_ID_RE = /^evt_\d{8}_\d{6}_[0-9a-f]{4}$/;

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
  if (!DECISION_ID_RE.test(req.decisionId)) {
    // MINOR d: refuse before any reviews/<id>.md path is built (path-traversal defense-in-depth)
    throw new Error(`invalid decisionId shape: ${JSON.stringify(req.decisionId)}`);
  }
  const result = await reviewFn(req);
  if (normalizeModelId(result.reviewerModel) === normalizeModelId(req.authorModel)) {
    throw new Error(
      `external review must use a different model than the author (got "${result.reviewerModel}" vs author "${req.authorModel}")`,
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
      tags: [
        "decision",
        "review",
        `verdict:${result.verdict}`,
        `author_model:${normalizeModelId(req.authorModel)}`, // re-derivable half of the (author,reviewer) pair
      ],
      related_to: [req.decisionId],
    },
    body: `External review (${result.reviewerModel}) of ${req.decisionId}: ${result.verdict}`,
  };
  await writeEvent(workspaceDir, evt, now);

  return { reviewEventId: evt.frontmatter.id, reviewPath, verdict: result.verdict };
}
