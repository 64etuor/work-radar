import { describe, expect, it } from "vitest";

import { eventToHotkeySpec, parseHotkeySpec } from "./hotkey";

describe("parseHotkeySpec", () => {
  it("Cmd+Left → ArrowLeft + metaKey", () => {
    expect(parseHotkeySpec("Cmd+Left")).toEqual({
      key: "ArrowLeft",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    });
  });

  it("Cmd+Shift+C → c + meta + shift", () => {
    expect(parseHotkeySpec("Cmd+Shift+C")).toEqual({
      key: "c",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
    });
  });

  it("Cmd+, → Comma 특수키", () => {
    expect(parseHotkeySpec("Cmd+,")?.key).toBe(",");
  });

  it("modifier 없음/빈 값 → null", () => {
    expect(parseHotkeySpec("Left")).toBeNull();
    expect(parseHotkeySpec("")).toBeNull();
  });

  it("eventToHotkeySpec와 라운드트립", () => {
    const parsed = parseHotkeySpec("Cmd+Right")!;
    const spec = eventToHotkeySpec({
      key: parsed.key,
      ctrlKey: parsed.ctrlKey,
      metaKey: parsed.metaKey,
      altKey: parsed.altKey,
      shiftKey: parsed.shiftKey,
    });
    expect(spec).toBe("Cmd+Right");
  });
});
