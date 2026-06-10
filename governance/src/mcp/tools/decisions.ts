import { z } from "zod";
import {
  proposeDecision,
  requestReview,
  approve,
  reject,
  conflicts,
  why,
  history,
} from "../../decision/handlers.ts";
import { normalizeModelId } from "../../decision/modelId.ts";
import type { ReviewerEntry } from "../../decision/reviewer.ts";
import { okOrRefused } from "../response.ts";
import type { ToolContext } from "./context.ts";

export type DecisionDeps = {
  authorModel: string;
  reviewers: ReviewerEntry[];
  quorum: number;
  quorumWarning: string | null;
};

/** Type-1 decision governance tools: propose_decision, request_review, approve(verdict),
 *  reject(verdict), conflicts, why, history. */
export function registerDecisionTools(ctx: ToolContext, deps: DecisionDeps): void {
  const { server, registerVerdictTool, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;
  const { authorModel: AUTHOR_MODEL, reviewers, quorum: QUORUM, quorumWarning } = deps;

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
      const res = await requestReview(
        WORKSPACE,
        { decisionId, authorModel: AUTHOR_MODEL },
        reviewers,
        nowFn(),
        randFn(),
      );
      const distinctModels = new Set(
        res.recorded.map((r) => r.reviewerBackend ?? normalizeModelId(r.reviewerModel)),
      ).size;
      const parts = [
        `recorded: ${res.recorded.length} from ${reviewers.length} reviewer(s); distinct actual reviewers: ${distinctModels}/${QUORUM} (quorum)`,
      ];
      if (res.skipped.length)
        parts.push(`skipped: ${res.skipped.map((s) => s.reviewerModel).join(",")}`);
      if (res.failures.length)
        parts.push(`failed: ${res.failures.map((f) => f.reviewerModel).join(",")}`);
      // Surface a silent fake-quorum right where the operator reads the distinct-model count.
      if (quorumWarning) parts.push(quorumWarning);
      return { content: [{ type: "text", text: parts.join(" | ") }] };
    },
  );

  // verdict tool — gated off for executor-role sessions (structural INVARIANT #1)
  // prettier-ignore
  registerVerdictTool(
  "approve",
  {
    description: "결정 사람 승인(게이트) — 외부검토 없으면 거부",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await approve(WORKSPACE, { decisionId }, nowFn(), randFn(), QUORUM);
    return okOrRefused("approved", { ok: r.ok, eventId: decisionId, reason: r.reason });
  },
);

  // verdict tool — gated off for executor-role sessions (structural INVARIANT #1)
  // prettier-ignore
  registerVerdictTool(
  "reject",
  {
    description: "결정 사람 반려(게이트)",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await reject(WORKSPACE, { decisionId }, nowFn(), randFn());
    return okOrRefused("rejected", { ok: r.ok, eventId: decisionId, reason: r.reason });
  },
);

  server.registerTool(
    "conflicts",
    { description: "게이트 대기 중 결정 목록(검토대기/승인대기)", inputSchema: {} },
    async () => {
      const list = await conflicts(WORKSPACE, QUORUM);
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
      const t = await why(WORKSPACE, { decisionId }, QUORUM);
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
      const t = await history(WORKSPACE, { decisionId }, QUORUM);
      const text =
        `${t.title} [${t.phase}]\n` +
        t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}
