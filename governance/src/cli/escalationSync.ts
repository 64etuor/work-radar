import { spawn as nodeSpawn } from "node:child_process";
import type { ChildLike } from "../decision/liveReviewer.ts";
import { pendingEscalations } from "../escalate/pending.ts";
import { readConfig } from "../repo/configIo.ts";

// P3(c) outbound escalation reach (master plan 2026-06-12). After a tick that ENDS with pending
// escalations, run the operator-configured sync command (e.g. bridge/boule_sync_telegram.py
// sync-once) ONCE so the human actually hears about the halt. STRICTLY opt-in (config field
// `escalationSync.command`, an argv array — never a shell string), bounded (one attempt, hard
// timeout, zero retry — INVARIANT #5), and NON-BLOCKING by contract: the outcome is recorded in
// the tick JSON report and NEVER changes the tick's exit code (a broken notifier must not look
// like a broken loop). The command's own dedup (sent-marker) keeps repeated ticks from nagging.

export type EscalationSyncOutcome = "ok" | "failed" | "skipped";

/** Spawn seam WITH env (unlike decision/liveReviewer.SpawnLike): the hook contract guarantees
 *  BOULE_WORKSPACE reaches the child, so the seam must carry env for tests to assert it. */
export type EnvSpawnLike = (
  command: string,
  args: string[],
  opts: { env: Record<string, string | undefined> },
) => ChildLike;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

/** Mirror evaluateLive.clampTimeoutMs: malformed/negative/huge values fall back to the default
 *  bound instead of degrading to an instant 0ms timeout. */
export function clampSyncTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

export interface EscalationSyncDeps {
  spawn?: EnvSpawnLike;
  timeoutMs?: number;
  setTimer?: (cb: () => void, ms: number) => () => void; // returns a cancel fn
  log?: (line: string) => void; // PII-safe (command word + exit only — never payload bodies)
}

/** ONE bounded subprocess attempt. Resolves "ok" on clean exit, "failed" on non-zero exit, spawn
 *  error, or timeout (killing the child). NEVER throws and NEVER retries. */
export async function runEscalationSyncCommand(
  command: string[],
  workspace: string,
  env: Record<string, string | undefined>,
  deps: EscalationSyncDeps = {},
): Promise<"ok" | "failed"> {
  const spawnFn: EnvSpawnLike =
    deps.spawn ??
    ((cmd, args, opts) =>
      nodeSpawn(cmd, args, { env: opts.env as NodeJS.ProcessEnv }) as unknown as ChildLike);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer =
    deps.setTimer ??
    ((cb: () => void, ms: number) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    });
  const [head, ...rest] = command;
  if (!head) return "failed";

  return await new Promise<"ok" | "failed">((resolve) => {
    let settled = false;
    let cancelTimer: () => void = () => {};
    const done = (outcome: "ok" | "failed") => {
      if (settled) return;
      settled = true;
      cancelTimer();
      deps.log?.(`escalationSync ${outcome} cmd=${head}`);
      resolve(outcome);
    };

    let child: ChildLike;
    try {
      child = spawnFn(head, rest, { env: { ...env, BOULE_WORKSPACE: workspace } });
    } catch {
      done("failed");
      return;
    }

    cancelTimer = setTimer(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done("failed");
    }, timeoutMs);

    // Drain output so a chatty sync script can't wedge on a full pipe; bodies are discarded
    // (PII-safe — the hook records an outcome, not content).
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", () => done("failed"));
    child.on("close", (code) => done(code === 0 ? "ok" : "failed"));
  });
}

export interface MaybeRunEscalationSyncOpts {
  repoRoot: string;
  workspace: string;
  now: Date;
  env: Record<string, string | undefined>;
  deps?: EscalationSyncDeps;
}

/** The cmdTick hook: undefined when the repo doesn't configure `escalationSync` (field absent from
 *  the report), "skipped" when configured but nothing is pending, else the bounded run outcome.
 *  Expired-but-unresolved escalations COUNT as pending (P3d — their halt persists). */
export async function maybeRunEscalationSync(
  opts: MaybeRunEscalationSyncOpts,
): Promise<EscalationSyncOutcome | undefined> {
  let command: string[] | undefined;
  try {
    command = (await readConfig(opts.repoRoot)).escalationSync?.command;
  } catch {
    return undefined; // missing/invalid config ⇒ the hook is simply not configured
  }
  if (!command?.length) return undefined;
  const pending = await pendingEscalations(opts.workspace, opts.now);
  if (pending.length === 0) return "skipped";
  return await runEscalationSyncCommand(command, opts.workspace, opts.env, opts.deps);
}
