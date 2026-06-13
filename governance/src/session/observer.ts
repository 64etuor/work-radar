import { generateId } from "../event/id.ts";
import { parseObserverConfig } from "../mcp/config.ts";
import { makeNodeSpawnSync, walkTerminalSurfaces, type SpawnSyncLike } from "../repo/spawn.ts";
export type { SpawnResultLike, SpawnSyncLike } from "../repo/spawn.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { projectSessions } from "./project.ts";
import type { SessionState, SessionPhase } from "./session.ts";

// NOTE: this module imports ZERO decision write handlers AND never writes a session-closed event.
// The observer is a propose-only observer (master §4.1): it may emit session_observed/_crashed/
// _recovered/_opened only. No-auto-close (§18.3) is structural — close_session (handlers.ts) is
// the SOLE path that closes a session. The negative test asserts both facts.

export interface LiveSurface {
  surface: string;
}

/** DI seam for the read-only half of observe: enumerating live cmux surfaces. The default
 *  stubAdapter touches NO cmux (returns []); the live adapter runs `cmux tree --all --json` behind
 *  BOULE_OBSERVER_MODE=live (mirrors ConductorAdapter). */
export interface ObserverAdapter {
  listSurfaces(): Promise<LiveSurface[]>;
}

/** Deterministic default — no live surfaces, no cmux touched. With BOULE_OBSERVER_MODE unset the
 *  server does NOT reconcile (it would otherwise crash every known session against an empty set);
 *  this stub exists for completeness + injection symmetry with the Conductor. */
export const stubAdapter: ObserverAdapter = {
  async listSurfaces() {
    return [];
  },
};

/** Build the observer adapter from an env map — live `cmux tree` adapter only when
 *  BOULE_OBSERVER_MODE=live, else the no-op stub (an empty surface set would otherwise
 *  crash every known session — callers must NOT reconcile in non-live mode). `spawn` is
 *  injectable for tests; defaults to child_process.spawnSync. */
export function makeObserverAdapterFromEnv(
  env: Record<string, string | undefined>,
  spawn?: SpawnSyncLike,
): { adapter: ObserverAdapter; live: boolean } {
  const cfg = parseObserverConfig(env);
  if (!cfg.live) return { adapter: stubAdapter, live: false };
  const realSpawn: SpawnSyncLike = spawn ?? makeNodeSpawnSync();
  return {
    adapter: makeLiveAdapter({
      spawn: realSpawn,
      cmuxCmd: cfg.cmuxCmd,
      log: (line) => process.stderr.write(`${line}\n`), // PII-safe (command+status+count)
    }),
    live: true,
  };
}

// ── Live adapter (behind BOULE_OBSERVER_MODE=live) ────────────────────────────────────────────

export interface ObserverLiveDeps {
  spawn: SpawnSyncLike; // child_process.spawnSync-like
  cmuxCmd: string; // the cmux binary (app bin by default)
  log?: (line: string) => void; // PII-safe (command name + status + count only)
}

class CommandError extends Error {
  constructor(cmd: string, status: number | null, stderr: string) {
    super(`observer command failed: ${cmd} (status=${status ?? "null"}) ${stderr.slice(0, 200)}`);
    this.name = "CommandError";
  }
}

/** Parse `cmux tree --all --json` stdout into the set of LIVE TERMINAL surfaces. Walks
 *  windows[].workspaces[].panes[].surfaces[], keeping each surface whose `type === "terminal"`
 *  (Boule sessions are terminal agents — browser surfaces are not sessions). Deduped, order-stable
 *  by first appearance. Returns [] on malformed/empty stdout (defensive — the adapter still throws
 *  on a non-zero exit; a 0-exit with junk stdout simply yields no surfaces). */
export function parseSurfaces(stdout: string): LiveSurface[] {
  // walkTerminalSurfaces returns [] on parse failure — same defensive behaviour as before.
  const seen = new Set<string>();
  const out: LiveSurface[] = [];
  for (const { ref } of walkTerminalSurfaces(stdout)) {
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push({ surface: ref });
    }
  }
  return out;
}

/** Build a live adapter that runs a real, bounded (one-shot, no retry loop) `cmux tree --all --json`
 *  and surfaces a terminal failure (design §5). Enumerates every live terminal surface across all
 *  windows/workspaces. Non-determinism (spawn) is injected, so the unit test asserts the exact
 *  command with a fake spawn — no real process. */
export function makeLiveAdapter(deps: ObserverLiveDeps): ObserverAdapter {
  return {
    async listSurfaces() {
      const res = deps.spawn(deps.cmuxCmd, ["tree", "--all", "--json"]);
      const surfaces = res.status === 0 ? parseSurfaces(res.stdout) : [];
      deps.log?.(
        `observer exec ${deps.cmuxCmd} tree --all --json status=${res.status ?? "null"} surfaces=${surfaces.length}`,
      );
      if (res.status !== 0)
        throw new CommandError(`${deps.cmuxCmd} tree --all --json`, res.status, res.stderr);
      return surfaces;
    },
  };
}

// ── Reconcile ─────────────────────────────────────────────────────────────────────────────────

/** Phases that already reflect a live, observed session — a heartbeat on these emits NOTHING (no
 *  flood). Everything except the pre-observe births (planned/opening), crashed, and terminal. */
const ALIVE_OBSERVED: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
  "active",
  "waiting",
  "blocked",
  "context_pressure_high",
  "checkpoint_requested",
  "handoff_ready",
  "recovering",
]);

export interface ObserveSummary {
  observed: number;
  crashed: number;
  recovered: number;
  opened: number;
}

/** One emission queued during reconcile (kept verdict-free; closed is intentionally impossible). */
interface Emission {
  type: Extract<
    EventType,
    "session_observed" | "session_crashed" | "session_recovered" | "session_opened"
  >;
  sessionId: string | null; // null ⇒ orphan birth (no related_to)
  body: string;
}

/** observe_sessions — read live surfaces, reconcile against the derived registry, and emit AT MOST
 *  ONE state-change transition per session (no heartbeat flood). NEVER emits session_closed
 *  (no-auto-close, §18.3). On-demand: one pass, no poll loop (INVARIANT #5). */
export async function observeSessions(
  workspaceDir: string,
  deps: { adapter: ObserverAdapter },
  now: Date,
  rand: number,
): Promise<ObserveSummary> {
  const all = await readAllEvents(workspaceDir);
  const sessions: SessionState[] = projectSessions(all);
  const live = await deps.adapter.listSurfaces();
  const aliveSurfaces = new Set(live.map((l) => l.surface));

  // Known = the live registry = non-closed sessions. Crashed stays known (recoverable); closed
  // drops out (terminal — a reused surface id then orphan-opens a fresh external session).
  const known = sessions.filter((s) => s.phase !== "closed");
  const knownSurfaces = new Set(known.map((s) => s.surface).filter((x): x is string => x !== null));

  const emissions: Emission[] = [];

  for (const s of known) {
    if (s.surface === null) continue; // planned-without-surface: nothing to reconcile against cmux
    const alive = aliveSurfaces.has(s.surface);
    if (alive) {
      if (s.phase === "planned" || s.phase === "opening") {
        emissions.push({
          type: "session_observed",
          sessionId: s.sessionId,
          body: `Observed ${s.sessionId}`,
        });
      } else if (s.phase === "crashed") {
        emissions.push({
          type: "session_recovered",
          sessionId: s.sessionId,
          body: `Recovered ${s.sessionId}`,
        });
      }
      // alive-observed (ALIVE_OBSERVED): no flood.
    } else {
      // surface gone. Crash only a session that is not already crashed (closed already dropped).
      if (s.phase !== "crashed") {
        emissions.push({
          type: "session_crashed",
          sessionId: s.sessionId,
          body: `Crashed ${s.sessionId}`,
        });
      }
    }
  }

  // Orphans: a live surface bound to no known (non-closed) session → auto-register ONCE as an
  // external_owned session_opened (auto-open is allowed, §18.4; idempotent — next pass the surface
  // is known so no second open).
  for (const surface of aliveSurfaces) {
    if (!knownSurfaces.has(surface)) {
      emissions.push({
        type: "session_opened",
        sessionId: null,
        body: JSON.stringify({ surface, ownership: "external_owned" }),
      });
    }
  }

  // Write with per-emission second-offset stamps → distinct chronological ids in one pass.
  let i = 0;
  const summary: ObserveSummary = { observed: 0, crashed: 0, recovered: 0, opened: 0 };
  const writes: Array<Promise<unknown>> = [];
  for (const e of emissions) {
    const at = new Date(now.getTime() + i * 1000);
    const frontmatter: GovEvent["frontmatter"] = {
      id: generateId("evt", at, rand),
      type: e.type,
      source: "system",
      actor: "system",
      tags: ["session", "observer"],
      ...(e.sessionId ? { related_to: [e.sessionId] } : {}),
    };
    writes.push(writeEvent(workspaceDir, { frontmatter, body: e.body }, at));
    if (e.type === "session_observed") summary.observed++;
    else if (e.type === "session_crashed") summary.crashed++;
    else if (e.type === "session_recovered") summary.recovered++;
    else summary.opened++;
    i++;
  }
  await Promise.all(writes);
  return summary;
}

export type { SessionState };
