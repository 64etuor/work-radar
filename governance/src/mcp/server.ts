import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeConductorAdapterFromEnv,
  makeExecutorViabilityProbesFromEnv,
} from "../conductor/fromEnv.ts";
import {
  makeLiveAdapter as makeObserverLiveAdapter,
  stubAdapter as observerStubAdapter,
  type ObserverAdapter,
} from "../session/observer.ts";
import { makeNodeSpawnSync } from "../repo/spawn.ts";
import { VERDICT_TOOL_NAME_SET } from "./verdictTools.ts";
import {
  parseAutoMode,
  parseAutonomyLevel,
  parseConductorConfig,
  parseObserverConfig,
  parseEnvelopeDefaults,
} from "./config.ts";
import { autonomyAllows } from "../repo/config.ts";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildLike, SpawnLike } from "../decision/liveReviewer.ts";
import { parseQuorum, parseReviewerModels, quorumCollisionWarning } from "./config.ts";
import type { ReviewerEntry } from "../decision/reviewer.ts";
import { buildReviewerEntries } from "./reviewers.ts";
import { loadPolicyOrStrict } from "../repo/configIo.ts";
import { openStore } from "../graph/store.ts";
import type { ToolContext } from "./tools/context.ts";
import { registerTaskTools } from "./tools/tasks.ts";
import { registerPlanTools } from "./tools/plans.ts";
import { registerSpecTools } from "./tools/specs.ts";
import { registerKnowledgeTools } from "./tools/knowledge.ts";
import { registerObservationTools, registerArchiveTools } from "./tools/observation.ts";
import { registerDecisionTools } from "./tools/decisions.ts";
import { registerEscalationTools } from "./tools/escalation.ts";
import { registerConductorTools, registerSuggestTools } from "./tools/conductor.ts";
import { registerSessionTools } from "./tools/sessions.ts";
import { registerGraphTools } from "./tools/graph.ts";
import { registerHandoffTools } from "./tools/handoff.ts";

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

// SDK 1.29(실측): server.tool()은 deprecated → registerTool(name, config, cb).
const server = new McpServer({ name: "boule-governance", version: "0.0.1" });

/** The ONLY registration path for verdict tools (INVARIANT #1 structural wall).
 *  - executor role ⇒ no-op: the tool is structurally absent, not merely refused.
 *  - name outside the canonical `VERDICT_TOOL_NAMES` ⇒ throw at startup: gating a tool means
 *    listing it in `verdictTools.ts` first, which also feeds the session CLI denylist
 *    (`SESSION_DENIED_TOOLS`) — single source, no drift.
 *  `test/mcp/verdictGating.test.ts` pins that every canonical name registers through this
 *  helper and never through a bare `server.registerTool`. */
const registerVerdictTool: typeof server.registerTool = ((name, ...rest) => {
  if (!VERDICT_TOOL_NAME_SET.has(name)) {
    throw new Error(
      `registerVerdictTool: "${name}" is not in VERDICT_TOOL_NAMES (verdictTools.ts)`,
    );
  }
  if (!SESSION_ALLOWS_VERDICTS) return undefined;
  return (server.registerTool as (...a: unknown[]) => unknown)(name, ...rest);
}) as typeof server.registerTool;

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
const quorumWarning =
  LIVE && !LOADED_POLICY.policy.backends?.reviewers
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
const EXECUTOR_VIABILITY = makeExecutorViabilityProbesFromEnv(process.env, {
  workspace: WORKSPACE,
});

// ── Phase D: Observer adapter ─────────────────────────────────────────────────
// 기본 = no-op(stub·cmux 무접근). BOULE_OBSERVER_MODE=live 일 때만 실제 `cmux tree --all --json` 어댑터.
// 비-live에서는 observe_sessions가 reconcile하지 않는다(빈 surface 집합에 대해 모든 known
// 세션을 crash 처리하는 footgun 방지). 비결정(spawnSync)은 이 경계에서만 주입.
const OBSERVER_CFG = parseObserverConfig(process.env);
function buildObserverAdapter(): ObserverAdapter {
  if (!OBSERVER_CFG.live) return observerStubAdapter;
  return makeObserverLiveAdapter({
    spawn: makeNodeSpawnSync(),
    cmuxCmd: OBSERVER_CFG.cmuxCmd,
    log: (line) => process.stderr.write(`${line}\n`), // PII-safe (명령명+status+count만)
  });
}
const observerAdapter = buildObserverAdapter();

// v3 Phase F — Postgres+pgvector derived graph index (events+nodes+edges via embedded PGlite).
// Read/rebuild only — NO approve/choose/decision_* surface (master §4.5). One store, opened once.
const graphStore = await openStore(join(WORKSPACE, "index", "pglite"));

// Shared context for all domain registrars. Domain-specific deps (adapters, models, policy…)
// are passed as a second options argument per registrar — this is NOT a mega-context.
const ctx: ToolContext = {
  server,
  registerVerdictTool,
  workspace: WORKSPACE,
  repoRoot: REPO_ROOT,
  now: nowFn,
  rand: randFn,
};

// REGISTRATION ORDER: must reproduce the original tool registration sequence exactly.
// tasks → plans → specs → knowledge → observation(harvest…meta_observe) → decisions →
// escalation → archive(archive_prune/archive_status) → conductor(conduct_plan…readiness) →
// sessions → suggest/suggestions → graph → handoff.
// observation and conductor are each split into two registrar calls to preserve this order.
registerTaskTools(ctx);
registerPlanTools(ctx);
registerSpecTools(ctx);
registerKnowledgeTools(ctx);
registerObservationTools(ctx);
registerDecisionTools(ctx, { authorModel: AUTHOR_MODEL, reviewers, quorum: QUORUM, quorumWarning });
registerEscalationTools(ctx);
registerArchiveTools(ctx);
registerConductorTools(ctx, {
  conductorAdapter,
  conductorCfg: CONDUCTOR_CFG,
  envelopeDefaults: ENVELOPE_DEFAULTS,
  policy: LOADED_POLICY.policy,
  viability: EXECUTOR_VIABILITY,
  autoMode: AUTO_MODE,
  autonomyLevel: AUTONOMY_LEVEL,
});
registerSessionTools(ctx, { observerCfg: OBSERVER_CFG, observerAdapter });
registerSuggestTools(ctx);
registerGraphTools(ctx, { graphStore });
registerHandoffTools(ctx, { graphStore });

await server.connect(new StdioServerTransport());
