import { describe, it, expect } from "vitest";
import { deriveSessionState, sessionsOf } from "../../src/session/session.js";
import type { GovEvent, EventType } from "../../src/event/event.js";

function evt(type: EventType, id: string, relatedTo?: string[], body = ""): GovEvent {
  return {
    frontmatter: {
      id,
      type,
      source: "system",
      actor: "user",
      tags: ["session"],
      related_to: relatedTo,
    },
    body,
  };
}

const spawned = evt(
  "session_spawned",
  "evt_s1",
  ["evt_task0"],
  JSON.stringify({ surface: "7", worktree: "/wt" }),
);
const opened = evt(
  "session_opened",
  "evt_s2",
  undefined,
  JSON.stringify({ surface: "9", ownership: "external_owned" }),
);

describe("deriveSessionState — births", () => {
  it("session_spawned → opening, orchestrator_owned, surface + taskId from body/related", () => {
    const s = deriveSessionState(spawned, []);
    expect(s.phase).toBe("opening");
    expect(s.ownership).toBe("orchestrator_owned");
    expect(s.surface).toBe("7");
    expect(s.taskId).toBe("evt_task0");
  });
  it("session_opened → opening, ownership from body (external_owned)", () => {
    const s = deriveSessionState(opened, []);
    expect(s.phase).toBe("opening");
    expect(s.ownership).toBe("external_owned");
    expect(s.surface).toBe("9");
  });
  it("session_opened with no ownership defaults to user_owned", () => {
    const e = evt("session_opened", "evt_s3", undefined, JSON.stringify({ surface: "3" }));
    expect(deriveSessionState(e, []).ownership).toBe("user_owned");
  });
  it("session_open_requested → planned", () => {
    const e = evt(
      "session_open_requested",
      "evt_s4",
      undefined,
      JSON.stringify({ ownership: "user_owned" }),
    );
    expect(deriveSessionState(e, []).phase).toBe("planned");
  });
});

describe("deriveSessionState — substates (latest by id wins)", () => {
  it("session_observed → active", () => {
    expect(deriveSessionState(spawned, [evt("session_observed", "evt_a2", ["evt_s1"])]).phase).toBe(
      "active",
    );
  });
  it("waiting then blocked → blocked (latest id)", () => {
    const r = [
      evt("session_waiting", "evt_a2", ["evt_s1"]),
      evt("session_blocked", "evt_a3", ["evt_s1"]),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("blocked");
  });
  it("context_pressure high → context_pressure_high", () => {
    const r = [
      evt(
        "session_context_pressure_changed",
        "evt_a2",
        ["evt_s1"],
        JSON.stringify({ level: "high" }),
      ),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("context_pressure_high");
  });
  it("context_pressure low/medium is inert for phase (stays opening)", () => {
    const r = [
      evt(
        "session_context_pressure_changed",
        "evt_a2",
        ["evt_s1"],
        JSON.stringify({ level: "low" }),
      ),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("opening");
  });
  it("checkpoint_requested and handoff_ready resolve by latest id", () => {
    const r = [
      evt("session_checkpoint_requested", "evt_a2", ["evt_s1"]),
      evt("session_handoff_ready", "evt_a3", ["evt_s1"]),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("handoff_ready");
  });
  it("close_requested → closing", () => {
    expect(
      deriveSessionState(spawned, [evt("session_close_requested", "evt_a2", ["evt_s1"])]).phase,
    ).toBe("closing");
  });
});

describe("deriveSessionState — terminal + crash/recover precedence", () => {
  it("session_closed wins over everything (terminal, verdict set)", () => {
    const r = [
      evt("session_observed", "evt_a2", ["evt_s1"]),
      evt("session_closed", "evt_a9", ["evt_s1"]),
    ];
    const s = deriveSessionState(spawned, r);
    expect(s.phase).toBe("closed");
    expect(s.verdict).toBe("closed");
  });
  it("crash overrides the active substate", () => {
    const r = [
      evt("session_observed", "evt_a2", ["evt_s1"]),
      evt("session_crashed", "evt_a3", ["evt_s1"]),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("crashed");
  });
  it("recover after crash (latest id) → recovering", () => {
    const r = [
      evt("session_crashed", "evt_a3", ["evt_s1"]),
      evt("session_recovered", "evt_a4", ["evt_s1"]),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("recovering");
  });
  it("closed still wins even with a later-id crash", () => {
    const r = [
      evt("session_closed", "evt_a2", ["evt_s1"]),
      evt("session_crashed", "evt_a9", ["evt_s1"]),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("closed");
  });
});

describe("deriveSessionState — fail-closed on foreign types", () => {
  it("ignores non-session events in related", () => {
    const r = [
      evt("task_started", "evt_x2", ["evt_s1"]),
      evt("decision_proposed", "evt_x3", ["evt_s1"]),
    ];
    expect(deriveSessionState(spawned, r).phase).toBe("opening");
  });
});

describe("sessionsOf", () => {
  it("enumerates births (spawned + opened), chronological by id", () => {
    const all = [opened, spawned, evt("session_observed", "evt_a2", ["evt_s1"])];
    expect(sessionsOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_s1", "evt_s2"]);
  });
  it("excludes a session_opened that references an existing origin (planned→opening transition)", () => {
    const req = evt("session_open_requested", "evt_s5", undefined, "{}");
    const openTransition = evt(
      "session_opened",
      "evt_s6",
      ["evt_s5"],
      JSON.stringify({ surface: "2" }),
    );
    const all = [req, openTransition];
    expect(sessionsOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_s5"]);
  });
});
