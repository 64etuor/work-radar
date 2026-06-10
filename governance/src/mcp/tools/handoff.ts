import { z } from "zod";
import { buildIndex, nodeIndexFs } from "../../index/build.ts";
import type { GraphStore } from "../../graph/types.ts";
import { readAllEvents } from "../../decision/readEvents.ts";
import {
  requestHandoff,
  draftHandoff,
  runValidateHandoff,
  listHandoffs,
} from "../../handoff/handlers.ts";
import { hydrate, type HydrateDeps } from "../../steward/hydrateIo.ts";
import { computeContextPressure } from "../../steward/pressure.ts";
import { refusedText, okOrRefused } from "../response.ts";
import type { ToolContext } from "./context.ts";

export type HandoffDeps = {
  graphStore: GraphStore;
};

/** Context Steward / Handoff continuity tools: request_handoff, draft_handoff, validate_handoff,
 *  hydrate, handoff_status, context_pressure. */
export function registerHandoffTools(ctx: ToolContext, deps: HandoffDeps): void {
  const { server, workspace: WORKSPACE, repoRoot: REPO_ROOT, now: nowFn, rand: randFn } = ctx;
  const { graphStore } = deps;

  // ── v3 Phase G: Context Steward / Handoff continuity ──────────────────────────
  // Handoff axis (verdict-free) + advisory Steward. NO decision/task/session write-path; the ONLY
  // new write is hydrate emitting one handoff_consumed. context_pressure is read-only/advisory.
  server.registerTool(
    "request_handoff",
    {
      description: "세션에 대한 handoff를 births (handoff_requested). sessionId=인계 대상 세션",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const r = await requestHandoff(WORKSPACE, { sessionId }, nowFn(), randFn());
      return { content: [{ type: "text", text: `handoff requested: ${r.handoffId}` }] };
    },
  );

  server.registerTool(
    "draft_handoff",
    {
      description: "handoff 초안 markdown 본문 제출 (→ validating). 7개 필수 섹션 포함",
      inputSchema: { handoffId: z.string(), body: z.string() },
    },
    async ({ handoffId, body }) => {
      const r = await draftHandoff(WORKSPACE, { handoffId, body }, nowFn(), randFn());
      return okOrRefused("drafted", r);
    },
  );

  server.registerTool(
    "validate_handoff",
    {
      description:
        "최신 초안에 대해 7-섹션 구조 검증 → handoff_validated(통과) | handoff_invalid(미충족 섹션)",
      inputSchema: { handoffId: z.string() },
    },
    async ({ handoffId }) => {
      const r = await runValidateHandoff(WORKSPACE, { handoffId }, nowFn(), randFn());
      if (!r.ok) return refusedText(r.reason ?? "unknown");
      return {
        content: [
          {
            type: "text",
            text: r.valid
              ? `validated (pending): ${r.eventId}`
              : `invalid — missing: ${(r.missing ?? []).join(", ")}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "hydrate",
    {
      description:
        "pending handoff에서 hydration 번들 조립 + handoff_consumed 방출 (새 세션 재개용). 번들은 반환만(미영속)",
      inputSchema: { handoffId: z.string() },
    },
    async ({ handoffId }) => {
      const deps: HydrateDeps = {
        gitSummary: async () => {
          const { spawnSync } = await import("node:child_process");
          const st = spawnSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], {
            encoding: "utf8",
          });
          const ds = spawnSync("git", ["-C", REPO_ROOT, "diff", "--stat"], { encoding: "utf8" });
          return { status: (st.stdout ?? "").trim(), diffstat: (ds.stdout ?? "").trim() };
        },
        readNeighbors: async (nodeId) => {
          const nb = await graphStore.getNeighbors(nodeId);
          return nb ? nb.neighbors.map((n) => ({ node_id: n.node_id, title: n.title })) : [];
        },
        principles: async () => {
          const index = await buildIndex(REPO_ROOT, nodeIndexFs);
          // PrincipleRow = { id, number, title, body, sourcePath } — readable "INVARIANT-1: <title>" lines.
          return index.principles.map((p) => `${p.id}: ${p.title}`);
        },
      };
      const r = await hydrate(WORKSPACE, { handoffId }, deps, nowFn(), randFn());
      if (!r.ok) return refusedText(r.reason ?? "unknown");
      return { content: [{ type: "text", text: r.markdown ?? "" }] };
    },
  );

  server.registerTool(
    "handoff_status",
    { description: "비종료(non-consumed) handoff 목록 (read-only)", inputSchema: {} },
    async () => {
      const list = await listHandoffs(WORKSPACE);
      const text = list.length
        ? list.map((h) => `${h.handoffId} [${h.phase}] session=${h.sessionId ?? "-"}`).join("\n")
        : "(no open handoffs)";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "context_pressure",
    {
      description:
        "advisory context pressure 계산 (caller가 런타임 신호 제공, 이벤트-파생 신호는 로그에서 fold). 쓰기 없음 — session_context_pressure_changed 미작성",
      inputSchema: {
        estimatedTokenRatio: z.number().min(0).max(1),
        turnCount: z.number().int().min(0),
        wallClockMs: z.number().min(0),
        filesTouched: z.number().int().min(0),
      },
    },
    async ({ estimatedTokenRatio, turnCount, wallClockMs, filesTouched }) => {
      const all = await readAllEvents(WORKSPACE);
      const p = computeContextPressure(
        { estimatedTokenRatio, turnCount, wallClockMs, filesTouched },
        all,
        nowFn(),
      );
      return {
        content: [{ type: "text", text: `pressure: ${p.level} (score ${p.score.toFixed(2)})` }],
      };
    },
  );
}
