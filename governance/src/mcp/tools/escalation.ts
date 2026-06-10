import { z } from "zod";
import { escalate } from "../../escalate/escalate.ts";
import { pendingEscalations } from "../../escalate/pending.ts";
import { chooseOption } from "../../decision/handlers.ts";
import type { ToolContext } from "./context.ts";

/** Escalation round-trip tools: escalate, pending_escalations, choose(verdict). */
export function registerEscalationTools(ctx: ToolContext): void {
  const { server, registerVerdictTool, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;

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
        agent_recommendation: z.string().optional(),
        related_task_id: z.string().optional(),
      },
    },
    async ({ question, options, ambiguity_kind, agent_recommendation, related_task_id }) => {
      const r = await escalate(
        WORKSPACE,
        {
          question,
          options,
          ambiguityKind: ambiguity_kind as never,
          agentRecommendation: agent_recommendation,
          // Structural task linkage: a conductor-spawned session's mcp.json sets BOULE_TASK_ID and
          // it takes PRECEDENCE over the model-supplied argument — the conductor knows which task
          // this session runs; the model can omit, garble, or even mis-cite it (live 2026-06-10:
          // step5's relatedTaskId leaked into the question text). The argument remains the path for
          // manual/non-conductor sessions, where no env binding exists.
          relatedTaskId: process.env.BOULE_TASK_ID ?? related_task_id,
        },
        nowFn(),
        randFn(),
      );
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  // v2 slice1B — READ-ONLY: the outbound Telegram adapter reads pending escalations from here
  // (no markdown parsing in Python; the token format stays in TS).
  server.registerTool(
    "pending_escalations",
    {
      description:
        "미해소 Type 0 에스컬레이션 목록 (decision_blocked, verdict 없음) — read-only, bridge용",
      inputSchema: {},
    },
    async () => {
      const list = await pendingEscalations(WORKSPACE);
      return { content: [{ type: "text", text: JSON.stringify(list) }] };
    },
  );

  // v2 slice1 — BRIDGE/HUMAN-ONLY: only the Telegram bridge calls this, on an exact token match.
  // Human-gated (actor:user) but NOT review-gated — a Type 0 tap is a direction-pick, not an ADR approval.
  // verdict tool — gated off for executor-role sessions (structural INVARIANT #1)
  // prettier-ignore
  registerVerdictTool(
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
    return { content: [{ type: "text", text: r.ok ? `chosen: ${r.chosenOption} for ${decision_id}` : `NO-OP: ${r.reason}` }] };
  },
);
}
