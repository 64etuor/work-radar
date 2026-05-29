import { parseHotkeySpec } from "@/lib/hotkey";

/**
 * combo spec("Cmd+Left")을 합성 keydown 이벤트로 만들어 window에 dispatch한다.
 * 기존 전역 keydown 핸들러(useViewShortcuts/App)가 읽는 필드만 채운다 — keyup은 불필요.
 * 파싱 실패 시 아무것도 안 쏘고 false. (knob 방향 발사 전용 유틸.)
 * _target: 테스트에서 window 대신 주입할 수 있는 EventTarget(기본 window).
 */
export function dispatchHotkey(
  spec: string,
  _target?: { dispatchEvent: (e: Event) => boolean },
): boolean {
  const parsed = parseHotkeySpec(spec);
  if (!parsed) return false;
  const target = _target ?? window;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: parsed.key,
      ctrlKey: parsed.ctrlKey,
      metaKey: parsed.metaKey,
      altKey: parsed.altKey,
      shiftKey: parsed.shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
