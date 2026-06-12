import { spawn } from "node:child_process";
import { parseArgs, commandTokenIndex, type ParsedArgs } from "./args.ts";
import { boulePaths } from "../repo/paths.ts";
import {
  defaultConfig,
  parseBouleConfig,
  routingConfigSchema,
  resolvePolicy,
  type BouleConfig,
  type Kind,
  type RoutingConfig,
} from "../repo/config.ts";
import {
  assertProviderAllowed,
  backendsConfigSchema,
  type BackendsConfig,
  type BackendSpec,
} from "../backends/config.ts";
import { priceTableSchema, type PriceTable } from "../backends/budget.ts";
import { initRepo } from "../repo/scaffold.ts";
import {
  readConfig,
  writeConfig,
  writeMcpConfig,
  loadPolicyOrStrict,
  repoEnv,
  serverEntrypoint,
} from "../repo/configIo.ts";
import {
  makeConductorAdapterFromEnv,
  makeExecutorViabilityProbesFromEnv,
} from "../conductor/fromEnv.ts";
import { evaluatorCompletionOptions } from "../conductor/evaluateLive.ts";
import { ensureCmuxSocketEnv } from "../conductor/cmuxSocket.ts";
import { readUsageFromStdoutFile } from "../conductor/usageParse.ts";
import type { ExecutorKind } from "../conductor/envelope.ts";
import { policyBudgetContext } from "../backends/resolve.ts";
import { listUnmergedPlanBranches } from "../repo/planBranches.ts";
import { makeNodeSpawnSync, type SpawnSyncLike } from "../repo/spawn.ts";
import { parseEnvelopeDefaults } from "../mcp/config.ts";
import { computeRepoReadiness } from "../live/repoReadiness.ts";
import { runTick, clampMaxSteps, tickExitCode, type TickReport } from "../orchestrator/tick.ts";
import { acquireTickLock, clampLockTtlMs } from "../orchestrator/tickLock.ts";
import {
  clampSyncTimeoutMs,
  maybeRunEscalationSync,
  type EscalationSyncDeps,
} from "./escalationSync.ts";
import { cmdSchedule } from "./schedule.ts";
import { recordExecutorAttempt, reportTaskDone } from "../task/handlers.ts";
import { closeSession, requestSessionClose } from "../session/handlers.ts";
import { makeObserverAdapterFromEnv, observeSessions } from "../session/observer.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { buildControlRoomSnapshot } from "../snapshot/snapshot.ts";
import {
  runHarvest,
  runDetectStage,
  runHypothesisTest,
  runMetaObserve,
  runArchivePrune,
} from "../observation/chain.ts";

// `boule` CLI (spec 2026-06-07 §D): per-repo launcher + settings admin. DB-free — the work-radar
// app drives discovery of designated local repos and calls `init`/`set` per repo with explicit
// args (keeps the governance package decoupled from the app sqlite, decision #3).

// parseArgs moved to args.ts (shared with schedule.ts); re-exported so existing importers keep working.
export { parseArgs, type ParsedArgs } from "./args.ts";

function reqRepo(flags: ParsedArgs["flags"]): string {
  const repo = flags.repo;
  if (typeof repo !== "string" || !repo) throw new Error("--repo <path> is required");
  return repo;
}
function asKind(v: unknown): Kind {
  if (v !== "personal" && v !== "work")
    throw new Error(`--kind must be personal|work (got ${String(v)})`);
  return v;
}

/** init: scaffold <repo>/.boule for a kind. kind via --kind (the app passes it from the DB). */
export async function cmdInit(flags: ParsedArgs["flags"]): Promise<string> {
  const repo = reqRepo(flags);
  const kind = asKind(flags.kind);
  const config = defaultConfig(kind, {
    projectId: typeof flags["project-id"] === "string" ? flags["project-id"] : undefined,
    projectName: typeof flags["project-name"] === "string" ? flags["project-name"] : undefined,
  });
  const r = await initRepo(repo, config, { overwrite: flags.overwrite === true });
  return `${r.created ? "initialized" : "refreshed"} ${r.paths.dir} (kind=${kind})`;
}

/** set: mutate boule.config.json (the CLI half of "changeable from settings") + regen mcp.json. */
export async function cmdSet(flags: ParsedArgs["flags"]): Promise<string> {
  const repo = reqRepo(flags);
  const current: BouleConfig = await readConfig(repo);
  const parsedOverrides = parseStructuredOverrideFlags(flags);
  const overrides = { ...(current.overrides ?? {}) };
  if (flags["autonomy-level"] !== undefined) {
    const l = flags["autonomy-level"];
    if (l !== "manual" && l !== "dispatch" && l !== "auto_plan" && l !== "full")
      throw new Error("--autonomy-level must be manual|dispatch|auto_plan|full");
    overrides.autonomyLevel = l;
  }
  if (flags["review-quorum"] !== undefined) {
    const n = Number(flags["review-quorum"]);
    if (!Number.isInteger(n) || n < 1) throw new Error("--review-quorum must be an integer >= 1");
    overrides.reviewQuorum = n;
  }
  if (parsedOverrides.backendsProvided) {
    if (parsedOverrides.backends === null) delete overrides.backends;
    else overrides.backends = parsedOverrides.backends;
  }
  if (parsedOverrides.routingProvided) {
    if (parsedOverrides.routing === null) delete overrides.routing;
    else overrides.routing = parsedOverrides.routing;
  }
  if (parsedOverrides.priceTableProvided) {
    if (parsedOverrides.priceTable === null) delete overrides.priceTable;
    else overrides.priceTable = parsedOverrides.priceTable;
  }
  const next: BouleConfig = {
    ...current,
    kind: flags.kind !== undefined ? asKind(flags.kind) : current.kind,
    overrides: Object.keys(overrides).length ? overrides : undefined,
  };
  parseBouleConfig(next); // validate before persisting
  await writeConfig(repo, next);
  await writeMcpConfig(repo, resolvePolicy(next));
  return `updated ${boulePaths(repo).config} (kind=${next.kind})`;
}

interface StructuredOverrideFlags {
  backendsProvided: boolean;
  backends?: BackendsConfig | null;
  routingProvided: boolean;
  routing?: RoutingConfig | null;
  priceTableProvided: boolean;
  priceTable?: PriceTable | null;
}

function parseStructuredOverrideFlags(flags: ParsedArgs["flags"]): StructuredOverrideFlags {
  const parsed: StructuredOverrideFlags = {
    backendsProvided: false,
    routingProvided: false,
    priceTableProvided: false,
  };

  if (flags.backends !== undefined) {
    parsed.backendsProvided = true;
    const raw = parseJsonFlag(flags, "backends");
    if (isClearValue(raw)) {
      parsed.backends = null;
    } else {
      const backends = backendsConfigSchema.parse(raw);
      validateBackendsProviders(backends);
      parsed.backends = backends;
    }
  }

  if (flags.routing !== undefined) {
    parsed.routingProvided = true;
    const raw = parseJsonFlag(flags, "routing");
    if (isClearValue(raw)) {
      parsed.routing = null;
    } else {
      const routing = routingConfigSchema.parse(raw);
      validateRoutingProviders(routing);
      parsed.routing = routing;
    }
  }

  if (flags["price-table"] !== undefined) {
    parsed.priceTableProvided = true;
    const raw = parseJsonFlag(flags, "price-table");
    if (isClearValue(raw)) {
      parsed.priceTable = null;
    } else {
      parsed.priceTable = priceTableSchema.parse(raw);
    }
  }

  return parsed;
}

function parseJsonFlag(flags: ParsedArgs["flags"], name: string): unknown {
  const raw = flags[name];
  if (typeof raw !== "string") throw new Error(`--${name} <json> is required`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new Error(`--${name} must be valid JSON${detail}`);
  }
}

function isClearValue(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function validateBackendsProviders(backends: BackendsConfig): void {
  for (const spec of backends.executor?.chain ?? []) assertProviderAllowed("executor", spec);
  for (const reviewer of backends.reviewers ?? []) {
    for (const spec of reviewer.chain) assertProviderAllowed("reviewer", spec);
  }
}

function validateRoutingProviders(routing: RoutingConfig): void {
  for (const spec of routingSpecs(routing)) assertProviderAllowed("executor", spec);
}

function routingSpecs(routing: RoutingConfig): BackendSpec[] {
  const executor = routing.executor;
  if (!executor) return [];
  const specs: BackendSpec[] = [];
  if (executor.trivial) specs.push(executor.trivial);
  if (executor.standard) specs.push(executor.standard);
  if (executor.hard) specs.push(executor.hard);
  return specs;
}

/** report-exit: executor-side clean-exit hint from OUTSIDE the MCP round-trip. It never writes
 *  task_completed; the conductor's completion gate is the only path that may certify completion. */
export async function cmdReportExit(flags: ParsedArgs["flags"]): Promise<string> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : "";
  const task = typeof flags.task === "string" ? flags.task : "";
  if (!workspace) throw new Error("--workspace <path> is required");
  if (!task) throw new Error("--task <id> is required");
  const r = await reportTaskDone(workspace, { taskId: task }, new Date(), Math.random());
  if (!r.ok) return `REFUSED: ${r.reason}`;
  // Clean exit ALSO closes the session via the documented two-step lifecycle (request_close →
  // close): the executor process is gone but its cmux pane stays open, so without this the
  // session never reaches a terminal phase and the completion gate waits forever (the observer
  // deliberately never auto-closes — §18.3; crash detection stays its job). Best-effort: a
  // close refusal (e.g. already closed) never fails the exit hint.
  let closeNote = "no session to close";
  if (r.sessionId) {
    const req = await requestSessionClose(
      workspace,
      { sessionId: r.sessionId },
      new Date(),
      Math.random(),
    );
    if (req.ok) {
      const closed = await closeSession(
        workspace,
        { sessionId: r.sessionId },
        new Date(Date.now() + 1000),
        Math.random(),
      );
      closeNote = closed.ok ? `session closed: ${r.sessionId}` : `close refused: ${closed.reason}`;
    } else {
      closeNote = `close request refused: ${req.reason}`;
    }
  }
  return `reported: ${r.eventId} (${closeNote})`;
}

function reqFlag(flags: ParsedArgs["flags"], name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} <value> is required`);
  return value;
}

function reqIntegerFlag(flags: ParsedArgs["flags"], name: string): number {
  const raw = reqFlag(flags, name);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}

function reqBooleanFlag(flags: ParsedArgs["flags"], name: string): boolean {
  const raw = reqFlag(flags, name);
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${name} must be true|false`);
}

function optionalNonnegativeNumberFlag(
  flags: ParsedArgs["flags"],
  name: string,
): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw) throw new Error(`--${name} <number> is required`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`--${name} must be a nonnegative number`);
  return value;
}

/** Optional `--executor claude|codex` (the wrapper threads its executor kind so the usage parse
 *  knows which stdout shape to expect). Anything else ⇒ undefined — usage parsing is fail-soft
 *  observability, so an unknown kind degrades to usage:"unknown", never an error. */
function optionalExecutorFlag(flags: ParsedArgs["flags"]): ExecutorKind | undefined {
  const raw = flags.executor;
  return raw === "claude" || raw === "codex" ? raw : undefined;
}

export async function cmdRecordAttempt(flags: ParsedArgs["flags"]): Promise<string> {
  const workspace = reqFlag(flags, "workspace");
  const task = reqFlag(flags, "task");
  const attemptIndex = reqIntegerFlag(flags, "attempt");
  const exitCode = reqIntegerFlag(flags, "exit-code");
  const launched = reqBooleanFlag(flags, "launched");
  const worktreeDirty = reqBooleanFlag(flags, "worktree-dirty");
  const stderrDigest =
    typeof flags["stderr-digest"] === "string" && flags["stderr-digest"]
      ? flags["stderr-digest"]
      : undefined;
  let usageTokens = optionalNonnegativeNumberFlag(flags, "usage-tokens");
  let usageCostUsd = optionalNonnegativeNumberFlag(flags, "usage-cost");
  // P4b — parse usage from the wrapper-captured executor stdout (fail-soft: any read/parse failure
  // leaves usage "unknown" — the pre-existing behavior — and NEVER fails the record). Explicit
  // --usage-tokens/--usage-cost flags are direct assertions and win over the file parse.
  const usageStdoutFile = flags["usage-stdout-file"];
  const executor = optionalExecutorFlag(flags);
  if (
    usageTokens === undefined &&
    usageCostUsd === undefined &&
    typeof usageStdoutFile === "string" &&
    usageStdoutFile &&
    executor
  ) {
    const parsed = await readUsageFromStdoutFile(usageStdoutFile, executor);
    if (parsed) {
      usageTokens = parsed.tokens;
      usageCostUsd = parsed.costUsd;
    }
  }
  const r = await recordExecutorAttempt(
    workspace,
    {
      taskId: task,
      attemptIndex,
      exitCode,
      launched,
      worktreeDirty,
      ...(stderrDigest ? { stderrDigest } : {}),
      ...(usageTokens !== undefined ? { usageTokens } : {}),
      ...(usageCostUsd !== undefined ? { usageCostUsd } : {}),
    },
    new Date(),
    Math.random(),
  );
  return r.ok ? `recorded-attempt: ${r.eventId}` : `REFUSED: ${r.reason}`;
}

/** status: print the resolved policy + paths (read-only; shows fail-closed fallback if config bad). */
export async function cmdStatus(flags: ParsedArgs["flags"]): Promise<string> {
  const repo = reqRepo(flags);
  const loaded = await loadPolicyOrStrict(repo);
  const p = boulePaths(repo);
  const lines = [
    `repo: ${repo}`,
    `policy source: ${loaded.source}${loaded.reason ? ` (${loaded.reason})` : ""}`,
    `kind: ${loaded.policy.kind}`,
    `autonomyLevel: ${loaded.policy.autonomyLevel}${
      loaded.policy.autonomyLevel === "auto_plan" || loaded.policy.autonomyLevel === "full"
        ? "  ⚠️ AI accepts plan/spec (INVARIANT #1 opened — test/dev)"
        : ""
    }`,
    `autoMode: ${loaded.policy.autoMode}  reviewQuorum: ${loaded.policy.reviewQuorum}`,
    `forbiddenDecisionClasses: ${loaded.policy.forbiddenDecisionClasses.join(", ")}`,
    `allowedType2Actions: ${loaded.policy.allowedType2Actions.join(", ")}`,
    `backends: ${formatBackendsStatus(loaded.policy.backends)}`,
    `routing: ${formatRoutingStatus(loaded.policy.routing)}`,
    `priceTable: ${formatPriceTableStatus(loaded.policy.priceTable)}`,
    `workspace: ${p.workspace}`,
    `worktrees: ${p.worktrees}`,
    `mcp.json: ${p.mcp}`,
  ];
  return lines.join("\n");
}

/** Test seam for cmdSnapshot's git side channel (never used by production callers). */
export interface CmdSnapshotSeams {
  unmergedBranches?: { spawn?: SpawnSyncLike };
}

/** snapshot: read-only live Control Room fold over <repo>/.boule/workspace/events.
 *  `unmergedPlanBranches` (P4a) is ADDITIVE and fail-soft: omitted entirely when the git listing
 *  fails (non-repo / git absent) — the app's snapshot deserializer ignores unknown fields
 *  (src-tauri snapshot.rs has no deny_unknown_fields), so old apps parse this output unchanged. */
export async function cmdSnapshot(
  flags: ParsedArgs["flags"],
  seams: CmdSnapshotSeams = {},
): Promise<string> {
  const repo = reqRepo(flags);
  const events = await readAllEvents(boulePaths(repo).workspace);
  const { readiness } = await computeRepoReadiness(repo);
  const unmerged = listUnmergedPlanBranches(repo, {
    spawn: seams.unmergedBranches?.spawn ?? makeNodeSpawnSync(),
  });
  return JSON.stringify({
    ...buildControlRoomSnapshot(events),
    ...(unmerged !== null ? { unmergedPlanBranches: unmerged } : {}),
    infra: readiness.preflight.checks,
    readiness: {
      ready: readiness.ready,
      blockers: readiness.blockers,
      warnings: readiness.warnings,
      gates: readiness.gates,
    },
  });
}

function formatBackendsStatus(backends: BackendsConfig | undefined): string {
  if (!backends) return "unset";
  const executor = backends.executor
    ? `executor chain ${backends.executor.chain.length}`
    : "executor unset";
  const reviewerLengths = (backends.reviewers ?? []).map((reviewer) => reviewer.chain.length);
  const reviewers = backends.reviewers
    ? `reviewers ${backends.reviewers.length} [${reviewerLengths.join(",")}]`
    : "reviewers unset";
  const evaluator = backends.evaluator
    ? `evaluator chain ${backends.evaluator.chain.length}`
    : "evaluator unset";
  return `SET (${executor}, ${reviewers}, ${evaluator})`;
}

function formatRoutingStatus(routing: RoutingConfig | undefined): string {
  if (!routing) return "unset";
  const executor = routing.executor;
  const difficulties = [
    executor?.trivial ? "trivial" : undefined,
    executor?.standard ? "standard" : undefined,
    executor?.hard ? "hard" : undefined,
  ].filter((difficulty) => difficulty !== undefined);
  return `SET (executor difficulties: ${difficulties.length ? difficulties.join(", ") : "none"})`;
}

function formatPriceTableStatus(priceTable: PriceTable | undefined): string {
  if (!priceTable) return "unset";
  return `SET (providers ${Object.keys(priceTable).length})`;
}

/** run: exec the governance MCP server scoped to this repo's policy env (stdio passthrough). */
export async function cmdRun(flags: ParsedArgs["flags"]): Promise<number> {
  const repo = reqRepo(flags);
  const loaded = await loadPolicyOrStrict(repo);
  if (loaded.source === "fallback") {
    process.stderr.write(
      `boule: WARN config unreadable, using STRICT fallback policy (${loaded.reason})\n`,
    );
  }
  const env = { ...process.env, ...repoEnv(repo, loaded.policy) };
  return await new Promise<number>((res) => {
    const child = spawn("node", ["--experimental-strip-types", serverEntrypoint()], {
      env,
      stdio: "inherit",
    });
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`boule: failed to launch server: ${e.message}\n`);
      res(1);
    });
  });
}

function formatTick(r: TickReport): string {
  const lines = [`tick: ${r.outcome} (conducted=${r.conducted}, max-step blast-radius respected)`];
  if (r.specsAccepted || r.plansAccepted)
    lines.push(`  auto-accepted: ${r.specsAccepted} spec, ${r.plansAccepted} plan`);
  if (r.haltedPlans.length) lines.push(`  halted plans: ${r.haltedPlans.join(", ")}`);
  if (r.stalledCount) lines.push(`  stalled tasks: ${r.stalledCount}`);
  if (r.escalationSync) lines.push(`  escalation sync: ${r.escalationSync}`);
  if (r.unmergedPlanBranches?.length) {
    lines.push(`  awaiting human merge-back: ${r.unmergedPlanBranches.length} plan branch(es)`);
    for (const b of r.unmergedPlanBranches)
      lines.push(
        `    ${b.branch} @ ${b.tip}${b.aheadCount !== null ? ` (+${b.aheadCount})` : ""} — ${b.subject}`,
      );
  }
  for (const b of r.blockers) lines.push(`  ✗ ${b}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

/** Test seams for cmdTick's side channels (never used by production callers). */
export interface CmdTickSeams {
  escalationSync?: EscalationSyncDeps;
  unmergedBranches?: { spawn?: SpawnSyncLike };
}

/** tick: ONE bounded auto-dispatch heartbeat (external cron/operator provides cadence — NOT a
 *  daemon, INVARIANT #5). Readiness/halt/stall gated; conducts <=--max-steps; reports + exits. */
export async function cmdTick(flags: ParsedArgs["flags"], seams: CmdTickSeams = {}): Promise<number> {
  const repo = reqRepo(flags);
  // P3a tick mutex — two clocks exist (in-app tokio ticker + launchd StartInterval); an advisory
  // workspace lock keeps them from double-conducting. Acquired BEFORE the observer reconcile so a
  // locked tick writes ZERO events. Held-and-fresh ⇒ benign no-op (outcome "locked", exit 0).
  const lock = await acquireTickLock(boulePaths(repo).workspace, new Date(), {
    ttlMs: clampLockTtlMs(process.env.BOULE_TICK_LOCK_TTL_MS),
  });
  if (!lock.acquired) {
    const report: TickReport = {
      outcome: "locked",
      conducted: 0,
      specsAccepted: 0,
      plansAccepted: 0,
      haltedPlans: [],
      stalledCount: 0,
      blockers: [],
      warnings: [
        `tick lock held (pid ${lock.holder?.pid ?? "?"} since ${lock.holder?.acquiredAt ?? "?"}) — another tick is running; this one is a benign no-op`,
      ],
    };
    process.stdout.write((flags.json === true ? JSON.stringify(report) : formatTick(report)) + "\n");
    return tickExitCode(report.outcome);
  }
  try {
    return await runTickLocked(repo, flags, seams);
  } finally {
    await lock.release();
  }
}

async function runTickLocked(
  repo: string,
  flags: ParsedArgs["flags"],
  seams: CmdTickSeams,
): Promise<number> {
  // P1c — resolve a cmux socket (env → config → discovery) BEFORE any cmux spawn: the observer
  // reconcile + the live adapter's children inherit process.env. All-fail ⇒ env untouched ⇒
  // preflight fails exactly as before (no headless degrade).
  await ensureCmuxSocketEnv(repo);
  // ONE bounded session reconcile (live observer only — a stub's empty surface set would
  // crash every known session). Runs BEFORE readiness so this tick's stall count already
  // reflects vanished surfaces; previously observe_sessions was MCP-manual-only, so a
  // crashed pane was never detected by the app-driven loop.
  {
    const obs = makeObserverAdapterFromEnv(process.env);
    if (obs.live) {
      const summary = await observeSessions(
        boulePaths(repo).workspace,
        { adapter: obs.adapter },
        new Date(),
        Math.random(),
      );
      process.stderr.write(
        `boule: observe observed=${summary.observed} crashed=${summary.crashed} ` +
          `recovered=${summary.recovered} opened=${summary.opened}\n`,
      );
    }
  }
  const rr = await computeRepoReadiness(repo);
  if (rr.source === "fallback")
    process.stderr.write(`boule: WARN config unreadable, STRICT fallback (${rr.reason})\n`);
  const { policy, env, cfg, stalledCount, readiness } = rr;
  const p = boulePaths(repo);

  // P2b (ADR-0010 last mile): the LLM evaluator rung is reachable ONLY when the policy configures
  // backends.evaluator — otherwise undefined keeps the legacy deterministic-rung-only behavior.
  const completionOptions = evaluatorCompletionOptions(policy, env);
  // P4b (ADR-0010 budget rail): thread the policy's OPTIONAL budget caps/priceTable into TickDeps
  // so dispatch-time budget filtering runs with explicit context. Unconfigured ⇒ undefined ⇒
  // byte-identical legacy behavior. The spend snapshot itself is journal-reconstructed at the
  // dispatch site (handlers.budgetContextFromJournal) — unknown-usage attempts reserve max.
  const budget = policyBudgetContext(policy);

  const report = await runTick(
    p.workspace,
    {
      adapter: makeConductorAdapterFromEnv(env, {
        workspace: p.workspace,
        repoRoot: repo,
        serverEntrypoint: serverEntrypoint(),
      }),
      executor: cfg.executor,
      envelopeDefaults: parseEnvelopeDefaults(env),
      policy,
      ...(budget ? { budget } : {}),
      viability: makeExecutorViabilityProbesFromEnv(env, { workspace: p.workspace }),
      readiness,
      autonomyLevel: policy.autonomyLevel,
      autoMode: policy.autoMode,
      maxSteps: clampMaxSteps(flags["max-steps"], env.BOULE_TICK_MAX),
      stalledCount,
      ...(completionOptions ? { completionOptions } : {}),
    },
    new Date(),
    Math.random(),
  );

  // P3c — opt-in outbound escalation reach: when this tick ENDS with pending escalations and the
  // repo configures `escalationSync`, run it ONCE (bounded). Strictly non-blocking: the outcome
  // is recorded in the report and NEVER changes the tick exit code (a broken notifier must not
  // masquerade as a broken loop).
  const sync = await maybeRunEscalationSync({
    repoRoot: repo,
    workspace: p.workspace,
    now: new Date(),
    env: process.env,
    deps: {
      timeoutMs: clampSyncTimeoutMs(process.env.BOULE_ESCALATION_SYNC_TIMEOUT_MS),
      ...(seams.escalationSync ?? {}),
    },
  });
  // P4a — surface completed-but-unmerged boule/<planId> branches in the tick report (fail-soft:
  // a failed git listing OMITS the field and never changes the tick outcome/exit code — this is
  // observability for the human merge-back, not a gate).
  const unmerged = listUnmergedPlanBranches(repo, {
    spawn: seams.unmergedBranches?.spawn ?? makeNodeSpawnSync(),
  });
  const finalReport: TickReport = {
    ...report,
    ...(sync ? { escalationSync: sync } : {}),
    ...(unmerged !== null ? { unmergedPlanBranches: unmerged } : {}),
  };

  process.stdout.write(
    (flags.json === true ? JSON.stringify(finalReport) : formatTick(finalReport)) + "\n",
  );
  return tickExitCode(finalReport.outcome);
}

/** housekeep: ONE bounded observation-chain pass (harvest → detect → hypothesis-test →
 *  meta-observe → archive-prune). The slow-timescale heartbeat of the SSOT design — external
 *  cron/operator provides cadence (NOT a daemon, INVARIANT #5). Writes stay inside the
 *  repo's .boule/workspace (L0 events content-addressed, L1 patterns, L2 hypotheses,
 *  meta/proposals); ZERO decision-rail writes — meta output is a propose-only draft file.
 *  No transaction across stages: a mid-chain throw exits 1 with earlier stages applied —
 *  safe BECAUSE every stage is idempotent/content-addressed (the next pass reconciles). */
export async function cmdHousekeep(flags: ParsedArgs["flags"]): Promise<number> {
  const repo = reqRepo(flags);
  const ws = boulePaths(repo).workspace;
  const now = new Date();

  const harvested = await runHarvest(repo, ws);
  const detected = await runDetectStage(ws);
  const tested = await runHypothesisTest(ws, now);
  const meta = await runMetaObserve(ws);
  const pruned = await runArchivePrune(ws, now);

  const report = {
    harvested: { written: harvested.written, skipped: harvested.skipped },
    detected: {
      written: detected.written,
      skipped: detected.skipped,
      candidates: detected.candidates,
    },
    hypotheses: tested,
    proposal: meta.persisted ? { id: meta.persisted.id, outcome: meta.persisted.outcome } : null,
    pruned: { hypotheses: pruned.hypotheses, patterns: pruned.patterns },
  };
  process.stdout.write(
    (flags.json === true ? JSON.stringify(report) : formatHousekeep(report)) + "\n",
  );
  return 0;
}

function formatHousekeep(r: {
  harvested: { written: number; skipped: number };
  detected: { written: number; skipped: number; candidates: number };
  hypotheses: { proposed: number; verified: number; refuted: number; skipped: number };
  proposal: { id: string; outcome: string } | null;
  pruned: {
    hypotheses: { moved: number; skipped: number; malformed: number };
    patterns: { moved: number; skipped: number; malformed: number };
  };
}): string {
  return [
    `housekeep:`,
    `  harvested: ${r.harvested.written} new, ${r.harvested.skipped} already-seen`,
    `  patterns: ${r.detected.written} new, ${r.detected.candidates} candidate(s)`,
    `  hypotheses: ${r.hypotheses.proposed} proposed, ${r.hypotheses.verified} verified, ${r.hypotheses.refuted} refuted`,
    `  proposal: ${r.proposal ? `${r.proposal.id} (${r.proposal.outcome})` : "none"}`,
    `  pruned: ${r.pruned.hypotheses.moved} hypotheses, ${r.pruned.patterns.moved} stale patterns`,
  ].join("\n");
}

const USAGE = `boule <command> --repo <path>
  init   --repo <p> --kind <personal|work> [--project-id X] [--project-name Y] [--overwrite]
  set    --repo <p> [--kind k] [--autonomy-level manual|dispatch|auto_plan|full] [--review-quorum n] [--backends json] [--routing json] [--price-table json]
  status --repo <p>
  report-exit --workspace <ws> --task <id>   # executor clean-exit hint (verdict-free)
  record-attempt --workspace <ws> --task <id> --attempt <n> --exit-code <n> --launched true|false --worktree-dirty true|false [--stderr-digest s] [--usage-tokens n] [--usage-cost n] [--usage-stdout-file <path> --executor claude|codex]
  snapshot --repo <p>   # read-only live Control Room snapshot (always JSON on stdout; incl. unmergedPlanBranches)
  run    --repo <p>   # exec the per-repo governance MCP server (stdio)
  tick   --repo <p> [--max-steps n] [--json]   # ONE bounded auto-dispatch heartbeat (cron-driven)
  housekeep --repo <p> [--json]   # ONE bounded observation pass: harvest→detect→test→meta→prune (cron-driven)
  schedule install   --repo <abs> [--interval-sec n>=60 (default 300)] [--max-steps n]   # launchd LaunchAgent (user-invoked·reversible·audited)
  schedule uninstall --repo <abs>   # bootout + remove plist (idempotent)
  schedule status    --repo <abs>   # plist/loaded/interval/log path`;

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  try {
    switch (cmd) {
      case "init":
        process.stdout.write((await cmdInit(flags)) + "\n");
        return 0;
      case "set":
        process.stdout.write((await cmdSet(flags)) + "\n");
        return 0;
      case "status":
        process.stdout.write((await cmdStatus(flags)) + "\n");
        return 0;
      case "report-exit":
        process.stdout.write((await cmdReportExit(flags)) + "\n");
        return 0;
      case "record-attempt":
        process.stdout.write((await cmdRecordAttempt(flags)) + "\n");
        return 0;
      case "snapshot":
        process.stdout.write((await cmdSnapshot(flags)) + "\n");
        return 0;
      case "run":
        return await cmdRun(flags);
      case "tick":
        return await cmdTick(flags);
      case "housekeep":
        return await cmdHousekeep(flags);
      case "schedule": {
        // two-level command: re-parse everything AFTER the `schedule` token as its own argv.
        const rest = argv.slice(commandTokenIndex(argv) + 1);
        process.stdout.write((await cmdSchedule(rest)) + "\n");
        return 0;
      }
      default:
        process.stderr.write(USAGE + "\n");
        return cmd ? 1 : 0;
    }
  } catch (err) {
    process.stderr.write(`boule: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Entrypoint guard: run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
