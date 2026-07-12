import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { WorkSignal } from "@/bindings";

import {
  areaTagPatch,
  moveSignalFromToday,
  moveSignalToToday,
  patchSignalInLists,
  removeSignalFromLists,
  reorderListCache,
  snapshotQueries,
} from "./optimistic";

// 낙관 업데이트 헬퍼 회귀 가드 — snapshot/rollback 대칭, 멤버십 이동의 양쪽 캐시 정합,
// 부분 겹침 리스트 보호(reorder)가 계약이다.
function sig(id: string, patch: Partial<WorkSignal> = {}): WorkSignal {
  return { id, title: id, quadrant: "unclassified", todayForDate: null, ...patch } as WorkSignal;
}

function makeQc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("patchSignalInLists", () => {
  it("모든 WorkSignal[] 캐시에서 해당 id만 패치한다", () => {
    const qc = makeQc();
    qc.setQueryData(["signals"], [sig("a"), sig("b")]);
    qc.setQueryData(["today", "2026-07-12"], [sig("a")]);
    patchSignalInLists(qc, "a", { title: "새 제목" });
    expect((qc.getQueryData<WorkSignal[]>(["signals"]) ?? [])[0].title).toBe("새 제목");
    expect((qc.getQueryData<WorkSignal[]>(["signals"]) ?? [])[1].title).toBe("b");
    expect((qc.getQueryData<WorkSignal[]>(["today", "2026-07-12"]) ?? [])[0].title).toBe("새 제목");
  });
});

describe("removeSignalFromLists", () => {
  it("지정 prefix 캐시에서만 제거하고, id 미포함 캐시는 identity 보존", () => {
    const qc = makeQc();
    const untouched = [sig("x")];
    qc.setQueryData(["signals"], [sig("a"), sig("b")]);
    qc.setQueryData(["today", "2026-07-12"], untouched);
    removeSignalFromLists(qc, "a", [["signals"], ["today"]]);
    expect(qc.getQueryData<WorkSignal[]>(["signals"])?.map((s) => s.id)).toEqual(["b"]);
    expect(qc.getQueryData<WorkSignal[]>(["today", "2026-07-12"])).toBe(untouched);
  });
});

describe("moveSignalToToday / moveSignalFromToday", () => {
  it("승격: signals에서 빠지고 해당 날짜 today 끝에 todayForDate와 함께 붙는다", () => {
    const qc = makeQc();
    qc.setQueryData(["signals"], [sig("a", { quadrant: "q2_schedule" }), sig("b")]);
    qc.setQueryData(["today", "2026-07-12"], [sig("t1", { todayForDate: "2026-07-12" })]);
    moveSignalToToday(qc, "a", "2026-07-12");
    expect(qc.getQueryData<WorkSignal[]>(["signals"])?.map((s) => s.id)).toEqual(["b"]);
    const today = qc.getQueryData<WorkSignal[]>(["today", "2026-07-12"]) ?? [];
    expect(today.map((s) => s.id)).toEqual(["t1", "a"]);
    expect(today[1].todayForDate).toBe("2026-07-12");
    expect(today[1].quadrant).toBe("q2_schedule"); // 원 quadrant 배지 유지
  });

  it("승격 취소: 모든 today 캐시에서 빠지고 signals로 복귀(todayForDate 해제)", () => {
    const qc = makeQc();
    qc.setQueryData(["signals"], [sig("b")]);
    qc.setQueryData(["today", "2026-07-12"], [sig("a", { todayForDate: "2026-07-12" })]);
    moveSignalFromToday(qc, "a");
    expect(qc.getQueryData<WorkSignal[]>(["today", "2026-07-12"])).toEqual([]);
    const signals = qc.getQueryData<WorkSignal[]>(["signals"]) ?? [];
    expect(signals.map((s) => s.id)).toEqual(["b", "a"]);
    expect(signals[1].todayForDate).toBeNull();
  });

  it("signals 캐시에 없는 id 승격은 today를 건드리지 않는다", () => {
    const qc = makeQc();
    qc.setQueryData(["signals"], [sig("b")]);
    const today = [sig("t1")];
    qc.setQueryData(["today", "2026-07-12"], today);
    moveSignalToToday(qc, "없는놈", "2026-07-12");
    expect(qc.getQueryData(["today", "2026-07-12"])).toBe(today);
  });
});

describe("reorderListCache", () => {
  it("멤버십이 정확히 일치하는 캐시만 재정렬한다", () => {
    const qc = makeQc();
    qc.setQueryData(["today", "2026-07-12"], [sig("a"), sig("b"), sig("c")]);
    reorderListCache<WorkSignal>(qc, ["today"], ["c", "a", "b"]);
    expect(qc.getQueryData<WorkSignal[]>(["today", "2026-07-12"])?.map((s) => s.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("부분 겹침(다른 날짜) 리스트는 오염시키지 않는다", () => {
    const qc = makeQc();
    const other = [sig("a"), sig("z")]; // orderedIds와 멤버십 불일치
    qc.setQueryData(["today", "2026-07-11"], other);
    reorderListCache<WorkSignal>(qc, ["today"], ["c", "a", "b"]);
    expect(qc.getQueryData(["today", "2026-07-11"])).toBe(other);
  });
});

describe("snapshotQueries", () => {
  it("롤백 함수가 패치 이전 상태로 되돌린다", async () => {
    const qc = makeQc();
    const before = [sig("a"), sig("b")];
    qc.setQueryData(["signals"], before);
    const rollback = await snapshotQueries(qc, [["signals"]]);
    removeSignalFromLists(qc, "a", [["signals"]]);
    expect(qc.getQueryData<WorkSignal[]>(["signals"])?.length).toBe(1);
    rollback();
    expect(qc.getQueryData(["signals"])).toEqual(before);
  });
});

describe("areaTagPatch", () => {
  it("tagKey 선택은 areaTags JSON 단일 배열, 해제는 areaTags/area 동시 null", () => {
    expect(areaTagPatch("health")).toEqual({ areaTags: '["health"]' });
    expect(areaTagPatch(null)).toEqual({ areaTags: null, area: null });
  });
});
