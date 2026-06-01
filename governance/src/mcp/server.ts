import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createTask, status, observations } from "./handlers.ts";
import {
  proposeDecision, requestReview, approve, reject, conflicts, why, history,
} from "../decision/handlers.ts";
import type { ReviewFn } from "../decision/reviewer.ts";
import { spawn as nodeSpawn } from "node:child_process";
import {
  liveReview,
  defaultReviewPrompt,
  parseVerdict,
  type SpawnLike,
  type ChildLike,
} from "../decision/liveReviewer.ts";
import { parseQuorum, parseReviewerModels } from "./config.ts";
import type { ReviewerEntry } from "../decision/reviewer.ts";

const WORKSPACE =
  process.env.BOULE_WORKSPACE ?? new URL("../../workspace", import.meta.url).pathname;

// 비결정 입력은 서버 경계에서만 (핸들러는 순수 유지)
const nowFn = () => new Date();
const randFn = () => Math.random();

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
  const command = process.env.BOULE_REVIEWER_CMD ?? "codex";
  const argsTemplate = (process.env.BOULE_REVIEWER_ARGS ?? "exec").split(" ").filter(Boolean);
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
// 모든 모델은 같은 CMD를 공유하고 reviewerModel 라벨로 구분(per-model CMD override는 범위 밖).
function buildReviewers(): ReviewerEntry[] {
  const live = process.env.BOULE_REVIEWER_MODE === "live";
  return REVIEWER_MODELS.map((model) => ({
    model,
    fn: live ? liveReviewFor(model) : placeholderReviewFor(model),
  }));
}

const reviewers = buildReviewers();

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
    const parts = [`recorded: ${res.recorded.length}/${reviewers.length} (quorum ${QUORUM})`];
    if (res.skipped.length) parts.push(`skipped: ${res.skipped.map((s) => s.reviewerModel).join(",")}`);
    if (res.failures.length) parts.push(`failed: ${res.failures.map((f) => f.reviewerModel).join(",")}`);
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

await server.connect(new StdioServerTransport());
