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

  // ── 회귀: 짧은 블록 abutting 시 hit-region 겹침(드래그 핸들 오발동 근본원인) ─────────────
  // 두 15분 블록이 맞붙으면(같은 컬럼, 시간 겹침 없음) 각 블록의 hit-rect=[topPx, topPx+heightPx]는
  // 겹치면 안 된다. MIN_BLOCK_PX(20) 바닥이 topPx(정확)와 결합하면 A=[540,560], B=[555,575]로
  // 5px 겹쳐 윗 블록의 하단 리사이즈 핸들이 아랫 블록의 상단 핸들과 같은 픽셀을 두고 다툰다 →
  // 페인트 순서(나중 시작=위)로 포인터가 잘못된 블록을 잡아 "다른 스케줄이 늘어난다".
  it("두 맞붙는 15분 블록의 hit-rect는 겹치지 않는다 (핸들 오발동 회귀 가드)", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T09:15:00"),
      make("b", "2026-05-28T09:15:00", "2026-05-28T09:30:00"),
    ]);
    const a = out.find((x) => x.id === "a")!;
    const b = out.find((x) => x.id === "b")!;
    // 같은 가로 컬럼(시간 비겹침 → full width)
    expect(a.leftPct).toBe(0);
    expect(b.leftPct).toBe(0);
    // 위 블록은 실제 길이(15px)로 클램프, 아래 블록은 다음 블록 없어 floor(20px) 유지.
    expect(a.heightPx).toBe(15);
    expect(b.heightPx).toBe(20);
    // A 하단 ≤ B 상단 — hit-rect 비겹침.
    expect(a.topPx + a.heightPx).toBeLessThanOrEqual(b.topPx);
  });

  it("5분 간격이면 floor(20px)를 유지한다 (간격이 floor 넘침을 흡수 — 과잉 클램프 금지)", () => {
    // a 09:00–09:15(실제 15px, floor 20px → 하단 560), b 09:20–09:35(상단 560). 정확히 맞닿아
    // 겹치지 않으므로 클램프 불필요 → floor 유지.
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T09:15:00"),
      make("b", "2026-05-28T09:20:00", "2026-05-28T09:35:00"),
    ]);
    const a = out.find((x) => x.id === "a")!;
    expect(a.heightPx).toBe(20); // floor 유지
    expect(a.topPx + a.heightPx).toBeLessThanOrEqual(out.find((x) => x.id === "b")!.topPx);
  });

  it("나란히(다른 컬럼) 짧은 블록은 서로 클램프하지 않는다 (가로 분리 → hit-rect 비충돌)", () => {
    // 시간 겹침 → 2컬럼(가로 분리). 세로로는 겹쳐도 핸들이 가로로 떨어져 있어 floor를 줄이면 안 된다.
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T09:15:00"),
      make("b", "2026-05-28T09:05:00", "2026-05-28T09:20:00"),
    ]);
    const a = out.find((x) => x.id === "a")!;
    const b = out.find((x) => x.id === "b")!;
    expect(a.widthPct).toBe(50);
    expect(b.widthPct).toBe(50);
    expect(a.heightPx).toBe(20); // floor 유지(가로로 분리됨)
    expect(b.heightPx).toBe(20);
  });

  it("크로스-클러스터: 다음 클러스터(멀티컬럼)의 topPx까지만 클램프, 실제 길이 밑으로 안 줄인다", () => {
    // A 09:00–09:10(실제 10px, floor 20px → 하단 560). 다음 클러스터는 09:12 시작 2-컬럼(B,D 겹침).
    // A는 full-width라 두 컬럼 모두와 가로로 겹친다 → 가장 가까운 다음 top(09:12=552)까지만 클램프.
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T09:10:00"),
      make("b", "2026-05-28T09:12:00", "2026-05-28T09:42:00"),
      make("d", "2026-05-28T09:12:00", "2026-05-28T09:27:00"),
    ]);
    const a = out.find((x) => x.id === "a")!;
    expect(a.widthPct).toBe(100); // 별도 클러스터, full width
    expect(a.heightPx).toBe(12); // 552 − 540 = 12 (floor 20에서 클램프)
    expect(a.heightPx).toBeGreaterThanOrEqual(10); // 실제 길이(10px) 밑으로는 안 줄임
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50); // 뒤 클러스터는 2-컬럼
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
