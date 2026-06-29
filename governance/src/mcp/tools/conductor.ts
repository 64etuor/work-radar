import { z } from "zod";
import {
  conductPlan,
  conductorStatus,
  type ConductorEnvelopeDefaults,
  type ExecutorViabilityProbes,
} from "../../conductor/handlers.ts";
import type { ConductorAdapter } from "../../conductor/adapter.ts";
import type { ExecutorKind } from "../../conductor/envelope.ts";
import type { ResolvedPolicy } from "../../repo/config.ts";
import { runPreflight } from "../../live/preflight.ts";
import { evaluateReadiness } from "../../live/readiness.ts";
import { listStalledTasks } from "../../orchestrator/stall.ts";
import { makeNodeSpawnSync } from "../../repo/spawn.ts";
import { runOrchestrationCore, DEFAULT_MAX_CONDUCTS } from "../../orchestrator/core.ts";
import { acquireTickLock } from "../../orchestrator/tickLock.ts";
import { listDispatchLog } from "../../orchestrator/dispatch/project.ts";
import { suggest } from "../../orchestrator/suggest.ts";
import { listSuggestions } from "../../orchestrator/project.ts";
import { refusedText } from "../response.ts";
import type { ToolContext } from "./context.ts";

export type ConductorDeps = {
  conductorAdapter: ConductorAdapter;
  conductorCfg: { executor: ExecutorKind; cmuxCmd: string };
  envelopeDefaults: ConductorEnvelopeDefaults;
  policy: ResolvedPolicy;
  viability: ExecutorViabilityProbes;
  autoMode: "off" | "type2";
  autonomyLevel: "manual" | "dispatch" | "auto_plan" | "full";
};

/** Conductor + live-loop tools (conduct_plan…readiness). suggest/suggestions are registered
 *  separately (after the session block) via registerSuggestTools to preserve the original order. */
export function registerConductorTools(ctx: ToolContext, deps: ConductorDeps): void {
  const {
    server,
    registerVerdictTool,
    workspace: WORKSPACE,
    repoRoot: REPO_ROOT,
    now: nowFn,
    rand: randFn,
  } = ctx;
  const {
    conductorAdapter,
    conductorCfg: CONDUCTOR_CFG,
    envelopeDefaults: ENVELOPE_DEFAULTS,
    policy,
    viability: EXECUTOR_VIABILITY,
    autoMode: AUTO_MODE,
    autonomyLevel: AUTONOMY_LEVEL,
  } = deps;

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
          policy,
          viability: EXECUTOR_VIABILITY,
        },
        nowFn(),
        randFn(),
      );
      if (!r.ok) return refusedText(r.reason ?? "unknown");
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
  // prettier-ignore
  registerVerdictTool(
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
    // Acquire the per-workspace tick lock — same mutex as `boule tick`. Prevents a concurrent
    // tick from double-conducting the same step (INVARIANT #5 blast-radius bound).
    const now = nowFn();
    const lock = await acquireTickLock(WORKSPACE, now);
    if (!lock.acquired) {
      return {
        content: [{ type: "text", text: "tick lock held — boule tick is running, retry shortly" }],
      };
    }
    try {
      const stalledCount = (await listStalledTasks(WORKSPACE)).length;
      // Run through all safety gates (stall → halt → resume → completion → conduct)
      // via the single shared orchestration authority.
      const report = await runOrchestrationCore(
        WORKSPACE,
        {
          adapter: conductorAdapter,
          executor: CONDUCTOR_CFG.executor,
          envelopeDefaults: ENVELOPE_DEFAULTS,
          policy,
          viability: EXECUTOR_VIABILITY,
          autonomyLevel: AUTONOMY_LEVEL,
          autoMode: AUTO_MODE,
          maxSteps: DEFAULT_MAX_CONDUCTS,
          stalledCount,
        },
        now,
        randFn(),
      );
      const parts = [`outcome=${report.outcome}`, `dispatched=${report.conducted}`];
      if (report.specsAccepted || report.plansAccepted) {
        parts.push(
          `auto-accepted ${report.specsAccepted} spec, ${report.plansAccepted} plan @${AUTONOMY_LEVEL}`,
        );
      }
      if (report.haltedPlans.length) parts.push(`halted=${report.haltedPlans.join(",")}`);
      if (report.blockers.length) parts.push(`blockers: ${report.blockers.join("; ")}`);
      return { content: [{ type: "text", text: parts.join(" | ") }] };
    } finally {
      await lock.release();
    }
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
      const report = runPreflight({
        env: process.env,
        spawn: makeNodeSpawnSync(),
        repoRoot: REPO_ROOT,
      });
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
      const realSpawnSync = makeNodeSpawnSync();
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
        : ["readiness ready=false — blockers:", ...report.blockers.map((b) => `  ✗ ${b}`)].join(
            "\n",
          );
      const warns = report.warnings.length
        ? ["\nwarnings (non-blocking — opted in):", ...report.warnings.map((w) => `  ⚠ ${w}`)].join(
            "\n",
          )
        : "";
      return { content: [{ type: "text", text: head + warns }] };
    },
  );
}

/** Orchestrator suggestion tools: suggest, suggestions. Registered AFTER the session block by
 *  server.ts to reproduce the original registration order. */
export function registerSuggestTools(ctx: ToolContext): void {
  const { server, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;

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
        content: [
          { type: "text", text: `suggestions created ${r.created} / skipped ${r.skipped}` },
        ],
      };
    },
  );
  server.registerTool(
    "suggestions",
    { description: "open orchestrator 제안 목록 (read-only)", inputSchema: {} },
    async () => {
      const list = await listSuggestions(WORKSPACE);
      const text = list.length
        ? list
            .map((s) => `${s.id} [${s.rule}] ${s.subjectType}=${s.subject} ${s.detail}`)
            .join("\n")
        : "(no open suggestions)";
      return { content: [{ type: "text", text }] };
    },
  );
}
