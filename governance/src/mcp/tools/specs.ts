import { z } from "zod";
import { proposeSpec, acceptSpec, archiveSpec, listSpecs, specTrail } from "../../spec/handlers.ts";
import { okOrRefused } from "../response.ts";
import type { ToolContext } from "./context.ts";

/** Spec lifecycle tools: propose_spec, accept_spec(verdict), archive_spec, specs, spec. */
export function registerSpecTools(ctx: ToolContext): void {
  const { server, registerVerdictTool, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;

  // ── Phase B2: Spec lifecycle ──────────────────────────────────────────────────
  // propose_spec = the author (propose-only). accept_spec = the human gate. The author has no
  // tool that accepts a spec → INVARIANT #1 self-approval impossibility is structural.
  server.registerTool(
    "propose_spec",
    {
      description: "스펙을 draft spec_proposed 이벤트로 기록 (propose-only; 내용은 markdown SSOT)",
      inputSchema: { title: z.string(), summary: z.string() },
    },
    async ({ title, summary }) => {
      const r = await proposeSpec(WORKSPACE, { title, summary }, nowFn(), randFn());
      return { content: [{ type: "text", text: `spec proposed (draft): ${r.specId}` }] };
    },
  );

  // verdict tool — gated off for executor-role sessions (structural INVARIANT #1)
  // prettier-ignore
  registerVerdictTool(
  "accept_spec",
  { description: "사람 게이트: spec을 accepted로 (draft→accepted, actor=user)", inputSchema: { specId: z.string() } },
  async ({ specId }) => {
    const r = await acceptSpec(WORKSPACE, { specId }, nowFn(), randFn());
    return okOrRefused("accepted", r);
  },
);

  server.registerTool(
    "archive_spec",
    { description: "spec을 archived로 (terminal)", inputSchema: { specId: z.string() } },
    async ({ specId }) => {
      const r = await archiveSpec(WORKSPACE, { specId }, nowFn(), randFn());
      return okOrRefused("archived", r);
    },
  );

  server.registerTool(
    "specs",
    { description: "비종료(non-archived) spec 목록", inputSchema: {} },
    async () => {
      const list = await listSpecs(WORKSPACE);
      const text = list.length
        ? list.map((sp) => `${sp.specId} [${sp.phase}] ${sp.title}`).join("\n")
        : "(no open specs)";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "spec",
    { description: "spec 상태 + audit chain", inputSchema: { specId: z.string() } },
    async ({ specId }) => {
      const t = await specTrail(WORKSPACE, { specId });
      const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
      const plans = t.plans.length ? `\n  plans: ${t.plans.join(", ")}` : "";
      return {
        content: [{ type: "text", text: `${t.specId} [${t.phase}] ${t.title}${plans}\n${chain}` }],
      };
    },
  );
}
