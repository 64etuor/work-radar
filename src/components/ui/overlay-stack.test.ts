import { describe, expect, it } from "vitest";

import { isOverlayOpen, registerOverlay } from "./overlay-stack";

// 상호작용 계약(plan §0.6) 핵심 로직 검증: 오버레이 열림 카운트가 App 셸 Esc 양보의 기준.
// (radix content mount=push / unmount=pop를 각 *Content effect가 호출 — 여기선 그 레지스트리 자체를 잠근다.)
describe("overlay-stack", () => {
  it("닫힌 상태에서는 isOverlayOpen=false", () => {
    expect(isOverlayOpen()).toBe(false);
  });

  it("등록 시 열림, 해제 시 닫힘", () => {
    const release = registerOverlay();
    expect(isOverlayOpen()).toBe(true);
    release();
    expect(isOverlayOpen()).toBe(false);
  });

  it("중첩(Dialog 안 Select) — 카운트로 안전: 안쪽 해제해도 바깥 열림 유지", () => {
    const outer = registerOverlay();
    const inner = registerOverlay();
    expect(isOverlayOpen()).toBe(true);
    inner(); // 안쪽(Select) Esc로 닫힘
    expect(isOverlayOpen()).toBe(true); // 바깥(Dialog) 아직 열림 → 셸은 계속 양보
    outer();
    expect(isOverlayOpen()).toBe(false);
  });

  it("중복 해제는 멱등(카운트 음수 방지)", () => {
    const release = registerOverlay();
    release();
    release(); // 두 번째 호출 무시
    expect(isOverlayOpen()).toBe(false);

    // 다른 오버레이가 영향을 받지 않아야 함
    const other = registerOverlay();
    expect(isOverlayOpen()).toBe(true);
    other();
    expect(isOverlayOpen()).toBe(false);
  });
});
