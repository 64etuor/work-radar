import { describe, expect, it } from "vitest";

import { eventToHotkeySpec, formatHotkeySpec } from "./hotkey";

describe("formatHotkeySpec", () => {
  it("modifier를 심볼로 바꾸고 구분자 없이 결합", () => {
    expect(formatHotkeySpec("Cmd+1")).toBe("⌘1");
    expect(formatHotkeySpec("Cmd+Shift+K")).toBe("⌘⇧K");
    expect(formatHotkeySpec("Cmd+Left")).toBe("⌘←");
    expect(formatHotkeySpec("Cmd+,")).toBe("⌘,");
  });
  it("빈 spec은 빈 문자열", () => {
    expect(formatHotkeySpec("")).toBe("");
  });
});

describe("eventToHotkeySpec", () => {
  it("modifier 동반 키 → 정규화 spec", () => {
    expect(
      eventToHotkeySpec({
        key: "1",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("Cmd+1");
    expect(
      eventToHotkeySpec({
        key: "ArrowRight",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("Cmd+Right");
  });
  it("modifier 없음/modifier-only → null", () => {
    expect(
      eventToHotkeySpec({
        key: "a",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(
      eventToHotkeySpec({
        key: "Meta",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });
});
