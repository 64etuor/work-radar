import { describe, expect, it } from "vitest";

import { isComposingEnter } from "./ime";

// 한글 조합 확정 Enter 가드 — Enter+조합중일 때만 true. keyCode 229는 WKWebView 보조 판별.
function ev(key: string, opts: { isComposing?: boolean; keyCode?: number } = {}): KeyboardEvent {
  return {
    key,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
  } as KeyboardEvent;
}

describe("isComposingEnter", () => {
  it("조합 중 Enter만 true", () => {
    expect(isComposingEnter(ev("Enter", { isComposing: true }))).toBe(true);
    expect(isComposingEnter(ev("Enter"))).toBe(false);
  });

  it("keyCode 229(WKWebView 조합)도 잡는다", () => {
    expect(isComposingEnter(ev("Enter", { keyCode: 229 }))).toBe(true);
  });

  it("Enter가 아니면 조합 중이어도 false", () => {
    expect(isComposingEnter(ev("a", { isComposing: true }))).toBe(false);
    expect(isComposingEnter(ev("Escape", { isComposing: true }))).toBe(false);
  });

  it("React 합성 이벤트(nativeEvent 래핑)도 판별", () => {
    const react = {
      key: "Enter",
      nativeEvent: { isComposing: true, keyCode: 0 },
    } as unknown as React.KeyboardEvent;
    expect(isComposingEnter(react)).toBe(true);
  });
});
