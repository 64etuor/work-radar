import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, nodeIndexFs } from "../index/build.ts";
import { harvest, makeWriteOne } from "../harvest/harvest.ts";
import { realGitLog } from "../harvest/gitLog.ts";
import type { DecisionRow } from "../index/types.ts";
import { formatPrinciples, formatDecisions, formatDecision } from "../index/format.ts";
import { createTask, status, observations } from "./handlers.ts";
import {
  startTask,
  blockTask,
  cancelTask,
  listTasks,
  taskTrail,
} from "../task/handlers.ts";
import { completeTaskTool } from "./taskCompletion.ts";
import {
  proposePlan,
  acceptPlan,
  revisePlan,
  completePlan,
  archivePlan,
  supersedePlan,
  listPlans,
  planTrail,
} from "../plan/handlers.ts";
import { proposeSpec, acceptSpec, archiveSpec, listSpecs, specTrail } from "../spec/handlers.ts";
import {
  proposeDecision,
  requestReview,
  approve,
  reject,
  conflicts,
  why,
  history,
  chooseOption,
} from "../decision/handlers.ts";
import { escalate } from "../escalate/escalate.ts";
import { pendingEscalations } from "../escalate/pending.ts";
import { conductPlan, conductorStatus } from "../conductor/handlers.ts";
import { type SpawnSyncLike } from "../conductor/adapter.ts";
import { makeConductorAdapterFromEnv } from "../conductor/fromEnv.ts";
import { runPreflight } from "../live/preflight.ts";
import { evaluateReadiness } from "../live/readiness.ts";
import { listStalledTasks } from "../orchestrator/stall.ts";
import {
  requestSessionOpen,
  markWaiting,
  markBlocked,
  recordPressure,
  requestCheckpoint,
  markHandoffReady,
  requestSessionClose,
  closeSession,
  listSessions,
  sessionTrail,
} from "../session/handlers.ts";
import {
  observeSessions,
  makeLiveAdapter as makeObserverLiveAdapter,
  stubAdapter as observerStubAdapter,
  type ObserverAdapter,
  type SpawnResultLike as ObserverSpawnResultLike,
} from "../session/observer.ts";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  parseAutoMode,
  parseAutonomyLevel,
  parseConductorConfig,
  parseObserverConfig,
  parseEnvelopeDefaults,
} from "./config.ts";
import { autoAccept } from "../orchestrator/autoAccept.ts";
import { autonomyAllows } from "../repo/config.ts";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildLike, SpawnLike } from "../decision/liveReviewer.ts";
import {
  parseQuorum,
  parseReviewerModels,
  quorumCollisionWarning,
  parsePatternConfig,
} from "./config.ts";
import type { ReviewerEntry } from "../decision/reviewer.ts";
import { buildReviewerEntries } from "./reviewers.ts";
import { normalizeModelId } from "../decision/modelId.ts";
import { loadPolicyOrStrict } from "../repo/configIo.ts";
import { runDetect } from "../patterns/detect.ts";
import { makeWritePattern } from "../patterns/write.ts";
import { loadCuratedKeys, listPatterns, getPattern } from "../patterns/read.ts";
import { makeWriteHypothesis } from "../hypotheses/write.ts";
import {
  listHypotheses,
  readSupportedPatterns,
  readTestingHypotheses,
  runHypothesisTester,
} from "../hypotheses/tester.ts";
import { buildMetaObservation } from "../meta/observer.ts";
import { archiveStatus, runArchivePruner } from "../archive/pruner.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { suggest } from "../orchestrator/suggest.ts";
import { listSuggestions } from "../orchestrator/project.ts";
import { autoDispatch } from "../orchestrator/dispatch/dispatch.ts";
import { listDispatchLog } from "../orchestrator/dispatch/project.ts";
import { openStore } from "../graph/store.ts";
import { rebuildIndex } from "../graph/ingest.ts";
import {
  requestHandoff,
  draftHandoff,
  runValidateHandoff,
  listHandoffs,
} from "../handoff/handlers.ts";
import { hydrate, type HydrateDeps } from "../steward/hydrateIo.ts";
import { computeContextPressure } from "../steward/pressure.ts";

const WORKSPACE =
  process.env.BOULE_WORKSPACE ?? new URL("../../workspace", import.meta.url).pathname;

// Repo root holds the canonical L3/L4 markdown (docs/adr, docs/decisions.md,
// docs/areas/decision-rails.md). Default: two levels up from the workspace
// (<repo>/governance/workspace → <repo>). Overridable for tests/relocation.
const REPO_ROOT = process.env.BOULE_REPO_ROOT ?? resolve(WORKSPACE, "..", "..");
const LOADED_POLICY = await loadPolicyOrStrict(REPO_ROOT);

// 비결정 입력은 서버 경계에서만 (핸들러는 순수 유지)
const nowFn = () => new Date();
const randFn = () => Math.random();

// Session-role gate (Phase C structural INVARIANT #1). A Conductor-spawned *executor* session
// (BOULE_SESSION_ROLE=executor) must NOT be able to resolve a governance verdict — so the
// human-gate tools (approve/reject/choose/accept_plan/accept_spec) are NOT registered for it.
// It can still `escalate` (mints no verdict) and drive its own task. This makes "a spawned
// session reaches governance only via escalate" structural (tool absent), not prompt-advisory.
// Normalized (trim+lowercase) so role drift ("Executor", "executor ") still disables verdicts
// — the SAFE direction. No env ⇒ "" ⇒ verdicts ON (correct human-operator default).
const SESSION_ROLE = (process.env.BOULE_SESSION_ROLE ?? "").trim().toLowerCase();
const SESSION_ALLOWS_VERDICTS = SESSION_ROLE !== "executor";

// Pattern detector knobs (env, safe defaults: minEvidence=5, confFull=50).
const PATTERN_CFG = parsePatternConfig(process.env);

/** Render a pattern's frontmatter as plain lines (no YAML re-serialization) for the detail view. */
function renderFrontmatter(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

// SDK 1.29(실측): server.tool()은 deprecated → registerTool(name, config, cb).
const server = new McpServer({ name: "boule-governance", version: "0.0.1" });

server.registerTool(
  "create_task",
  {
    description: "할 일을 L0 task_created 이벤트로 기록",
    inputSchema: { description: z.string() },
  },
  async ({ description }) => {
    const r = await createTask(WORKSPACE, { description }, nowFn(), randFn());
    return { content: [{ type: "text", text: `task recorded: ${r.id}` }] };
  },
);

server.registerTool(
  "start_task",
  {
    description: "task를 active로 전이 (ready/blocked→active)",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    const r = await startTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `started: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "block_task",
  {
    description: "task를 blocked로 전이 (사유 기록)",
    inputSchema: { taskId: z.string(), reason: z.string() },
  },
  async ({ taskId, reason }) => {
    const r = await blockTask(WORKSPACE, { taskId, reason }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `blocked: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "complete_task",
  {
    description: "executor가 완료/정상 종료를 보고하는 verdict-free 힌트 (완료 판정 아님)",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    const r = await completeTaskTool(WORKSPACE, { taskId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `reported: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "cancel_task",
  { description: "task를 cancelled로 전이 (terminal)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await cancelTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `cancelled: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "tasks",
  { description: "비종료(non-terminal) task 목록", inputSchema: {} },
  async () => {
    const list = await listTasks(WORKSPACE);
    const text = list.length
      ? list.map((t) => `${t.taskId} [${t.phase}] ${t.title}`).join("\n")
      : "(no open tasks)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "task",
  { description: "task 상태 + audit chain", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const t = await taskTrail(WORKSPACE, { taskId });
    const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
    return { content: [{ type: "text", text: `${t.taskId} [${t.phase}] ${t.title}\n${chain}` }] };
  },
);

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
            check: z.object({ command: z.string().optional(), artifact: z.string().optional() }).optional(),
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
if (SESSION_ALLOWS_VERDICTS)
  // prettier-ignore
  server.registerTool(
  "accept_plan",
  { description: "사람 게이트: plan을 active로 (draft/needs_revision→active, actor=user)", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const r = await acceptPlan(WORKSPACE, { planId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `accepted: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
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
    return {
      content: [
        { type: "text", text: r.ok ? `revision requested: ${r.eventId}` : `REFUSED: ${r.reason}` },
      ],
    };
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
    return {
      content: [{ type: "text", text: r.ok ? `completed: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "archive_plan",
  { description: "plan을 archived로 (terminal)", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const r = await archivePlan(WORKSPACE, { planId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `archived: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
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
    return {
      content: [{ type: "text", text: r.ok ? `superseded: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
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
      content: [{ type: "text", text: `${t.planId} [${t.phase}] ${t.title}${sp}${sup}\n${chain}` }],
    };
  },
);

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
if (SESSION_ALLOWS_VERDICTS)
  // prettier-ignore
  server.registerTool(
  "accept_spec",
  { description: "사람 게이트: spec을 accepted로 (draft→accepted, actor=user)", inputSchema: { specId: z.string() } },
  async ({ specId }) => {
    const r = await acceptSpec(WORKSPACE, { specId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `accepted: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "archive_spec",
  { description: "spec을 archived로 (terminal)", inputSchema: { specId: z.string() } },
  async ({ specId }) => {
    const r = await archiveSpec(WORKSPACE, { specId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `archived: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
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
  { description: "활성 패턴 목록(P1: 빈 목록)", inputSchema: {} },
  async () => {
    const o = await observations(WORKSPACE);
    return { content: [{ type: "text", text: `active patterns: ${o.patterns.length}` }] };
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
  { description: "단일 결정 상세 + 참조 그래프(supersedes/refs)", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    return { content: [{ type: "text", text: formatDecision(index.getDecision(id), id) }] };
  },
);

server.registerTool(
  "harvest",
  {
    description: "레포 활동(git log / decisions.md / ADR)을 L0 이벤트로 멱등 수집",
    inputSchema: {},
  },
  async () => {
    const summary = await harvest({
      gitLog: () => realGitLog(REPO_ROOT),
      loadDecisionRows: async () =>
        (await buildIndex(REPO_ROOT, nodeIndexFs)).decisions as readonly DecisionRow[],
      writeOne: makeWriteOne(WORKSPACE),
    });
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
    const summary = await runDetect({
      readEvents: () => readAllEvents(WORKSPACE),
      loadCuratedKeys: () => loadCuratedKeys(WORKSPACE),
      writePattern: makeWritePattern(WORKSPACE, { evidenceCap: PATTERN_CFG.evidenceCap }),
      options: PATTERN_CFG,
    });
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

server.registerTool(
  "run_hypothesis_tester",
  {
    description:
      "P4: candidate/active commit-scope hotspot patterns에서 testing hypotheses를 만들고 현재 L0으로 verified/refuted 평가 (hypotheses markdown only)",
    inputSchema: {},
  },
  async () => {
    const summary = await runHypothesisTester({
      readEvents: () => readAllEvents(WORKSPACE),
      readPatterns: () => readSupportedPatterns(WORKSPACE),
      readTestingHypotheses: () => readTestingHypotheses(WORKSPACE),
      writeHypothesis: makeWriteHypothesis(WORKSPACE),
      now: nowFn,
    });
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
// Local proposal draft only. No L3/L4 writes and no verdict tools.
server.registerTool(
  "meta_observe",
  {
    description:
      "P5 local Meta Observer: verified hypotheses를 principle proposal draft로 렌더링만 함 (no file writes)",
    inputSchema: {},
  },
  async () => {
    const result = buildMetaObservation({ hypotheses: await listHypotheses(WORKSPACE) });
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

const AUTHOR_MODEL = process.env.BOULE_AUTHOR_MODEL ?? "claude";
const REVIEWER_MODEL = process.env.BOULE_REVIEWER_MODEL ?? "external-stub";
const QUORUM = parseQuorum(process.env.BOULE_REVIEW_QUORUM);
// BOULE_REVIEWER_MODELS=codex,gemini 리스트(정규화 dedup) → 없으면 단수 BOULE_REVIEWER_MODEL로 폴백.
const REVIEWER_MODELS = parseReviewerModels(process.env.BOULE_REVIEWER_MODELS, REVIEWER_MODEL);

// 비결정(서브프로세스/타이머/Math.random)은 이 경계에서만 주입. 기본 = stub(결정적·CI 무변경).
// BOULE_REVIEWER_MODE=live 일 때만 작성자와 다른 모델 CLI를 bounded retry로 호출.
// 각 모델은 resolveReviewerCommand로 자기 CMD/ARGS를 해석(per-model override → 전역 → 안전 기본).
const LIVE = process.env.BOULE_REVIEWER_MODE === "live";
const realReviewerSpawn: SpawnLike = (cmd, args) => nodeSpawn(cmd, args) as unknown as ChildLike;

function buildReviewers(): ReviewerEntry[] {
  return buildReviewerEntries({
    env: process.env,
    fallbackReviewerModel: REVIEWER_MODEL,
    live: LIVE,
    reviewerChains: LOADED_POLICY.policy.backends?.reviewers,
    spawn: realReviewerSpawn,
    log: (line) => process.stderr.write(`${line}\n`), // PII-safe (size/attempt/exit only)
  });
}

const reviewers = buildReviewers();

// Genuine-quorum advisory (warn-but-continue): live + quorum≥2 인데 라벨들이 동일 (cmd,args)로
// 붕괴해 distinct reviewer가 quorum 미만이면 가짜 quorum. PII-safe(라벨만)로 경고하고 그대로 기동.
const quorumWarning = LIVE && !LOADED_POLICY.policy.backends?.reviewers
  ? quorumCollisionWarning(REVIEWER_MODELS, process.env, QUORUM)
  : null;
if (quorumWarning) process.stderr.write(`${quorumWarning}\n`);

// ── Phase C: Conductor adapter ────────────────────────────────────────────────
// 기본 = stub(결정적·git/cmux/fs 무접근 → CI 무변경). BOULE_CONDUCTOR_MODE=live 일 때만
// 실제 git worktree + cmux 어댑터. 비결정(spawnSync/fs)은 이 경계에서만 주입(liveReviewer와 동형).
const CONDUCTOR_CFG = parseConductorConfig(process.env);
// Graduated autonomy (config-driven, fail-closed to manual). The level is the master knob: it gates
// orchestrator auto-acceptance (auto_dispatch tool) AND derives dispatch — autonomyLevel>=dispatch
// ⇒ AUTO_MODE type2 (an explicit BOULE_AUTO_MODE still works for the manual-level legacy path).
const AUTONOMY_LEVEL = parseAutonomyLevel(process.env.BOULE_AUTONOMY_LEVEL);
const AUTO_MODE = autonomyAllows.dispatch(AUTONOMY_LEVEL)
  ? "type2"
  : parseAutoMode(process.env.BOULE_AUTO_MODE);
// Per-repo policy envelope defaults (set by the `boule` launcher from resolved policy). Unset ⇒ {}
// ⇒ the conductor's built-in envelope defaults apply.
const ENVELOPE_DEFAULTS = parseEnvelopeDefaults(process.env);
// The Conductor adapter (live vs stub) is built from env by the shared helper — same wiring the
// `boule tick` CLI uses, so the MCP server and tick conduct identically. serverEntrypoint = this
// install's server.ts (spawned sessions point their executor MCP here, NOT at the target repo).
const conductorAdapter = makeConductorAdapterFromEnv(process.env, {
  workspace: WORKSPACE,
  repoRoot: REPO_ROOT,
  serverEntrypoint: fileURLToPath(import.meta.url),
});

// ── Phase D: Observer adapter ─────────────────────────────────────────────────
// 기본 = no-op(stub·cmux 무접근). BOULE_OBSERVER_MODE=live 일 때만 실제 `cmux tree --all --json` 어댑터.
// 비-live에서는 observe_sessions가 reconcile하지 않는다(빈 surface 집합에 대해 모든 known
// 세션을 crash 처리하는 footgun 방지). 비결정(spawnSync)은 이 경계에서만 주입.
const OBSERVER_CFG = parseObserverConfig(process.env);
function buildObserverAdapter(): ObserverAdapter {
  if (!OBSERVER_CFG.live) return observerStubAdapter;
  const realSpawnSync = (cmd: string, args: string[]): ObserverSpawnResultLike => {
    const r = nodeSpawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return makeObserverLiveAdapter({
    spawn: realSpawnSync,
    cmuxCmd: OBSERVER_CFG.cmuxCmd,
    log: (line) => process.stderr.write(`${line}\n`), // PII-safe (명령명+status+count만)
  });
}
const observerAdapter = buildObserverAdapter();

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
    const distinctModels = new Set(res.recorded.map((r) => r.reviewerBackend ?? normalizeModelId(r.reviewerModel))).size;
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
if (SESSION_ALLOWS_VERDICTS)
  // prettier-ignore
  server.registerTool(
  "approve",
  {
    description: "결정 사람 승인(게이트) — 외부검토 없으면 거부",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await approve(WORKSPACE, { decisionId }, nowFn(), randFn(), QUORUM);
    return { content: [{ type: "text", text: r.ok ? `approved: ${decisionId}` : `REFUSED: ${r.reason}` }] };
  },
);

// verdict tool — gated off for executor-role sessions (structural INVARIANT #1)
if (SESSION_ALLOWS_VERDICTS)
  // prettier-ignore
  server.registerTool(
  "reject",
  {
    description: "결정 사람 반려(게이트)",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await reject(WORKSPACE, { decisionId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `rejected: ${decisionId}` : `REFUSED: ${r.reason}` }] };
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
        relatedTaskId: related_task_id,
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
if (SESSION_ALLOWS_VERDICTS)
  // prettier-ignore
  server.registerTool(
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

// ── P6: Archive Pruner ────────────────────────────────────────────────────────
// Hypothesis-only local archive pass. No verdict tools and no writes outside hypotheses.
server.registerTool(
  "archive_prune",
  {
    description:
      "P6 local Archive Pruner: terminal/expired hypotheses testing→archived one-pass move",
    inputSchema: {},
  },
  async () => {
    const today = nowFn().toISOString().slice(0, 10);
    const summary = await runArchivePruner(WORKSPACE, today);
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
);

server.registerTool(
  "archive_status",
  {
    description: "P6 Archive Pruner read-only hypothesis archive counts",
    inputSchema: {},
  },
  async () => {
    const status = await archiveStatus(WORKSPACE);
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  },
);

// ── Phase C: Conductor (dispatcher, NOT decider) ──────────────────────────────
// conduct_plan = the ONLY write (advance ≤1 step). conductor_status = read-only render.
// NO conductor_approve/conductor_resolve — resolution flows only through human-gated choose/approve.
server.registerTool(
  "conduct_plan",
  {
    description:
      "사람이 accept한 plan을 1스텝 전진 (task mint + 격리 cmux 세션 spawn). active 아니거나 halt/done/in-flight면 거부 (verdict 없음)",
    inputSchema: { planId: z.string() },
  },
  async ({ planId }) => {
    const r = await conductPlan(
      WORKSPACE,
      { planId },
      {
        adapter: conductorAdapter,
        executor: CONDUCTOR_CFG.executor,
        envelopeDefaults: ENVELOPE_DEFAULTS,
      },
      nowFn(),
      randFn(),
    );
    if (!r.ok) return { content: [{ type: "text", text: `REFUSED: ${r.reason}` }] };
    const a = r.advanced!;
    return {
      content: [
        {
          type: "text",
          text: `advanced step ${a.stepIndex}: task=${a.taskId} surface=${a.surface} worktree=${a.worktreePath} envelopeHash=${a.envelopeHash}`,
        },
      ],
    };
  },
);

server.registerTool(
  "conductor_status",
  {
    description: "Conductor 투영 read-only 렌더 (steps × 바인딩된 task 상태 × halt) — 쓰기 없음",
    inputSchema: { planId: z.string() },
  },
  async ({ planId }) => {
    const s = await conductorStatus(WORKSPACE, { planId });
    const head = `${s.planId} [${s.planPhase}] cursor=${s.cursor ?? "-"} halted=${s.halted} done=${s.done}`;
    const lines = s.steps.map(
      (st) =>
        `  ${st.stepIndex}. ${st.text} → ${st.taskId ?? "(unmaterialized)"}` +
        (st.taskPhase ? ` [${st.taskPhase}]` : "") +
        (st.halted ? " HALTED" : ""),
    );
    return { content: [{ type: "text", text: [head, ...lines].join("\n") }] };
  },
);

// ── Phase I: Narrow opt-in Type-2 auto dispatch ──────────────────────────────
// One on-demand pass that fires conduct_plan and (at autonomyLevel auto_plan/full) auto-accepts
// proposed plans/specs. ORCHESTRATOR-ONLY: structurally NOT registered for an executor session
// (mirrors accept_plan/accept_spec) + in SESSION_DENIED_TOOLS — so an executor can never auto-accept
// its own plan. Verdict-free; writes no decision_*.
if (SESSION_ALLOWS_VERDICTS)
  // prettier-ignore
  server.registerTool(
  "auto_dispatch",
  {
    description:
      "Phase I narrow opt-in Type-2 auto: one on-demand pass over human-accepted plans via conduct_plan. " +
      "Refuses unless BOULE_AUTO_MODE=type2. Writes no decision_*.",
    inputSchema: {},
  },
  async () => {
    if (AUTO_MODE !== "type2") {
      return { content: [{ type: "text", text: "auto disabled (set BOULE_AUTO_MODE=type2)" }] };
    }
    // INVARIANT #1 gate: ONLY when autonomyLevel opens it (auto_plan/full) does the orchestrator
    // auto-accept proposed plans (full also specs). actor:"system", never forged as a human.
    const accepted = await autoAccept(WORKSPACE, AUTONOMY_LEVEL, nowFn(), randFn());
    const s = await autoDispatch(
      WORKSPACE,
      {
        adapter: conductorAdapter,
        executor: CONDUCTOR_CFG.executor,
        envelopeDefaults: ENVELOPE_DEFAULTS,
      },
      AUTO_MODE,
      nowFn(),
      randFn(),
    );
    const acc =
      accepted.specsAccepted || accepted.plansAccepted
        ? ` (auto-accepted ${accepted.specsAccepted} spec, ${accepted.plansAccepted} plan @${AUTONOMY_LEVEL})`
        : "";
    return {
      content: [
        {
          type: "text",
          text: `dispatched: ${s.executed} executed, ${s.failed} failed, ${s.denied} denied, ${s.skipped} skipped${acc}`,
        },
      ],
    };
  },
);

server.registerTool(
  "dispatch_log",
  {
    description:
      "Phase I read-only list of the auto-dispatch trail (instruction_planned + outcomes).",
    inputSchema: {},
  },
  async () => {
    const log = await listDispatchLog(WORKSPACE);
    return { content: [{ type: "text", text: JSON.stringify(log, null, 2) }] };
  },
);

// ── L0: Live-loop preflight (read-only) ───────────────────────────────────────
// Reports whether the live autonomous loop can physically run here (required: cmux socket/binary
// + git worktree) and the live-flag posture (advisory). Writes nothing; verdict-free.
server.registerTool(
  "preflight",
  {
    description:
      "L0 live-loop preflight — read-only report of required infra (cmux socket/binary, git worktree) " +
      "+ advisory flag posture (conductor/observer/auto mode, session role). Writes nothing.",
    inputSchema: {},
  },
  async () => {
    const realSpawnSync: SpawnSyncLike = (cmd, args) => {
      const r = nodeSpawnSync(cmd, args, { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const report = runPreflight({ env: process.env, spawn: realSpawnSync, repoRoot: REPO_ROOT });
    const lines = report.checks.map(
      (c) => `  ${c.ok ? "✓" : "✗"} [${c.level}] ${c.id}: ${c.detail}`,
    );
    return {
      content: [{ type: "text", text: [`preflight ready=${report.ready}`, ...lines].join("\n") }],
    };
  },
);

// ── L2: Stalled tasks (read-only) ─────────────────────────────────────────────
// Active/blocked tasks whose bound session has crashed — a silent stall the conductor would
// otherwise wait on forever. Verdict-free; resolution stays human.
server.registerTool(
  "stalled_tasks",
  {
    description:
      "L2 read-only — in-flight tasks whose bound session crashed (silent stalls). Writes nothing.",
    inputSchema: {},
  },
  async () => {
    const stalled = await listStalledTasks(WORKSPACE);
    const text = stalled.length
      ? stalled
          .map((s) => `${s.taskId} [${s.taskPhase}] session=${s.sessionId} (${s.reason})`)
          .join("\n")
      : "(no stalled tasks)";
    return { content: [{ type: "text", text }] };
  },
);

// ── L4: Unattended-readiness gate (read-only) ─────────────────────────────────
// Stricter than preflight: promotes the live flags to required + refuses when stalls are open.
server.registerTool(
  "readiness",
  {
    description:
      "L4 read-only — is it SAFE to run UNATTENDED? Requires preflight infra + conductor/observer live + " +
      "auto=type2 + zero open stalls. Lists all blockers. Writes nothing.",
    inputSchema: {},
  },
  async () => {
    const realSpawnSync: SpawnSyncLike = (cmd, args) => {
      const r = nodeSpawnSync(cmd, args, { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const probe = (cmd: string, args: string[]): boolean => {
      try {
        return realSpawnSync(cmd, args).status === 0;
      } catch {
        return false;
      }
    };
    const cmuxCmd = CONDUCTOR_CFG.cmuxCmd;
    const stalledCount = (await listStalledTasks(WORKSPACE)).length;
    const report = evaluateReadiness({
      signals: {
        env: process.env,
        cmuxBinaryOk: probe(cmuxCmd, ["--version"]),
        gitWorktreeOk: probe("git", ["-C", REPO_ROOT, "worktree", "list"]),
      },
      stalledCount,
    });
    const head = report.ready
      ? "readiness ready=true (safe for unattended dispatch)"
      : ["readiness ready=false — blockers:", ...report.blockers.map((b) => `  ✗ ${b}`)].join("\n");
    const warns = report.warnings.length
      ? ["\nwarnings (non-blocking — opted in):", ...report.warnings.map((w) => `  ⚠ ${w}`)].join("\n")
      : "";
    return { content: [{ type: "text", text: head + warns }] };
  },
);

// ── Phase D: Session Registry + cmux Observer ─────────────────────────────────
// 전부 verdict-free → SESSION_ALLOWS_VERDICTS 게이트 비대상(approve/choose류 아님).
// observe_sessions만 BOULE_OBSERVER_MODE=live에서 reconcile; 그 외엔 무동작 notice.
server.registerTool(
  "sessions",
  { description: "비종료(non-terminal) session 목록 (read-only)", inputSchema: {} },
  async () => {
    const list = await listSessions(WORKSPACE);
    const text = list.length
      ? list
          .map((s) => `${s.sessionId} [${s.phase}] ${s.ownership} surface=${s.surface ?? "-"}`)
          .join("\n")
      : "(no open sessions)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "session",
  { description: "session 상태 + audit chain (read-only)", inputSchema: { sessionId: z.string() } },
  async ({ sessionId }) => {
    const t = await sessionTrail(WORKSPACE, { sessionId });
    const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `${t.sessionId} [${t.phase}] ${t.ownership} surface=${t.surface ?? "-"}\n${chain}`,
        },
      ],
    };
  },
);

server.registerTool(
  "observe_sessions",
  {
    description:
      "라이브 cmux surface를 읽어 registry와 reconcile (observe/crash/recover/orphan-open) — 상태 변화시에만 1세션당 ≤1 이벤트. session_closed 절대 안 씀(no-auto-close). BOULE_OBSERVER_MODE=live 필요",
    inputSchema: {},
  },
  async () => {
    if (!OBSERVER_CFG.live)
      return {
        content: [
          {
            type: "text",
            text: "observer stub: BOULE_OBSERVER_MODE!=live → cmux 미접근, reconcile 생략",
          },
        ],
      };
    const s = await observeSessions(WORKSPACE, { adapter: observerAdapter }, nowFn(), randFn());
    return {
      content: [
        {
          type: "text",
          text: `observed=${s.observed} crashed=${s.crashed} recovered=${s.recovered} opened=${s.opened}`,
        },
      ],
    };
  },
);

server.registerTool(
  "request_session_open",
  {
    description:
      "planned 세션을 births (session_open_requested). ownership=user_owned|external_owned(기본 user_owned), surface 선택",
    inputSchema: {
      ownership: z.enum(["user_owned", "external_owned"]).optional(),
      surface: z.string().optional(),
    },
  },
  async ({ ownership, surface }) => {
    const r = await requestSessionOpen(WORKSPACE, { ownership, surface }, nowFn(), randFn());
    return { content: [{ type: "text", text: `session requested (planned): ${r.sessionId}` }] };
  },
);

server.registerTool(
  "mark_session_waiting",
  {
    description: "session을 waiting으로 기록 (verdict 없음)",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const r = await markWaiting(WORKSPACE, { sessionId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `waiting: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "mark_session_blocked",
  {
    description: "session을 blocked로 기록 (사유)",
    inputSchema: { sessionId: z.string(), reason: z.string() },
  },
  async ({ sessionId, reason }) => {
    const r = await markBlocked(WORKSPACE, { sessionId, reason }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `blocked: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

server.registerTool(
  "record_context_pressure",
  {
    description: "context pressure level 기록 (high|critical만 phase 전진)",
    inputSchema: { sessionId: z.string(), level: z.enum(["low", "medium", "high", "critical"]) },
  },
  async ({ sessionId, level }) => {
    const r = await recordPressure(WORKSPACE, { sessionId, level }, nowFn(), randFn());
    return {
      content: [
        { type: "text", text: r.ok ? `pressure(${level}): ${r.eventId}` : `REFUSED: ${r.reason}` },
      ],
    };
  },
);

server.registerTool(
  "request_checkpoint",
  { description: "session checkpoint 요청 기록", inputSchema: { sessionId: z.string() } },
  async ({ sessionId }) => {
    const r = await requestCheckpoint(WORKSPACE, { sessionId }, nowFn(), randFn());
    return {
      content: [
        {
          type: "text",
          text: r.ok ? `checkpoint requested: ${r.eventId}` : `REFUSED: ${r.reason}`,
        },
      ],
    };
  },
);

server.registerTool(
  "mark_handoff_ready",
  { description: "session handoff ready 기록", inputSchema: { sessionId: z.string() } },
  async ({ sessionId }) => {
    const r = await markHandoffReady(WORKSPACE, { sessionId }, nowFn(), randFn());
    return {
      content: [
        { type: "text", text: r.ok ? `handoff ready: ${r.eventId}` : `REFUSED: ${r.reason}` },
      ],
    };
  },
);

server.registerTool(
  "request_session_close",
  {
    description: "session close 요청 (→ closing; close_session의 게이트)",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const r = await requestSessionClose(WORKSPACE, { sessionId }, nowFn(), randFn());
    return {
      content: [
        { type: "text", text: r.ok ? `close requested: ${r.eventId}` : `REFUSED: ${r.reason}` },
      ],
    };
  },
);

server.registerTool(
  "close_session",
  {
    description:
      "session을 closed로 (terminal) — session_close_requested 이후에만. 유일한 session_closed 경로",
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    const r = await closeSession(WORKSPACE, { sessionId }, nowFn(), randFn());
    return {
      content: [{ type: "text", text: r.ok ? `closed: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
  },
);

// v3 Phase E — Orchestrator read-half. suggest mints NO verdict (suggestion-class only), so it is
// registered unconditionally like observe_sessions. It touches no cmux/network — folds only.
server.registerTool(
  "suggest",
  {
    description:
      "교차-fold 관찰 → advisory 제안 방출 (orchestrator_suggestion_created만; on-demand 1패스)",
    inputSchema: {},
  },
  async () => {
    const r = await suggest(WORKSPACE, nowFn(), randFn());
    return {
      content: [{ type: "text", text: `suggestions created ${r.created} / skipped ${r.skipped}` }],
    };
  },
);
server.registerTool(
  "suggestions",
  { description: "open orchestrator 제안 목록 (read-only)", inputSchema: {} },
  async () => {
    const list = await listSuggestions(WORKSPACE);
    const text = list.length
      ? list.map((s) => `${s.id} [${s.rule}] ${s.subjectType}=${s.subject} ${s.detail}`).join("\n")
      : "(no open suggestions)";
    return { content: [{ type: "text", text }] };
  },
);

// v3 Phase F — Postgres+pgvector derived graph index (events+nodes+edges via embedded PGlite).
// Read/rebuild only — NO approve/choose/decision_* surface (master §4.5). One store, opened once.
const graphStore = await openStore(join(WORKSPACE, "index", "pglite"));

server.registerTool(
  "rebuild_index",
  {
    description: "L0 마크다운 이벤트 → 파생 그래프 인덱스(events+nodes+edges) 멱등 재구축",
    inputSchema: {},
  },
  async () => {
    const st = await rebuildIndex(WORKSPACE, graphStore);
    return {
      content: [
        {
          type: "text",
          text: `index rebuilt: ${st.events} events, ${st.nodes} nodes, ${st.edges} edges (checksum ${st.checksum.slice(0, 8)})`,
        },
      ],
    };
  },
);

server.registerTool(
  "index_status",
  { description: "그래프 인덱스 행 수 + 투영 checksum", inputSchema: {} },
  async () => {
    const st = await graphStore.status();
    const text =
      st.events === 0 && st.nodes === 0
        ? "index not built (run rebuild_index)"
        : `events ${st.events} · nodes ${st.nodes} · edges ${st.edges} · checksum ${st.checksum.slice(0, 8)}`;
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "graph_node",
  { description: "노드 1개 조회 (node_id = `type:canonical_id`)", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const n = await graphStore.getNode(id);
    return {
      content: [{ type: "text", text: n ? JSON.stringify(n, null, 2) : `unknown node: ${id}` }],
    };
  },
);

server.registerTool(
  "graph_neighbors",
  { description: "노드 + 1-hop 인접 엣지/노드", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const nb = await graphStore.getNeighbors(id);
    return {
      content: [{ type: "text", text: nb ? JSON.stringify(nb, null, 2) : `unknown node: ${id}` }],
    };
  },
);

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
    return {
      content: [{ type: "text", text: r.ok ? `drafted: ${r.eventId}` : `REFUSED: ${r.reason}` }],
    };
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
    if (!r.ok) return { content: [{ type: "text", text: `REFUSED: ${r.reason}` }] };
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
    if (!r.ok) return { content: [{ type: "text", text: `REFUSED: ${r.reason}` }] };
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

await server.connect(new StdioServerTransport());
