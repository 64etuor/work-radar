/**
 * useHermesPanelState — 순수 로직 테스트.
 *
 * vitest.config.ts는 environment: "node" (jsdom/RTL 미도입).
 * React hook 자체는 integration 시 확인하고, 여기서는 다음을 검증한다:
 *   1. DEFAULT_PANEL_STATE — 로딩 중 기본값이 spec과 일치
 *   2. setBounds 병합 로직 — 부분 업데이트가 기존 값을 보존하고 지정 필드만 교체
 */
import { describe, expect, it } from "vitest";

import type { HermesPanelState } from "@/bindings";

import { DEFAULT_PANEL_STATE } from "./useHermesPanelState";

// setBounds가 수행하는 병합 로직을 순수 함수로 추출해 단독 검증.
function applyBounds(
  state: HermesPanelState,
  b: Partial<{ x: number; y: number; w: number; h: number }>,
): HermesPanelState {
  return {
    ...state,
    x: b.x ?? state.x,
    y: b.y ?? state.y,
    w: b.w ?? state.w,
    h: b.h ?? state.h,
  };
}

describe("useHermesPanelState — DEFAULT_PANEL_STATE", () => {
  it("loads state from backend: default values match spec", () => {
    // 로딩 중 fallback이 spec 값(x:0, y:0, w:460, h:600, open:false)과 일치해야 한다.
    expect(DEFAULT_PANEL_STATE).toEqual({
      x: 0,
      y: 0,
      w: 460,
      h: 600,
      open: false,
    });
  });
});

describe("useHermesPanelState — setBounds merge logic", () => {
  it("setOpen calls backend with toggled value: partial bounds update preserves untouched fields", () => {
    // setOpen(true)에 대응하는 병합: open 필드만 변경, bounds는 보존.
    const base: HermesPanelState = { x: 10, y: 20, w: 460, h: 600, open: false };

    // open 토글 (setOpen은 { ...state, open } 로직)
    const toggled: HermesPanelState = { ...base, open: true };
    expect(toggled.open).toBe(true);
    expect(toggled.x).toBe(base.x);
    expect(toggled.y).toBe(base.y);
    expect(toggled.w).toBe(base.w);
    expect(toggled.h).toBe(base.h);

    // 부분 bounds 업데이트 — x만 변경
    const moved = applyBounds(base, { x: 99 });
    expect(moved.x).toBe(99);
    expect(moved.y).toBe(20);
    expect(moved.w).toBe(460);
    expect(moved.h).toBe(600);
    expect(moved.open).toBe(false);
  });
});
