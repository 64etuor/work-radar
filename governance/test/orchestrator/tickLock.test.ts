import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTickLock,
  clampLockTtlMs,
  TICK_LOCK_FILENAME,
} from "../../src/orchestrator/tickLock.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-ticklock-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const T0 = new Date("2026-06-12T10:00:00Z");
const lockPath = () => join(ws, TICK_LOCK_FILENAME);

describe("clampLockTtlMs", () => {
  it("defaults to 15min and clamps malformed/negative/huge values", () => {
    expect(clampLockTtlMs(undefined)).toBe(900_000);
    expect(clampLockTtlMs("notanumber")).toBe(900_000);
    expect(clampLockTtlMs("-5")).toBe(900_000);
    expect(clampLockTtlMs("0")).toBe(900_000);
    expect(clampLockTtlMs("60000")).toBe(60_000);
    expect(clampLockTtlMs(String(999 * 3_600_000))).toBe(24 * 3_600_000); // capped at 24h
  });
});

describe("acquireTickLock", () => {
  it("acquires on a fresh workspace and writes pid + ISO timestamp", async () => {
    const r = await acquireTickLock(ws, T0, { pid: 111 });
    expect(r.acquired).toBe(true);
    const raw = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(raw).toEqual({ pid: 111, acquiredAt: "2026-06-12T10:00:00.000Z" });
  });

  it("concurrent-acquire: the second acquirer sees held-and-fresh and does NOT take over", async () => {
    const first = await acquireTickLock(ws, T0, { pid: 111 });
    expect(first.acquired).toBe(true);
    // 1 minute later — well within the 15min TTL.
    const second = await acquireTickLock(ws, new Date(T0.getTime() + 60_000), { pid: 222 });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holder).toEqual({ pid: 111, acquiredAt: "2026-06-12T10:00:00.000Z" });
    }
    // the lock file still belongs to the first holder
    const raw = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(raw.pid).toBe(111);
  });

  it("stale takeover: a lock older than the TTL is overwritten by the next acquirer", async () => {
    await acquireTickLock(ws, T0, { pid: 111 });
    // 16 minutes later — past the default 15min TTL → take over.
    const later = new Date(T0.getTime() + 16 * 60_000);
    const second = await acquireTickLock(ws, later, { pid: 222 });
    expect(second.acquired).toBe(true);
    const raw = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(raw).toEqual({ pid: 222, acquiredAt: later.toISOString() });
  });

  it("honours an explicit ttlMs (held under it, stale past it)", async () => {
    await acquireTickLock(ws, T0, { pid: 111 });
    const at = (ms: number) => new Date(T0.getTime() + ms);
    expect((await acquireTickLock(ws, at(4_000), { pid: 222, ttlMs: 5_000 })).acquired).toBe(false);
    expect((await acquireTickLock(ws, at(6_000), { pid: 333, ttlMs: 5_000 })).acquired).toBe(true);
  });

  it("treats a corrupt lock file as stale (takes over instead of wedging forever)", async () => {
    await writeFile(lockPath(), "not json at all");
    const r = await acquireTickLock(ws, T0, { pid: 222 });
    expect(r.acquired).toBe(true);
    expect(JSON.parse(await readFile(lockPath(), "utf8")).pid).toBe(222);
  });

  it("release removes the lock file (the finally path after success OR error)", async () => {
    const r = await acquireTickLock(ws, T0, { pid: 111 });
    expect(r.acquired).toBe(true);
    if (r.acquired) await r.release();
    await expect(stat(lockPath())).rejects.toThrow();
    // release is idempotent — a second call must not throw (finally may run after a partial path)
    if (r.acquired) await expect(r.release()).resolves.toBeUndefined();
  });

  it("release leaves a lock alone once another acquirer has taken it over (ownership check)", async () => {
    const first = await acquireTickLock(ws, T0, { pid: 111 });
    expect(first.acquired).toBe(true);
    // first holder overruns its TTL; a second tick takes over
    const later = new Date(T0.getTime() + 16 * 60_000);
    const second = await acquireTickLock(ws, later, { pid: 222 });
    expect(second.acquired).toBe(true);
    // the slow first tick finally releases — it must NOT delete the second holder's lock
    if (first.acquired) await first.release();
    const raw = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(raw.pid).toBe(222);
  });

  it("creates the workspace dir when missing (tick on a not-yet-initialized repo)", async () => {
    const nested = join(ws, "deep", "workspace");
    const r = await acquireTickLock(nested, T0, { pid: 111 });
    expect(r.acquired).toBe(true);
    expect(JSON.parse(await readFile(join(nested, TICK_LOCK_FILENAME), "utf8")).pid).toBe(111);
  });
});
