import { describe, expect, it } from "vitest";

import { tzOffsetForDate } from "./timeAxis";
import {
  clampIsoToDate,
  pixelToLocalIso,
  resizeIsoByPx,
  shiftIsoByPx,
  snapAbsMin,
} from "./timelineCoords";

const off = (d: string) => tzOffsetForDate(d);

describe("timelineCoords (anchor=2026-06-11, days=3)", () => {
  const A = "2026-06-11";

  it("pixelToLocalIso: 둘째 날 영역 픽셀 → 다음 날짜 ISO", () => {
    // 1440px(=둘째 날 00:00) + 90px → 2026-06-12T01:30
    expect(pixelToLocalIso(A, 3, 1440 + 90)).toBe(`2026-06-12T01:30:00${off("2026-06-12")}`);
  });

  it("pixelToLocalIso: 음수/상한 클램프는 로드 범위 기준", () => {
    expect(pixelToLocalIso(A, 3, -10)).toBe(`2026-06-11T00:00:00${off(A)}`);
    expect(pixelToLocalIso(A, 3, 3 * 1440 + 999)).toBe(`2026-06-13T23:45:00${off("2026-06-13")}`);
  });

  it("shiftIsoByPx: 자정 넘는 드래그가 날짜를 증가시킨다", () => {
    // 23:00 시작 + 120px(2h) → 다음 날 01:00
    expect(shiftIsoByPx(A, 3, `2026-06-11T23:00:00${off(A)}`, 120)).toBe(
      `2026-06-12T01:00:00${off("2026-06-12")}`,
    );
  });

  it("shiftIsoByPx: 위로 드래그해 전날로 이동", () => {
    expect(shiftIsoByPx(A, 3, `2026-06-12T00:30:00${off("2026-06-12")}`, -60)).toBe(
      `2026-06-11T23:30:00${off(A)}`,
    );
  });

  it("resizeIsoByPx bottom: 자정 너머로 늘리기 — duration이 일 경계 클램프 없이 증가", () => {
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-11T23:00:00${off(A)}`,
      durationMin: 60,
      edge: "bottom",
      deltaPx: 90,
    });
    expect(r.durationMin).toBe(150);
    expect(r.at).toBe(`2026-06-11T23:00:00${off(A)}`);
  });

  it("resizeIsoByPx top: 시작을 전날로 끌어올리기", () => {
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-12T00:30:00${off("2026-06-12")}`,
      durationMin: 60,
      edge: "top",
      deltaPx: -60,
    });
    expect(r.at).toBe(`2026-06-11T23:30:00${off(A)}`);
    expect(r.durationMin).toBe(120);
  });

  it("clampIsoToDate: 다른 날짜로 흘러간 ISO를 해당 날짜 안으로 (루틴 occurrence 클램프)", () => {
    expect(clampIsoToDate(`2026-06-12T01:00:00${off("2026-06-12")}`, "2026-06-11")).toBe(
      `2026-06-11T23:45:00${off(A)}`,
    );
    expect(clampIsoToDate(`2026-06-10T23:00:00${off("2026-06-10")}`, "2026-06-11")).toBe(
      `2026-06-11T00:00:00${off(A)}`,
    );
    // 이미 그 날짜면 무변경(분 위치 보존)
    expect(clampIsoToDate(`2026-06-11T10:15:00${off(A)}`, "2026-06-11")).toBe(
      `2026-06-11T10:15:00${off(A)}`,
    );
  });

  it("clampDurationToDate: 루틴 bottom-resize가 자정을 넘지 못한다", async () => {
    const { clampDurationToDate } = await import("./timelineCoords");
    // 23:00 시작 + 150분 요청 → 60분(자정까지)으로 클램프
    expect(clampDurationToDate(`2026-06-11T23:00:00${off(A)}`, "2026-06-11", 150)).toBe(60);
    // 자정 안이면 무변경
    expect(clampDurationToDate(`2026-06-11T09:00:00${off(A)}`, "2026-06-11", 90)).toBe(90);
    // 최소 15분 보장
    expect(clampDurationToDate(`2026-06-11T23:45:00${off(A)}`, "2026-06-11", 60)).toBe(15);
  });

  it("plusMinutesLocal: 로컬 ISO 보존 + 자정 통과", async () => {
    const { plusMinutesLocal } = await import("./timelineCoords");
    expect(plusMinutesLocal(`2026-06-11T23:30:00${off(A)}`, 60)).toBe(
      `2026-06-12T00:30:00${off(A)}`,
    );
  });
});

describe("snapAbsMin", () => {
  it("grid-snaps to 15 by default", () => {
    expect(snapAbsMin(102)).toBe(105);
    expect(snapAbsMin(97)).toBe(90);
  });

  it("fine-snaps to 5 when snapMin=5 (Alt/Option)", () => {
    expect(snapAbsMin(102, { snapMin: 5 })).toBe(100);
    expect(snapAbsMin(103, { snapMin: 5 })).toBe(105);
  });

  it("magnet-snaps to the nearest edge within threshold, beating the grid", () => {
    expect(snapAbsMin(102, { magnetEdges: [100] })).toBe(100);
  });

  it("falls back to grid when no edge is within threshold", () => {
    expect(snapAbsMin(102, { magnetEdges: [92] })).toBe(105);
  });

  it("picks the nearest of several edges", () => {
    expect(snapAbsMin(610, { magnetEdges: [600, 615, 720] })).toBe(615);
  });

  it("magnet works across midnight (continuous absolute minutes)", () => {
    expect(snapAbsMin(1438, { magnetEdges: [1440] })).toBe(1440);
  });
});

describe("shiftIsoByPx / resizeIsoByPx with SnapOpts", () => {
  const A = "2026-06-11";

  it("shiftIsoByPx magnet-snaps the start to a neighbor edge", () => {
    expect(shiftIsoByPx(A, 3, `2026-06-11T09:00:00${off(A)}`, 4, { magnetEdges: [540] })).toBe(
      `2026-06-11T09:00:00${off(A)}`,
    );
  });

  it("shiftIsoByPx fine-snaps to 5 with snapMin=5", () => {
    expect(shiftIsoByPx(A, 3, `2026-06-11T09:00:00${off(A)}`, 7, { snapMin: 5 })).toBe(
      `2026-06-11T09:05:00${off(A)}`,
    );
  });

  it("resizeIsoByPx bottom magnet-snaps the end to a neighbor edge", () => {
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-11T09:00:00${off(A)}`,
      durationMin: 60,
      edge: "bottom",
      deltaPx: 4,
      snapOpts: { magnetEdges: [600] },
    });
    expect(r.durationMin).toBe(60);
    expect(r.at).toBe(`2026-06-11T09:00:00${off(A)}`);
  });

  it("resizeIsoByPx bottom snaps the END to the grid for a non-grid-aligned start (Google event)", () => {
    // 09:07 start(=547) + 60 = end 10:07(=607); bottom edge grid-snaps the END to 10:00(=600),
    // so duration becomes 53 (the dragged edge lands on the visible gridline, not the duration).
    // This is the magnet/grid model: we snap the absolute edge position, not the duration delta.
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-11T09:07:00${off(A)}`,
      durationMin: 60,
      edge: "bottom",
      deltaPx: 0,
    });
    expect(r.durationMin).toBe(53);
    expect(r.at).toBe(`2026-06-11T09:07:00${off(A)}`);
  });
});
