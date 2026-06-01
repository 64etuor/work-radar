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

const placeholderReview: ReviewFn = async (req) => ({
  verdict: "concerns",
  rationale: `[placeholder reviewer — set BOULE_REVIEWER_MODE=live to wire a real model] reviewed "${req.title}".`,
  reviewerModel: REVIEWER_MODEL,
});

// 비결정(서브프로세스/타이머/Math.random)은 이 경계에서만 주입. 기본 = stub(결정적·CI 무변경).
// BOULE_REVIEWER_MODE=live 일 때만 작성자와 다른 모델 CLI를 bounded retry로 호출.
function buildReviewer(): ReviewFn {
  if (process.env.BOULE_REVIEWER_MODE !== "live") return placeholderReview;
  const command = process.env.BOULE_REVIEWER_CMD ?? "codex";
  const reviewerModel = process.env.BOULE_REVIEWER_MODEL ?? command;
  const argsTemplate = (process.env.BOULE_REVIEWER_ARGS ?? "exec").split(" ").filter(Boolean);
  const realSpawn: SpawnLike = (cmd, args) => nodeSpawn(cmd, args) as unknown as ChildLike;
  return liveReview({
    spawn: realSpawn,
    command,
    buildArgs: () => argsTemplate, // prompt is fed via stdin, not argv
    buildPrompt: defaultReviewPrompt,
    reviewerModel,
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

const reviewFn = buildReviewer();

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
      [{ model: REVIEWER_MODEL, fn: reviewFn }],
      nowFn(),
      randFn(),
    );
    const ok = res.recorded[0];
    const text = ok
      ? `review recorded: ${ok.verdict} (${ok.reviewEventId})`
      : `no review recorded — failures: ${res.failures.length}, skipped: ${res.skipped.length}` +
        (res.failures[0] ? ` (${res.failures[0].reviewerModel}: ${res.failures[0].error})` : "");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "approve",
  {
    description: "결정 사람 승인(게이트) — 외부검토 없으면 거부",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await approve(WORKSPACE, { decisionId }, nowFn(), randFn());
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
    const list = await conflicts(WORKSPACE);
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
    const t = await why(WORKSPACE, { decisionId });
    const text = `${t.title} [${t.phase}]\n` + t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "history",
  { description: "결정 이력(why의 별칭)", inputSchema: { decisionId: z.string() } },
  async ({ decisionId }) => {
    const t = await history(WORKSPACE, { decisionId });
    const text = `${t.title} [${t.phase}]\n` + t.chain.map((c) => `  ${c.type} (${c.actor}): ${c.summary}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
