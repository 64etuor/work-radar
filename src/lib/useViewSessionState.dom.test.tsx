// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetViewSessionStateForTest, useViewSessionState } from "./useViewSessionState";

// 뷰 전환 리마운트 생존 계약 — useState 드롭인이면서 값이 모듈 Map에 미러돼
// 언마운트→재마운트 후에도 마지막 값으로 시딩된다.
function Probe({ sessionKey }: { sessionKey: string }) {
  const [value, setValue] = useViewSessionState(sessionKey, "초기값");
  return (
    <button type="button" onClick={() => setValue((prev) => `${prev}→변경`)}>
      {value}
    </button>
  );
}

let root: Root;
let host: HTMLDivElement;

function click() {
  host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  resetViewSessionStateForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useViewSessionState", () => {
  it("리마운트 후에도 마지막 값으로 시딩된다(뷰 전환 생존, 함수형 업데이트 지원)", () => {
    act(() => root.render(<Probe sessionKey="k" />));
    expect(host.textContent).toBe("초기값");
    act(() => click());
    expect(host.textContent).toBe("초기값→변경");

    // 뷰 전환 대역: 언마운트 후 재마운트.
    act(() => root.render(null));
    act(() => root.render(<Probe sessionKey="k" />));
    expect(host.textContent).toBe("초기값→변경");
  });

  it("키가 다르면 독립", () => {
    act(() => root.render(<Probe sessionKey="a" />));
    act(() => click());
    act(() => root.render(null));
    act(() => root.render(<Probe sessionKey="b" />));
    expect(host.textContent).toBe("초기값");
  });
});
