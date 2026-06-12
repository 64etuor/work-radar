import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// P3(a) tick mutex (master plan 2026-06-12). ADVISORY workspace lock so two clocks — the in-app
// tokio ticker and a launchd StartInterval job — can never double-conduct the same repo in one
// window. File-based (the workspace IS the per-repo state root), atomic `wx` create, TTL'd so a
// crashed tick can never wedge the loop forever (bounded — INVARIANT #5). The losing tick exits
// as a benign no-op ("locked", exit 0) WITHOUT reading or writing any event.

export const TICK_LOCK_FILENAME = ".tick.lock";

const DEFAULT_TTL_MS = 15 * 60_000; // 15min — generous vs a real tick (seconds), small vs a day
const MAX_TTL_MS = 24 * 3_600_000; // clamp ceiling: a lock may never outlive a day

/** Malformed/negative/huge env values must not produce an instant-stale (0ms) or immortal lock —
 *  mirror evaluateLive.clampTimeoutMs: fall back to the default bound, cap the ceiling. */
export function clampLockTtlMs(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TTL_MS) : DEFAULT_TTL_MS;
}

export interface TickLockHolder {
  pid: number;
  acquiredAt: string; // ISO timestamp
}

export type TickLockResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; holder: TickLockHolder | null };

async function readHolder(lockPath: string): Promise<TickLockHolder | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      acquiredAt?: unknown;
    };
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "string") return null;
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null; // missing or corrupt — caller treats as stale (never wedge on garbage)
  }
}

/** Ownership-checked release: only delete the file while WE still hold it. After a stale takeover
 *  the original (overrun) tick's deferred release must not delete the new holder's lock. Idempotent
 *  (missing file = fine) — safe in a `finally`. */
function makeRelease(lockPath: string, owned: TickLockHolder): () => Promise<void> {
  return async () => {
    const holder = await readHolder(lockPath);
    if (holder && (holder.pid !== owned.pid || holder.acquiredAt !== owned.acquiredAt)) return;
    try {
      await unlink(lockPath);
    } catch {
      /* already gone — release is idempotent */
    }
  };
}

/** Try to take the per-workspace tick lock. Atomic `wx` create; EEXIST = somebody holds it:
 *  held-and-fresh (< ttlMs old) ⇒ `{acquired:false}` (the caller no-ops), stale/corrupt ⇒ take
 *  over by overwriting. Creates the workspace dir when missing (tick may run pre-init). */
export async function acquireTickLock(
  workspaceDir: string,
  now: Date,
  opts: { ttlMs?: number; pid?: number } = {},
): Promise<TickLockResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const owned: TickLockHolder = { pid: opts.pid ?? process.pid, acquiredAt: now.toISOString() };
  const lockPath = join(workspaceDir, TICK_LOCK_FILENAME);
  const payload = JSON.stringify(owned) + "\n";

  await mkdir(workspaceDir, { recursive: true });
  try {
    await writeFile(lockPath, payload, { flag: "wx" }); // atomic create-or-EEXIST
    return { acquired: true, release: makeRelease(lockPath, owned) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const holder = await readHolder(lockPath);
  const acquiredAtMs = holder ? new Date(holder.acquiredAt).getTime() : Number.NaN;
  const heldAndFresh = Number.isFinite(acquiredAtMs) && now.getTime() - acquiredAtMs < ttlMs;
  if (heldAndFresh) return { acquired: false, holder };

  // Stale (or corrupt) — take over. Plain overwrite per spec; the advisory contract tolerates the
  // tiny simultaneous-takeover window (both writers are past-TTL recoveries, not live ticks).
  await writeFile(lockPath, payload);
  return { acquired: true, release: makeRelease(lockPath, owned) };
}
