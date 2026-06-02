import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { buildIndex, nodeIndexFs } from "../index/build.ts";
import { harvest, makeWriteOne } from "../harvest/harvest.ts";
import { realGitLog } from "../harvest/gitLog.ts";
import type { DecisionRow } from "../index/types.ts";
import { formatPrinciples, formatDecisions, formatDecision } from "../index/format.ts";
import { createTask, status, observations } from "./handlers.ts";
import { startTask, blockTask, completeTask, cancelTask, listTasks, taskTrail } from "../task/handlers.ts";
import {
  proposePlan, acceptPlan, revisePlan, completePlan, archivePlan, supersedePlan, listPlans, planTrail,
} from "../plan/handlers.ts";
import {
  proposeSpec, acceptSpec, archiveSpec, listSpecs, specTrail,
} from "../spec/handlers.ts";
import {
  proposeDecision, requestReview, approve, reject, conflicts, why, history, chooseOption,
} from "../decision/handlers.ts";
import { escalate } from "../escalate/escalate.ts";
import { pendingEscalations } from "../escalate/pending.ts";
import type { ReviewFn } from "../decision/reviewer.ts";
import { spawn as nodeSpawn } from "node:child_process";
import {
  liveReview,
  defaultReviewPrompt,
  parseVerdict,
  type SpawnLike,
  type ChildLike,
} from "../decision/liveReviewer.ts";
import {
  parseQuorum,
  parseReviewerModels,
  resolveReviewerCommand,
  quorumCollisionWarning,
  parsePatternConfig,
} from "./config.ts";
import type { ReviewerEntry } from "../decision/reviewer.ts";
import { normalizeModelId } from "../decision/modelId.ts";
import { runDetect } from "../patterns/detect.ts";
import { makeWritePattern } from "../patterns/write.ts";
import { loadCuratedKeys, listPatterns, getPattern } from "../patterns/read.ts";
import { readAllEvents } from "../decision/readEvents.ts";

const WORKSPACE =
  process.env.BOULE_WORKSPACE ?? new URL("../../workspace", import.meta.url).pathname;

// Repo root holds the canonical L3/L4 markdown (docs/adr, docs/decisions.md,
// docs/areas/decision-rails.md). Default: two levels up from the workspace
// (<repo>/governance/workspace → <repo>). Overridable for tests/relocation.
const REPO_ROOT = process.env.BOULE_REPO_ROOT ?? resolve(WORKSPACE, "..", "..");

// 비결정 입력은 서버 경계에서만 (핸들러는 순수 유지)
const nowFn = () => new Date();
const randFn = () => Math.random();

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
  { description: "task를 active로 전이 (ready/blocked→active)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await startTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `started: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "block_task",
  { description: "task를 blocked로 전이 (사유 기록)", inputSchema: { taskId: z.string(), reason: z.string() } },
  async ({ taskId, reason }) => {
    const r = await blockTask(WORKSPACE, { taskId, reason }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `blocked: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "complete_task",
  { description: "task를 done으로 전이 (미해소 decision_blocked 있으면 거부)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await completeTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `completed: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "cancel_task",
  { description: "task를 cancelled로 전이 (terminal)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await cancelTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `cancelled: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "tasks",
  { description: "비종료(non-terminal) task 목록", inputSchema: {} },
  async () => {
    const list = await listTasks(WORKSPACE);
    const text = list.length ? list.map((t) => `${t.taskId} [${t.phase}] ${t.title}`).join("\n") : "(no open tasks)";
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
    description: "Planner: intent + 단계 목록을 draft plan_proposed 이벤트 하나로 기록 (propose-only)",
    inputSchema: { intent: z.string(), steps: z.array(z.string()) },
  },
  async ({ intent, steps }) => {
    const r = await proposePlan(WORKSPACE, { intent, steps }, nowFn(), randFn());
    return { content: [{ type: "text", text: `plan proposed (draft): ${r.planId}` }] };
  },
);

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
  { description: "plan을 needs_revision으로 (active→needs_revision, 사유 기록)", inputSchema: { planId: z.string(), reason: z.string() } },
  async ({ planId, reason }) => {
    const r = await revisePlan(WORKSPACE, { planId, reason }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `revision requested: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "complete_plan",
  { description: "plan을 completed로 (active→completed, terminal)", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const r = await completePlan(WORKSPACE, { planId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `completed: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "archive_plan",
  { description: "plan을 archived로 (terminal)", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const r = await archivePlan(WORKSPACE, { planId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `archived: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "supersede_plan",
  { description: "plan을 superseded로 (새 plan이 대체, terminal)", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const r = await supersedePlan(WORKSPACE, { planId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `superseded: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "plans",
  { description: "비종료(non-terminal) plan 목록", inputSchema: {} },
  async () => {
    const list = await listPlans(WORKSPACE);
    const text = list.length ? list.map((p) => `${p.planId} [${p.phase}] ${p.title}`).join("\n") : "(no open plans)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "plan",
  { description: "plan 상태 + audit chain", inputSchema: { planId: z.string() } },
  async ({ planId }) => {
    const t = await planTrail(WORKSPACE, { planId });
    const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
    return { content: [{ type: "text", text: `${t.planId} [${t.phase}] ${t.title}\n${chain}` }] };
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
    return { content: [{ type: "text", text: r.ok ? `archived: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "specs",
  { description: "비종료(non-archived) spec 목록", inputSchema: {} },
  async () => {
    const list = await listSpecs(WORKSPACE);
    const text = list.length ? list.map((sp) => `${sp.specId} [${sp.phase}] ${sp.title}`).join("\n") : "(no open specs)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "spec",
  { description: "spec 상태 + audit chain", inputSchema: { specId: z.string() } },
  async ({ specId }) => {
    const t = await specTrail(WORKSPACE, { specId });
    const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
    return { content: [{ type: "text", text: `${t.specId} [${t.phase}] ${t.title}\n${chain}` }] };
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
        { type: "text", text: `harvested: ${summary.written} new, ${summary.skipped} already-seen` },
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

const AUTHOR_MODEL = process.env.BOULE_AUTHOR_MODEL ?? "claude";
const REVIEWER_MODEL = process.env.BOULE_REVIEWER_MODEL ?? "external-stub";
const QUORUM = parseQuorum(process.env.BOULE_REVIEW_QUORUM);
// BOULE_REVIEWER_MODELS=codex,gemini 리스트(정규화 dedup) → 없으면 단수 BOULE_REVIEWER_MODEL로 폴백.
const REVIEWER_MODELS = parseReviewerModels(process.env.BOULE_REVIEWER_MODELS, REVIEWER_MODEL);

function placeholderReviewFor(model: string): ReviewFn {
  return async (req) => ({
    verdict: "concerns",
    rationale: `[placeholder reviewer — set BOULE_REVIEWER_MODE=live to wire a real model] reviewed "${req.title}".`,
    reviewerModel: model,
  });
}

function liveReviewFor(model: string): ReviewFn {
  // Per-model CMD/ARGS resolution (falls back to the globals, then a safe read-only default),
  // so a ≥2 distinct-model live quorum runs genuinely different binaries — not one CLI relabeled.
  const { command, args: argsTemplate } = resolveReviewerCommand(model, process.env);
  const realSpawn: SpawnLike = (cmd, args) => nodeSpawn(cmd, args) as unknown as ChildLike;
  return liveReview({
    spawn: realSpawn,
    command,
    buildArgs: () => argsTemplate, // prompt is fed via stdin, not argv
    buildPrompt: defaultReviewPrompt,
    reviewerModel: model,
    parse: parseVerdict,
    timeoutMs: Number(process.env.BOULE_REVIEWER_TIMEOUT_MS ?? 120000),
    maxAttempts: Number(process.env.BOULE_REVIEWER_MAX_ATTEMPTS ?? 2),
    backoffMs: 500,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (cb, ms) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
    rand: Math.random,
    log: (line) => process.stderr.write(`${line}\n`), // PII-safe (size/attempt/exit only)
  });
}

// 비결정(서브프로세스/타이머/Math.random)은 이 경계에서만 주입. 기본 = stub(결정적·CI 무변경).
// BOULE_REVIEWER_MODE=live 일 때만 작성자와 다른 모델 CLI를 bounded retry로 호출.
// 각 모델은 resolveReviewerCommand로 자기 CMD/ARGS를 해석(per-model override → 전역 → 안전 기본).
const LIVE = process.env.BOULE_REVIEWER_MODE === "live";

function buildReviewers(): ReviewerEntry[] {
  return REVIEWER_MODELS.map((model) => ({
    model,
    fn: LIVE ? liveReviewFor(model) : placeholderReviewFor(model),
  }));
}

const reviewers = buildReviewers();

// Genuine-quorum advisory (warn-but-continue): live + quorum≥2 인데 라벨들이 동일 (cmd,args)로
// 붕괴해 distinct reviewer가 quorum 미만이면 가짜 quorum. PII-safe(라벨만)로 경고하고 그대로 기동.
const quorumWarning = LIVE
  ? quorumCollisionWarning(REVIEWER_MODELS, process.env, QUORUM)
  : null;
if (quorumWarning) process.stderr.write(`${quorumWarning}\n`);

server.registerTool(
  "propose_decision",
  {
    description: "Type 1(비가역) 결정을 decision_proposed L0 이벤트로 제안",
    inputSchema: { title: z.string(), body: z.string().default("") },
  },
  async ({ title, body }) => {
    const r = await proposeDecision(WORKSPACE, { title, body }, nowFn(), randFn());
    return { content: [{ type: "text", text: `decision proposed: ${r.id} (needs external review)` }] };
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
    const distinctModels = new Set(res.recorded.map((r) => normalizeModelId(r.reviewerModel))).size;
    const parts = [
      `recorded: ${res.recorded.length} from ${reviewers.length} reviewer(s); distinct models: ${distinctModels}/${QUORUM} (quorum)`,
    ];
    if (res.skipped.length) parts.push(`skipped: ${res.skipped.map((s) => s.reviewerModel).join(",")}`);
    if (res.failures.length) parts.push(`failed: ${res.failures.map((f) => f.reviewerModel).join(",")}`);
    // Surface a silent fake-quorum right where the operator reads the distinct-model count.
    if (quorumWarning) parts.push(quorumWarning);
    return { content: [{ type: "text", text: parts.join(" | ") }] };
  },
);

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
    const text = `${t.title} [${t.phase}]\n` + t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "history",
  { description: "결정 이력(why의 별칭)", inputSchema: { decisionId: z.string() } },
  async ({ decisionId }) => {
    const t = await history(WORKSPACE, { decisionId }, QUORUM);
    const text = `${t.title} [${t.phase}]\n` + t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

// v2 slice1 — escalation round-trip. AGENT-VISIBLE: a running session may escalate a fork.
server.registerTool(
  "escalate",
  {
    description: "Type 0 에스컬레이션 방출 (decision_proposed + decision_blocked) — append-only, verdict 없음",
    inputSchema: {
      question: z.string(),
      options: z.array(z.object({ label: z.string() })).min(2),
      ambiguity_kind: z.string().optional(),
      agent_recommendation: z.string().optional(),
    },
  },
  async ({ question, options, ambiguity_kind, agent_recommendation }) => {
    const r = await escalate(
      WORKSPACE,
      {
        question,
        options,
        ambiguityKind: ambiguity_kind as never,
        agentRecommendation: agent_recommendation,
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
    description: "미해소 Type 0 에스컬레이션 목록 (decision_blocked, verdict 없음) — read-only, bridge용",
    inputSchema: {},
  },
  async () => {
    const list = await pendingEscalations(WORKSPACE);
    return { content: [{ type: "text", text: JSON.stringify(list) }] };
  },
);

// v2 slice1 — BRIDGE/HUMAN-ONLY: only the Telegram bridge calls this, on an exact token match.
// Human-gated (actor:user) but NOT review-gated — a Type 0 tap is a direction-pick, not an ADR approval.
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

await server.connect(new StdioServerTransport());
