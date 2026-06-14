import { describe, expect, it } from "vitest";

import { computeLayout, magnetEdgesFromBoxes, type TimedBlock } from "./timelineLayout";

const make = (
  id: string,
  start: string,
  end: string,
  kind: TimedBlock["kind"] = "event",
): TimedBlock => ({
  id,
  kind,
  title: id,
  startISO: start,
  endISO: end,
  calendarId: "c",
  color: "#888",
});

describe("computeLayout", () => {
  it("single block fills width", () => {
    const out = computeLayout([make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", leftPct: 0, widthPct: 100 });
  });

  it("two non-overlapping each full width", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T11:00:00", "2026-05-28T12:00:00"),
    ]);
    expect(out.find((b) => b.id === "a")!.widthPct).toBe(100);
    expect(out.find((b) => b.id === "b")!.widthPct).toBe(100);
  });

  it("two overlapping → 50/50", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:30:00"),
      make("b", "2026-05-28T10:00:00", "2026-05-28T11:00:00"),
    ]);
    expect(out.find((b) => b.id === "a")!.widthPct).toBe(50);
    expect(out.find((b) => b.id === "b")!.widthPct).toBe(50);
    expect(new Set(out.map((b) => b.leftPct))).toEqual(new Set([0, 50]));
  });

  it("three mutually overlapping → 33/33/33", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T11:00:00"),
      make("b", "2026-05-28T09:30:00", "2026-05-28T10:30:00"),
      make("c", "2026-05-28T10:00:00", "2026-05-28T11:30:00"),
    ]);
    for (const b of out) {
      expect(Math.abs(b.widthPct - 100 / 3)).toBeLessThan(0.01);
    }
    // 3 distinct columns
    expect(new Set(out.map((b) => Math.round(b.leftPct))).size).toBe(3);
  });

  it("cluster boundary: a-b overlap, c separate → cluster1=50/50, c=100", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T09:30:00", "2026-05-28T10:30:00"),
      make("c", "2026-05-28T11:00:00", "2026-05-28T12:00:00"),
    ]);
    expect(out.find((x) => x.id === "a")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "c")!.widthPct).toBe(100);
  });

  it("zero-duration block gets MIN_BLOCK_PX floor and does not strictly overlap a co-starting block", () => {
    // 'a'는 09:00에 시작하고 종료(0분 길이 = point). 'b'는 09:00 시작 / 10:00 종료.
    // 클러스터링은 `start < curMaxEnd`(strict) 기준이므로 'a' 처리 직후 curMaxEnd=540, 'b' start=540은
    // 540 < 540 false → 별도 클러스터로 떨어진다. 각자 100% 폭, 'a'는 MIN_BLOCK_PX(20) 바닥.
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T09:00:00"),
      make("b", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
    ]);
    const a = out.find((x) => x.id === "a")!;
    const b = out.find((x) => x.id === "b")!;
    expect(a.heightPx).toBe(20); // MIN_BLOCK_PX floor
    expect(a.widthPct).toBe(100);
    expect(b.widthPct).toBe(100);
  });

  it("identical-start non-zero blocks share a cluster and split width", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
    ]);
    expect(out.find((x) => x.id === "a")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50);
  });

  it("topPx and heightPx derived from minutes (60px/hour)", () => {
    const out = computeLayout([make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00")]);
    expect(out[0].topPx).toBe(9 * 60);
    expect(out[0].heightPx).toBe(60);
  });
});

describe("computeLayout — continuous axis (anchor)", () => {
  it("자정 걸침 블록: 단일 연속 박스, 양수 height (기존 20px 슬리버 버그 회귀 방지)", () => {
    const out = computeLayout(
      [make("x", "2026-06-11T23:00:00", "2026-06-12T01:30:00")],
      "2026-06-11",
    );
    expect(out[0].topPx).toBe(23 * 60);
    expect(out[0].heightPx).toBe(150); // 음수 duration → max(20, …) 슬리버가 아니라 실제 150분
  });

  it("anchor 이후 날짜 블록은 1440px 오프셋", () => {
    const out = computeLayout(
      [make("y", "2026-06-12T09:00:00", "2026-06-12T10:00:00")],
      "2026-06-11",
    );
    expect(out[0].topPx).toBe(1440 + 540);
  });

  it("자정을 가로지르는 겹침도 한 클러스터로 50/50 분할", () => {
    const out = computeLayout(
      [
        make("a", "2026-06-11T23:00:00", "2026-06-12T01:00:00"),
        make("b", "2026-06-11T23:30:00", "2026-06-12T00:30:00"),
      ],
      "2026-06-11",
    );
    expect(out.find((x) => x.id === "a")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50);
  });

  it("anchor 이전 시작 블록은 음수 topPx (그리드가 클리핑)", () => {
    const out = computeLayout(
      [make("z", "2026-06-10T23:00:00", "2026-06-11T01:00:00")],
      "2026-06-11",
    );
    expect(out[0].topPx).toBe(-60);
    expect(out[0].heightPx).toBe(120);
  });

  it("anchor 생략 시 가장 이른 블록 날짜가 anchor (기존 단일일 호출 하위호환)", () => {
    const out = computeLayout([make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00")]);
    expect(out[0].topPx).toBe(540);
  });
});

describe("magnetEdgesFromBoxes", () => {
  const boxes = computeLayout(
    [
      {
        id: "a",
        kind: "event",
        title: "A",
        startISO: "2026-06-11T09:00:00+09:00",
        endISO: "2026-06-11T10:00:00+09:00",
        calendarId: "c",
        color: "#000",
      },
      {
        id: "b",
        kind: "event",
        title: "B",
        startISO: "2026-06-11T11:00:00+09:00",
        endISO: "2026-06-11T11:30:00+09:00",
        calendarId: "c",
        color: "#000",
      },
    ],
    "2026-06-11",
  );

  it("returns start+end absolute minutes of every box except the excluded one", () => {
    expect(magnetEdgesFromBoxes(boxes, "2026-06-11", "a").sort((x, y) => x - y)).toEqual([
      660, 690,
    ]);
  });

  it("includes all edges when excludeId is null", () => {
    expect(magnetEdgesFromBoxes(boxes, "2026-06-11", null).sort((x, y) => x - y)).toEqual([
      540, 600, 660, 690,
    ]);
  });
});
