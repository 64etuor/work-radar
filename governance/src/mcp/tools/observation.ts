import { z } from "zod";
import { listPatterns, getPattern } from "../../patterns/read.ts";
import { curatePattern } from "../../patterns/curate.ts";
import { listHypotheses } from "../../hypotheses/tester.ts";
import { archiveStatus } from "../../archive/pruner.ts";
import {
  runHarvest,
  runDetectStage,
  runHypothesisTest,
  runMetaObserve,
  runArchivePrune,
} from "../../observation/chain.ts";
import type { ToolContext } from "./context.ts";

/** Render a pattern's frontmatter as plain lines (no YAML re-serialization) for the detail view. */
function renderFrontmatter(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** Observation/learning-loop tools: harvest, detect, patterns, pattern, activate_pattern(verdict),
 *  archive_pattern(verdict), run_hypothesis_tester, hypotheses, meta_observe. */
export function registerObservationTools(ctx: ToolContext): void {
  const {
    server,
    registerVerdictTool,
    workspace: WORKSPACE,
    repoRoot: REPO_ROOT,
    now: nowFn,
  } = ctx;

  server.registerTool(
    "harvest",
    {
      description: "레포 활동(git log / decisions.md / ADR)을 L0 이벤트로 멱등 수집",
      inputSchema: {},
    },
    async () => {
      const summary = await runHarvest(REPO_ROOT, WORKSPACE);
      return {
        content: [
          {
            type: "text",
            text: `harvested: ${summary.written} new, ${summary.skipped} already-seen`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "detect",
    {
      description:
        "L0 코퍼스를 스캔해 commit scope hotspot 후보 패턴을 patterns/candidates/에 멱등 기록 (read→detect→write)",
      inputSchema: {},
    },
    async () => {
      const summary = await runDetectStage(WORKSPACE);
      return {
        content: [
          {
            type: "text",
            text:
              `detected: ${summary.written} new, ${summary.skipped} unchanged, ` +
              `${summary.candidates} candidate(s) | dropped(no-scope): ${summary.droppedNoScope} | ` +
              `scopes considered: ${summary.scopesConsidered}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "patterns",
    { description: "후보 패턴 목록 (read-only)", inputSchema: {} },
    async () => {
      const list = await listPatterns(WORKSPACE);
      const text = list.length
        ? list
            .map(
              (p) =>
                `- ${p.id} ${p.kind} scope=${p.scope} evidence=${p.evidence_count} conf=${p.confidence} [${p.status}]`,
            )
            .join("\n")
        : "no candidate patterns";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "pattern",
    { description: "단일 패턴 상세 + 근거 이벤트 (read-only)", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const p = await getPattern(WORKSPACE, id);
      const text = p ? `${renderFrontmatter(p.frontmatter)}\n\n${p.body}` : `not found: ${id}`;
      return { content: [{ type: "text", text }] };
    },
  );

  // Pattern curation — a human/orchestrator judgment ("this observation is real / noise"),
  // so it mirrors the verdict-tool gating: structurally unregistered for executor-role
  // sessions AND in SESSION_DENIED_TOOLS (an executor must not shape the curated set that
  // steers future detection).
  registerVerdictTool(
    "activate_pattern",
    {
      description: "패턴 큐레이션: candidate → active (사람/오케스트레이터 판단)",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const r = await curatePattern(WORKSPACE, id, "activate", "user");
      const text =
        r.outcome === "moved"
          ? `activated: ${id} (${r.from} → ${r.to})`
          : r.outcome === "already"
            ? `already ${r.to}: ${id}`
            : `REFUSED (${r.outcome}): ${id}`;
      return { content: [{ type: "text", text }] };
    },
  );

  registerVerdictTool(
    "archive_pattern",
    {
      description: "패턴 큐레이션: candidate|active → archived (망각; 복원은 수동 git)",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const r = await curatePattern(WORKSPACE, id, "archive", "user");
      const text =
        r.outcome === "moved"
          ? `archived: ${id} (${r.from} → ${r.to})`
          : r.outcome === "already"
            ? `already ${r.to}: ${id}`
            : `REFUSED (${r.outcome}): ${id}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "run_hypothesis_tester",
    {
      description:
        "P4: candidate/active commit-scope hotspot patterns에서 testing hypotheses를 만들고 현재 L0으로 verified/refuted 평가 (hypotheses markdown only)",
      inputSchema: {},
    },
    async () => {
      const summary = await runHypothesisTest(WORKSPACE, nowFn());
      return {
        content: [
          {
            type: "text",
            text:
              `hypotheses: ${summary.proposed} proposed, ${summary.verified} verified, ` +
              `${summary.refuted} refuted, ${summary.skipped} skipped`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "hypotheses",
    { description: "P4 hypotheses 목록 (testing + terminal, read-only)", inputSchema: {} },
    async () => {
      const list = await listHypotheses(WORKSPACE);
      const text = list.length
        ? list
            .map(
              (h) =>
                `- ${h.id} ${h.kind} scope=${h.scope} from=${h.from_pattern} threshold=${h.threshold} [${h.status}]`,
            )
            .join("\n")
        : "no hypotheses";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── P5: Meta Observer ─────────────────────────────────────────────────────────
  // PROPOSE-ONLY: the draft is persisted under meta/proposals/ (content-addressed,
  // idempotent) so it survives the MCP reply, but rails / principles / events are
  // never written. A human turns the draft into an ADR / rails PR.
  server.registerTool(
    "meta_observe",
    {
      description:
        "P5 Meta Observer: verified hypotheses → principle proposal draft, meta/proposals/에 영속 (propose-only)",
      inputSchema: {},
    },
    async () => {
      const result = await runMetaObserve(WORKSPACE);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}

// ── P6: Archive Pruner ────────────────────────────────────────────────────────
// The forgetting loop: terminal/expired hypotheses + stale candidate patterns →
// archived. Writes stay inside hypotheses/ and patterns/; events are NEVER pruned
// (folds replay the full L0 log). No verdict tools.
// Gated like activate_pattern/archive_pattern: the pattern half archives stale
// candidates into the curated set (steers future detection), so an executor must not
// reach it even time-bounded. (`detect` stays executor-reachable on purpose: it only
// CREATES candidates, which never enter the curated set without curation.)
/** Archive-pruner tools: archive_prune(verdict), archive_status. Registered after the escalation
 *  tools and before the conductor tools by server.ts to reproduce the original registration order. */
export function registerArchiveTools(ctx: ToolContext): void {
  const { server, registerVerdictTool, workspace: WORKSPACE, now: nowFn } = ctx;

  registerVerdictTool(
    "archive_prune",
    {
      description:
        "P6 Archive Pruner: terminal/expired hypotheses + stale candidate 패턴(90d) → archived one-pass move",
      inputSchema: {},
    },
    async () => {
      const result = await runArchivePrune(WORKSPACE, nowFn());
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "archive_status",
    {
      description: "P6 Archive Pruner read-only archive counts (hypotheses + patterns)",
      inputSchema: {},
    },
    async () => {
      const status = await archiveStatus(WORKSPACE);
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );
}
