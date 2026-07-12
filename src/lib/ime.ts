/**
 * 한국어(IME) 조합 확정 Enter 가드 — 한글 조합 중 Enter는 "글자 확정"이지 제출이 아니다.
 * Enter-제출 핸들러 최상단에서 `if (isComposingEnter(e)) return;`으로 조기 종료한다.
 * `keyCode === 229`는 WKWebView/Safari가 조합 keydown에 isComposing을 늦게 반영하는
 * 케이스까지 잡는 표준 보조 판별이다.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function isComposingEnter(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  if (e.key !== "Enter") return false;
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}
