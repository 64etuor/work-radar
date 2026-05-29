// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { isOverlayOpen, OVERLAY_OPEN_ATTR } from "./overlay-stack";

// 상호작용 계약(shadcn-migration.md §radix Dialog Esc 계약) 핵심: isOverlayOpen=true면 App 셸 Esc가
// 창 숨김을 양보한다. 단일 진실원 = DOM의 `data-wr-overlay-open` 마커 — 수동 카운터가 없어 drift 불가.
// (node 환경으로는 못 잡던 DOM/effect 동기화 버그를 happy-dom으로 잠근다.)

afterEach(() => {
  document.body.innerHTML = "";
});

/** 열린 오버레이 콘텐츠를 흉내내 마커 단 노드를 붙인다. 제거 함수를 반환(닫힘 시뮬레이션). */
function mountOverlay(): () => void {
  const el = document.createElement("div");
  el.setAttribute(OVERLAY_OPEN_ATTR, "");
  document.body.appendChild(el);
  return () => el.remove();
}

describe("overlay-stack", () => {
  it("마커가 없으면 isOverlayOpen=false", () => {
    expect(isOverlayOpen()).toBe(false);
  });

  it("마커가 붙으면 열림, 제거되면 닫힘", () => {
    const close = mountOverlay();
    expect(isOverlayOpen()).toBe(true);
    close();
    expect(isOverlayOpen()).toBe(false);
  });

  it("중첩(Dialog 안 Select) — 안쪽 닫혀도 바깥 마커가 남아 열림 유지", () => {
    const closeOuter = mountOverlay();
    const closeInner = mountOverlay();
    expect(isOverlayOpen()).toBe(true);
    closeInner(); // 안쪽(Select) Esc로 닫힘 → 마커 1개 제거
    expect(isOverlayOpen()).toBe(true); // 바깥(Dialog) 마커 아직 존재 → 셸은 계속 양보
    closeOuter();
    expect(isOverlayOpen()).toBe(false);
  });

  it("마커 없는 노드는 오버레이로 세지 않는다(false-positive 방지)", () => {
    const el = document.createElement("div");
    el.className = "brain-dump-toggle";
    document.body.appendChild(el);
    expect(isOverlayOpen()).toBe(false);
  });
});
