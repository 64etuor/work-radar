// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { useDebouncedCallback } from "./useDebouncedCallback";

// React가 act()를 테스트 환경으로 인식하게 한다(RTL이 설정하는 플래그 — 이 레포는 RTL 미도입).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Api = {
  run: (s: string) => void;
  flushNow: (s: string) => void;
  cancel: () => void;
};

// 노드 env로는 effect/unmount cleanup이 안 돈다(usePendingFocus.test는 renderToStaticMarkup=render-phase만).
// flush-on-unmount는 useEffect cleanup이므로 happy-dom + createRoot/unmount로 실제 라이프사이클을 돌린다.
function setup(fn: (s: string) => void, delay: number) {
  const ref: { current: Api | null } = { current: null };
  function Harness() {
    ref.current = useDebouncedCallback(fn, delay);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  return {
    api: () => {
      if (!ref.current) throw new Error("hook not mounted");
      return ref.current;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("useDebouncedCallback", () => {
  it("디바운스 도중 언마운트되면 마지막 인자로 flush한다(입력 유실 방지)", () => {
    const fn = vi.fn();
    const { api, unmount } = setup(fn, 400);

    act(() => api().run("draft"));
    expect(fn).not.toHaveBeenCalled(); // 아직 디바운스 대기 중.

    unmount();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("draft"); // 키 변경(프로젝트 전환)으로 카드가 사라져도 저장됨.
  });

  it("cancel()로 비운 뒤 언마운트되면 flush하지 않는다", () => {
    const fn = vi.fn();
    const { api, unmount } = setup(fn, 400);

    act(() => {
      api().run("draft");
      api().cancel(); // 사용자가 입력을 무효화(예: 잘못된 hex) — pending 비움.
    });

    unmount();
    expect(fn).not.toHaveBeenCalled();
  });

  it("flushNow() 이후 언마운트는 중복 호출하지 않는다", () => {
    const fn = vi.fn();
    const { api, unmount } = setup(fn, 400);

    act(() => {
      api().run("draft");
      api().flushNow("final"); // 즉시 저장 — pending 클리어.
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("final");

    unmount();
    expect(fn).toHaveBeenCalledTimes(1); // unmount가 다시 쏘지 않음.
  });
});
