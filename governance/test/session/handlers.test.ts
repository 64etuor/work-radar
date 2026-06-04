import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestSessionOpen,
  markWaiting,
  markBlocked,
  recordPressure,
  requestCheckpoint,
  markHandoffReady,
  requestSessionClose,
  closeSession,
  listSessions,
  sessionTrail,
} from "../../src/session/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-sess-h-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("requestSessionOpen — birth", () => {
  it("births a planned session, listed by sessions()", async () => {
    const { sessionId } = await requestSessionOpen(
      dir,
      { ownership: "user_owned", surface: "5" },
      at(0),
      0.1,
    );
    const list = await listSessions(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe(sessionId);
    expect(list[0]!.phase).toBe("planned");
    expect(list[0]!.surface).toBe("5");
  });
});

describe("record commands — one event per call, guarded", () => {
  it("waiting/blocked/pressure/checkpoint/handoff each append exactly one event", async () => {
    const { sessionId } = await requestSessionOpen(dir, {}, at(0), 0.1);
    const before = (await readAllEvents(dir)).length;
    expect((await markWaiting(dir, { sessionId }, at(1), 0.2)).ok).toBe(true);
    expect((await markBlocked(dir, { sessionId, reason: "dep" }, at(2), 0.3)).ok).toBe(true);
    expect((await recordPressure(dir, { sessionId, level: "high" }, at(3), 0.4)).ok).toBe(true);
    expect((await requestCheckpoint(dir, { sessionId }, at(4), 0.5)).ok).toBe(true);
    expect((await markHandoffReady(dir, { sessionId }, at(5), 0.6)).ok).toBe(true);
    expect((await readAllEvents(dir)).length).toBe(before + 5);
  });
});

describe("close gate — close_session only after session_close_requested", () => {
  it("closeSession refused before a request", async () => {
    const { sessionId } = await requestSessionOpen(dir, {}, at(0), 0.1);
    const r = await closeSession(dir, { sessionId }, at(1), 0.2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/session_close_requested/);
  });

  it("requestSessionClose → closeSession succeeds and is terminal", async () => {
    const { sessionId } = await requestSessionOpen(dir, {}, at(0), 0.1);
    expect((await requestSessionClose(dir, { sessionId }, at(1), 0.2)).ok).toBe(true);
    expect((await closeSession(dir, { sessionId }, at(2), 0.3)).ok).toBe(true);
    // after close, sessions() (non-terminal) omits it, and further records refuse
    expect(await listSessions(dir)).toHaveLength(0);
    expect((await markWaiting(dir, { sessionId }, at(3), 0.4)).ok).toBe(false);
  });
});

describe("sessionTrail", () => {
  it("renders the full chain in order", async () => {
    const { sessionId } = await requestSessionOpen(dir, {}, at(0), 0.1);
    await markWaiting(dir, { sessionId }, at(1), 0.2);
    const t = await sessionTrail(dir, { sessionId });
    expect(t.chain.map((c) => c.type)).toEqual(["session_open_requested", "session_waiting"]);
    expect(t.phase).toBe("waiting");
  });
  it("throws on unknown session id", async () => {
    await expect(sessionTrail(dir, { sessionId: "evt_nope" })).rejects.toThrow(/unknown session/);
  });
});
