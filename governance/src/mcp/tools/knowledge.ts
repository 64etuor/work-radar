import { buildIndex, nodeIndexFs } from "../../index/build.ts";
import { formatPrinciples, formatDecisions, formatDecision } from "../../index/format.ts";
import { z } from "zod";
import { status, observations } from "../handlers.ts";
import type { ToolContext } from "./context.ts";

/** Read-only knowledge tools: status, observations, principles, decisions, decision. */
export function registerKnowledgeTools(ctx: ToolContext): void {
  const { server, workspace: WORKSPACE, repoRoot: REPO_ROOT, now: nowFn } = ctx;

  server.registerTool(
    "status",
    { description: "기록된 이벤트 수 요약", inputSchema: {} },
    async () => {
      const s = await status(WORKSPACE);
      return { content: [{ type: "text", text: `events: ${s.eventCount}` }] };
    },
  );

  server.registerTool(
    "observations",
    { description: "발견된(candidate) + 활성(active) 패턴 목록 (read-only)", inputSchema: {} },
    async () => {
      const o = await observations(WORKSPACE);
      const text = o.patterns.length
        ? o.patterns
            .map(
              (p) =>
                `- ${p.id} ${p.kind} scope=${p.scope} evidence=${p.evidence_count} conf=${p.confidence} [${p.status}]`,
            )
            .join("\n")
        : "no patterns observed";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "principles",
    { description: "결정 원칙(decision-rails INVARIANTs) 목록", inputSchema: {} },
    async () => {
      const index = await buildIndex(REPO_ROOT, nodeIndexFs);
      return { content: [{ type: "text", text: formatPrinciples(index) }] };
    },
  );

  server.registerTool(
    "decisions",
    { description: "ADR + decisions.md 결정 목록", inputSchema: {} },
    async () => {
      const index = await buildIndex(REPO_ROOT, nodeIndexFs);
      return { content: [{ type: "text", text: formatDecisions(index) }] };
    },
  );

  server.registerTool(
    "decision",
    {
      description: "단일 결정 상세 + 참조 그래프(supersedes/refs)",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const index = await buildIndex(REPO_ROOT, nodeIndexFs);
      return { content: [{ type: "text", text: formatDecision(index.getDecision(id), id) }] };
    },
  );
}
