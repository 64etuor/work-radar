import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  nearestScrollParent,
  resyncCompositorAroundCommit,
  resyncNudgePx,
  scheduleCompositorResync,
} from "./compositorResync";

describe("nearestScrollParent", () => {
  type FakeNode = {
    scrollHeight: number;
    clientHeight: number;
    parentElement: FakeNode | null;
  };
  const node = (scrollHeight: number, clientHeight: number, parent: FakeNode | null): FakeNode => ({
    scrollHeight,
    clientHeight,
    parentElement: parent,
  });

  it("클립되는(스크롤) 조상을 찾는다 — 비클립 중간 조상은 스킵", () => {
    const wrap = node(4320, 600, null); // 스크롤러(.today-canvas-wrap 상당)
    const canvas = node(4320, 4320, wrap); // 비클립(.today-canvas 상당)
    const grid = node(4320, 4320, canvas);
    expect(nearestScrollParent(grid as unknown as HTMLElement)).toBe(wrap);
  });

  it("라운딩 1px 차이는 스크롤러로 오인하지 않는다", () => {
    const parent = node(601, 600, null);
    const child = node(0, 0, parent);
    expect(nearestScrollParent(child as unknown as HTMLElement)).toBeNull();
  });

  it("스크롤 조상이 없으면/입력이 null이면 null", () => {
    expect(nearestScrollParent(null)).toBeNull();
    expect(nearestScrollParent(node(100, 100, null) as unknown as HTMLElement)).toBeNull();
  });
});

describe("resyncNudgePx", () => {
  it("아래로 스크롤 여지가 있으면 +1", () => {
    expect(resyncNudgePx({ scrollTop: 100, clientHeight: 500, scrollHeight: 4320 })).toBe(1);
  });

  it("바닥(클램프로 +1이 무효)이면 -1", () => {
    expect(resyncNudgePx({ scrollTop: 3820, clientHeight: 500, scrollHeight: 4320 })).toBe(-1);
  });

  it("소수점 스크롤 위치(바닥 근사)도 -1 — 0.5px 허용오차", () => {
    expect(resyncNudgePx({ scrollTop: 3819.7, clientHeight: 500, scrollHeight: 4320 })).toBe(-1);
  });
});

describe("scheduleCompositorResync", () => {
  let rafQueue: FrameRequestCallback[];

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const flushFrame = () => {
    const cbs = rafQueue;
    rafQueue = [];
    cbs.forEach((cb) => cb(0));
  };

  const fakeEl = (over: Partial<HTMLElement> = {}) =>
    ({
      scrollTop: 100,
      clientHeight: 500,
      scrollHeight: 4320,
      isConnected: true,
      ...over,
    }) as unknown as HTMLElement;

  it("프레임 1에서 +1px, 프레임 2에서 상대 복원(순 델타 0)", () => {
    const el = fakeEl();
    scheduleCompositorResync(el);
    expect(el.scrollTop).toBe(100); // rAF 전엔 무변
    flushFrame();
    expect(el.scrollTop).toBe(101);
    flushFrame();
    expect(el.scrollTop).toBe(100);
  });

  it("바닥에서는 -1px 후 복원 — 클램프로 델타가 죽지 않는 방향", () => {
    const el = fakeEl({ scrollTop: 3820 });
    scheduleCompositorResync(el);
    flushFrame();
    expect(el.scrollTop).toBe(3819);
    flushFrame();
    expect(el.scrollTop).toBe(3820);
  });

  it("프레임 사이 사용자 스크롤을 되감지 않는다(상대 복원)", () => {
    const el = fakeEl();
    scheduleCompositorResync(el);
    flushFrame(); // 101
    el.scrollTop = 300; // 사용자 momentum 스크롤 개입
    flushFrame();
    expect(el.scrollTop).toBe(299); // -1 상대 복원 — 절대 복원(100)이면 사용자 델타를 삼켰을 것
  });

  it("null 엘리먼트는 no-op", () => {
    scheduleCompositorResync(null);
    expect(rafQueue).toHaveLength(0);
  });

  it("detach된 엘리먼트(isConnected=false)는 건드리지 않는다", () => {
    const el = fakeEl({ isConnected: false });
    scheduleCompositorResync(el);
    flushFrame();
    expect(el.scrollTop).toBe(100);
    flushFrame();
    expect(el.scrollTop).toBe(100);
  });

  it("rAF1 후 detach되면 rAF2 복원도 건너뛴다(unmount-중간 가드)", () => {
    const el = fakeEl();
    scheduleCompositorResync(el);
    flushFrame(); // 101
    (el as unknown as { isConnected: boolean }).isConnected = false;
    flushFrame();
    expect(el.scrollTop).toBe(101); // 복원 시도 없음 — detach된 노드 무접촉
  });

  it("겹쳐 스케줄된 두 리싱크도 순 델타 0", () => {
    const el = fakeEl();
    scheduleCompositorResync(el);
    scheduleCompositorResync(el);
    flushFrame(); // 두 nudge: 100→102
    expect(el.scrollTop).toBe(102);
    flushFrame(); // 두 복원
    expect(el.scrollTop).toBe(100);
  });

  it("skip predicate가 rAF 발화 시점에 true면 nudge 자체를 포기한다", () => {
    const el = fakeEl();
    let inFlight = false;
    scheduleCompositorResync(el, () => inFlight);
    inFlight = true; // 스케줄 *후* 프로그램 스크롤 시작(anchor-shift→네비 smooth 순서 재현)
    flushFrame();
    expect(el.scrollTop).toBe(100); // 즉시 scrollTop 대입 없음 → smooth 스크롤 비중단
    flushFrame();
    expect(el.scrollTop).toBe(100);
  });

  it("skip predicate가 false면 정상 nudge/복원", () => {
    const el = fakeEl();
    scheduleCompositorResync(el, () => false);
    flushFrame();
    expect(el.scrollTop).toBe(101);
    flushFrame();
    expect(el.scrollTop).toBe(100);
  });

  it("resyncCompositorAroundCommit — 커밋 전(동기 패치)과 후(IPC/picker 재렌더) 각각 리싱크", async () => {
    const el = fakeEl();
    let resolveCommit: () => void = () => {};
    const commit = new Promise<void>((r) => {
      resolveCommit = r;
    });
    const done = resyncCompositorAroundCommit(() => el, commit);
    expect(rafQueue).toHaveLength(1); // 커밋 대기 중에도 첫 리싱크는 이미 예약됨
    flushFrame();
    flushFrame();
    expect(el.scrollTop).toBe(100); // 첫 nudge/복원 완료
    resolveCommit();
    await done;
    expect(rafQueue).toHaveLength(1); // 커밋 완료 후 둘째 리싱크 예약
    flushFrame();
    expect(el.scrollTop).toBe(101);
    flushFrame();
    expect(el.scrollTop).toBe(100);
  });
});
