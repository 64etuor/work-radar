import { describe, expect, it } from "vitest";

import type {
  PreflightCheck,
  ProjectTickerStatusRow,
  ReadinessGates,
  ReadinessView,
  TickerSchedulerStatus,
} from "../bindings";
import {
  buildGoLiveRemedies,
  infraTone,
  isArmed,
  parseLatchDetail,
  pickActiveProjectId,
  projectDotTone,
  relativeAgo,
  SCHEDULER_STALE_AFTER_SEC,
  schedulerChip,
  statusTone,
} from "./controlRoom";

describe("pickActiveProjectId", () => {
  it("defaults to the first project when nothing is selected", () => {
    expect(pickActiveProjectId(["a", "b"], null)).toBe("a");
  });

  it("honors a still-present selection", () => {
    expect(pickActiveProjectId(["a", "b"], "b")).toBe("b");
  });

  it("falls back to the first project when the selection disappeared", () => {
    expect(pickActiveProjectId(["a", "b"], "gone")).toBe("a");
  });

  it("returns null when there are no projects", () => {
    expect(pickActiveProjectId([], "a")).toBeNull();
    expect(pickActiveProjectId([], null)).toBeNull();
  });
});

describe("statusTone", () => {
  it("maps phases to the master §12 color buckets", () => {
    expect(statusTone("done")).toBe("done");
    expect(statusTone("active")).toBe("active");
    expect(statusTone("waiting")).toBe("waiting");
    expect(statusTone("context_pressure_high")).toBe("pressure");
    expect(statusTone("blocked")).toBe("blocked");
    expect(statusTone("closed")).toBe("muted");
    expect(statusTone("unknown")).toBe("muted");
  });
});

describe("projectDotTone", () => {
  const row = (over: Partial<ProjectTickerStatusRow>): ProjectTickerStatusRow =>
    ({
      tickEnabled: false,
      liveEnabled: false,
      attentionRequired: false,
      ...over,
    }) as ProjectTickerStatusRow;
  it("attention wins → down", () => {
    expect(
      projectDotTone(row({ attentionRequired: true, tickEnabled: true, liveEnabled: true })),
    ).toBe("down");
  });
  it("enabled + live → ok", () => {
    expect(projectDotTone(row({ tickEnabled: true, liveEnabled: true }))).toBe("ok");
  });
  it("enabled only → advisory", () => {
    expect(projectDotTone(row({ tickEnabled: true }))).toBe("advisory");
  });
  it("clock off → muted", () => {
    expect(projectDotTone(row({}))).toBe("muted");
    expect(projectDotTone(row({ liveEnabled: true }))).toBe("muted");
  });
});

describe("relativeAgo", () => {
  it("returns a placeholder when never projected", () => {
    expect(relativeAgo(null, 1_000_000)).toBe("아직 프로젝션 없음");
  });
  it("formats minutes since the projection mtime", () => {
    const now = Date.parse("2026-06-03T00:10:00Z");
    expect(relativeAgo("2026-06-03T00:00:00Z", now)).toBe("10분 전 프로젝션");
  });
});

describe("infraTone", () => {
  const chk = (ok: boolean, level: string): PreflightCheck =>
    ({ id: "x", ok, level, detail: "" }) as PreflightCheck;
  it("ok check → ok", () => expect(infraTone(chk(true, "required"))).toBe("ok"));
  it("failing required → down", () => expect(infraTone(chk(false, "required"))).toBe("down"));
  it("failing advisory → advisory", () =>
    expect(infraTone(chk(false, "advisory"))).toBe("advisory"));
});

describe("isArmed", () => {
  const gates = (over: Partial<ReadinessGates>): ReadinessGates => ({
    preflight: true,
    conductor: true,
    observer: true,
    auto: true,
    stall: true,
    ...over,
  });
  it("all gates pass → armed", () => expect(isArmed(gates({}))).toBe(true));
  it("any gate fails → not armed", () => expect(isArmed(gates({ observer: false }))).toBe(false));
});

describe("parseLatchDetail", () => {
  it("extracts the error report shape (spawn/timeout/parse failures)", () => {
    expect(
      parseLatchDetail('{"error":{"code":"spawn_failed","message":"node binary not found"}}'),
    ).toEqual(["spawn_failed: node binary not found"]);
  });

  it("extracts TickReport blockers, halted plans and stall count", () => {
    const json = JSON.stringify({
      outcome: "needs_human",
      conducted: 0,
      specsAccepted: 0,
      plansAccepted: 0,
      haltedPlans: ["p1"],
      stalledCount: 2,
      blockers: ["BOULE_OBSERVER_MODE!=live"],
      warnings: [],
    });
    expect(parseLatchDetail(json)).toEqual([
      "BOULE_OBSERVER_MODE!=live",
      "halted plan: p1",
      "stalled task 2개",
    ]);
  });

  it("is empty for missing/unparseable/non-object input", () => {
    expect(parseLatchDetail(null)).toEqual([]);
    expect(parseLatchDetail(undefined)).toEqual([]);
    expect(parseLatchDetail("{ not json")).toEqual([]);
    expect(parseLatchDetail('"just a string"')).toEqual([]);
  });

  it("ignores zero stalledCount and non-string array entries", () => {
    expect(parseLatchDetail('{"stalledCount":0,"blockers":[1,"real"],"haltedPlans":[{}]}')).toEqual(
      ["real"],
    );
  });
});

describe("buildGoLiveRemedies", () => {
  const row = (over: Partial<ProjectTickerStatusRow>): ProjectTickerStatusRow =>
    ({
      projectId: "p1",
      tickEnabled: true,
      intervalSec: 600,
      liveEnabled: true,
      attentionRequired: false,
      ...over,
    }) as ProjectTickerStatusRow;
  const readiness = (over: Partial<ReadinessGates>): ReadinessView => ({
    ready: false,
    blockers: [],
    warnings: [],
    gates: {
      preflight: true,
      conductor: true,
      observer: true,
      auto: true,
      stall: true,
      ...over,
    },
  });
  const check = (id: string, ok: boolean): PreflightCheck =>
    ({ id, ok, level: "required", detail: "" }) as PreflightCheck;

  it("all green → no remedies (renders nothing)", () => {
    expect(buildGoLiveRemedies(row({}), readiness({}), [])).toEqual([]);
  });

  it("ticker-side disarm states surface even without snapshot readiness", () => {
    const out = buildGoLiveRemedies(
      row({ tickEnabled: false, attentionRequired: true }),
      undefined,
      undefined,
    );
    expect(out.map((r) => r.key)).toEqual(["tick", "latch"]);
    expect(out[0].remedy).toContain("Enabled 토글");
    expect(out[1].remedy).toContain("래치 해제");
  });

  it("enabled clock without interval → interval remedy (manual-only otherwise)", () => {
    const out = buildGoLiveRemedies(row({ intervalSec: null }), readiness({}), []);
    expect(out.map((r) => r.key)).toEqual(["interval"]);
  });

  it("conductor/observer stub gates point at the SAME console's Live toggle", () => {
    const out = buildGoLiveRemedies(row({}), readiness({ conductor: false, observer: false }), []);
    expect(out.map((r) => r.key)).toEqual(["conductor", "observer"]);
    expect(out[0].remedy).toContain("Live 토글");
    expect(out[1].remedy).toContain("Live 토글");
  });

  it("failing preflight refines per failing infra check (cmux socket / git)", () => {
    const out = buildGoLiveRemedies(row({}), readiness({ preflight: false }), [
      check("cmux_socket", false),
      check("cmux_binary", true),
      check("git_worktree", false),
    ]);
    expect(out.map((r) => r.key)).toEqual(["preflight:cmux_socket", "preflight:git_worktree"]);
    expect(out[0].remedy).toContain("cmuxSocketPath");
    expect(out[1].gate).toBe("git");
  });

  it("failing preflight without a recognized infra cause falls back to a generic remedy", () => {
    const out = buildGoLiveRemedies(row({}), readiness({ preflight: false }), []);
    expect(out.map((r) => r.key)).toEqual(["preflight"]);
  });

  it("auto and stall gates carry their own remedies", () => {
    const out = buildGoLiveRemedies(row({}), readiness({ auto: false, stall: false }), []);
    expect(out.map((r) => r.key)).toEqual(["auto", "stall"]);
    expect(out[0].remedy).toContain("autonomyLevel");
    expect(out[1].remedy).toContain("stalled task");
  });
});

describe("schedulerChip", () => {
  const status = (over: Partial<TickerSchedulerStatus>): TickerSchedulerStatus => ({
    lastWakeAt: "2026-06-10 10:00:00",
    scanOk: true,
    runnerOk: true,
    runnerError: null,
    fired: 0,
    secondsSinceWake: 5,
    ...over,
  });
  it("no heartbeat yet → advisory", () => {
    expect(schedulerChip(null).tone).toBe("advisory");
  });
  it("healthy recent wake → ok", () => {
    expect(schedulerChip(status({})).tone).toBe("ok");
  });
  it("runner unavailable → down with the error in the title", () => {
    const chip = schedulerChip(status({ runnerOk: false, runnerError: "no node" }));
    expect(chip.tone).toBe("down");
    expect(chip.title).toContain("no node");
  });
  it("stale heartbeat past threshold → down", () => {
    expect(schedulerChip(status({ secondsSinceWake: SCHEDULER_STALE_AFTER_SEC + 1 })).tone).toBe(
      "down",
    );
    expect(schedulerChip(status({ secondsSinceWake: SCHEDULER_STALE_AFTER_SEC })).tone).toBe("ok");
  });
  it("recent wake but failed scan → advisory", () => {
    expect(schedulerChip(status({ scanOk: false })).tone).toBe("advisory");
  });
});
