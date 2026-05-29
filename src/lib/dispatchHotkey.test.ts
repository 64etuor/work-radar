import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchHotkey } from "./dispatchHotkey";

// node 환경에서 KeyboardEvent가 없으므로 globalThis에 최소 stub을 모듈 최상단에서 주입한다.
// dispatchHotkey가 new KeyboardEvent(type, init)으로 이벤트를 만들어 target.dispatchEvent에
// 넘기는 필드가 올바른지 검증하는 게 핵심이다.
class StubKeyboardEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  bubbles: boolean;
  cancelable: boolean;
  constructor(type: string, init: KeyboardEventInit = {}) {
    this.type = type;
    this.key = init.key ?? "";
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
  }
}

// @ts-expect-error node에 KeyboardEvent 없음 — 테스트 전용 stub
globalThis.KeyboardEvent = StubKeyboardEvent;

afterEach(() => vi.restoreAllMocks());

describe("dispatchHotkey", () => {
  it("Cmd+Left → ArrowLeft+meta keydown 발사 후 true", () => {
    const dispatched: StubKeyboardEvent[] = [];
    const target = {
      dispatchEvent: (e: Event) => {
        dispatched.push(e as unknown as StubKeyboardEvent);
        return true;
      },
    };

    const ok = dispatchHotkey("Cmd+Left", target);

    expect(ok).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("keydown");
    expect(dispatched[0].key).toBe("ArrowLeft");
    expect(dispatched[0].metaKey).toBe(true);
    expect(dispatched[0].altKey).toBe(false);
    expect(dispatched[0].shiftKey).toBe(false);
  });

  it("빈/무효 spec → 발사 없이 false", () => {
    const spy = vi.fn();
    const target = { dispatchEvent: spy };
    expect(dispatchHotkey("", target)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
