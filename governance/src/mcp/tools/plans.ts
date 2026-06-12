import { z } from "zod";
import {
  proposePlan,
  acceptPlan,
  revisePlan,
  completePlan,
  archivePlan,
  supersedePlan,
  listPlans,
  planTrail,
  checklessStepWarning,
} from "../../plan/handlers.ts";
import { okOrRefused, plainText } from "../response.ts";
import type { ToolContext } from "./context.ts";

/** Plan lifecycle tools: propose_plan, accept_plan(verdict), revise_plan, complete_plan,
 *  archive_plan, supersede_plan, plans, plan. */
export function registerPlanTools(ctx: ToolContext): void {
  const { server, registerVerdictTool, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;

  // ── Phase B: Plan lifecycle + Planner ────────────────────────────────────────
  // propose_plan = the Planner (propose-only). accept_plan = the human gate. The Planner has
  // no tool that accepts a plan → INVARIANT #1 self-approval impossibility is structural.
  server.registerTool(
    "propose_plan",
    {
      description:
        "Planner: intent + 단계 목록을 draft plan_proposed 이벤트 하나로 기록 (propose-only). specId=연결할 spec(선택)",
      inputSchema: {
        intent: z.string(),
        steps: z.array(
          z.union([
            z.string(),
            z.object({
              text: z.string(),
              difficulty: z.enum(["trivial", "standard", "hard"]).optional(),
              check: z
                .object({
                  command: z.string().optional(),
                  artifact: z.string().optional(),
                  // explicit "a human certifies this step" (suppresses the accept warning;
                  // still demotes the plan from auto-accept and routes to needs_human).
                  kind: z.literal("human").optional(),
                })
                .optional(),
            }),
          ]),
        ),
        specId: z.string().optional(),
      },
    },
    async ({ intent, steps, specId }) => {
      const r = await proposePlan(WORKSPACE, { intent, steps, specId }, nowFn(), randFn());
      return { content: [{ type: "text", text: `plan proposed (draft): ${r.planId}` }] };
    },
  );

  // verdict tool — gated off for executor-role sessions (structural INVARIANT #1)
  // prettier-ignore
  registerVerdictTool(
  "accept_plan",
  { description: "사람 게이트: plan을 active로 (draft/needs_revision→active, actor=user)", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const r = await acceptPlan(WORKSPACE, { planId }, nowFn(), randFn());
    if (!r.ok) return okOrRefused("accepted", r);
    // Human accept stays allowed for checkless plans — but say WHICH steps a machine cannot
    // certify (P2a), so the needs_human park later is an announced cost, not a silent dead-end.
    const warning = await checklessStepWarning(WORKSPACE, planId);
    const ok = okOrRefused("accepted", r);
    return warning ? plainText(`${ok.content[0].text}\n${warning}`) : ok;
  },
);

  server.registerTool(
    "revise_plan",
    {
      description: "plan을 needs_revision으로 (active→needs_revision, 사유 기록)",
      inputSchema: { planId: z.string(), reason: z.string() },
    },
    async ({ planId, reason }) => {
      const r = await revisePlan(WORKSPACE, { planId, reason }, nowFn(), randFn());
      return okOrRefused("revision requested", r);
    },
  );

  server.registerTool(
    "complete_plan",
    {
      description: "plan을 completed로 (active→completed, terminal)",
      inputSchema: { planId: z.string() },
    },
    async ({ planId }) => {
      const r = await completePlan(WORKSPACE, { planId }, nowFn(), randFn());
      return okOrRefused("completed", r);
    },
  );

  server.registerTool(
    "archive_plan",
    { description: "plan을 archived로 (terminal)", inputSchema: { planId: z.string() } },
    async ({ planId }) => {
      const r = await archivePlan(WORKSPACE, { planId }, nowFn(), randFn());
      return okOrRefused("archived", r);
    },
  );

  server.registerTool(
    "supersede_plan",
    {
      description:
        "plan을 superseded로 (새 plan이 대체, terminal). supersededBy=대체하는 새 plan id (필수)",
      inputSchema: { planId: z.string(), supersededBy: z.string() },
    },
    async ({ planId, supersededBy }) => {
      const r = await supersedePlan(WORKSPACE, { planId, supersededBy }, nowFn(), randFn());
      return okOrRefused("superseded", r);
    },
  );

  server.registerTool(
    "plans",
    { description: "비종료(non-terminal) plan 목록", inputSchema: {} },
    async () => {
      const list = await listPlans(WORKSPACE);
      const text = list.length
        ? list.map((p) => `${p.planId} [${p.phase}] ${p.title}`).join("\n")
        : "(no open plans)";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "plan",
    { description: "plan 상태 + audit chain", inputSchema: { planId: z.string() } },
    async ({ planId }) => {
      const t = await planTrail(WORKSPACE, { planId });
      const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
      const sp = t.specId ? `\n  spec: ${t.specId}` : "";
      const sup = t.supersededBy ? `\n  superseded-by: ${t.supersededBy}` : "";
      return {
        content: [
          { type: "text", text: `${t.planId} [${t.phase}] ${t.title}${sp}${sup}\n${chain}` },
        ],
      };
    },
  );
}
