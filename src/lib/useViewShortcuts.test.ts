import { describe, expect, it } from "vitest";

import { findKeymapAction } from "./useViewShortcuts";

describe("findKeymapAction", () => {
  const map = {
    board: "Cmd+1",
    today: "Cmd+2",
    calendar: "Cmd+Shift+C",
    // knob 예약 키 — 방향 fire 콤보가 자기 자신과 매칭되면 안 된다.
    knob_up: "Cmd+Up",
    knob_down: "Cmd+Down",
    knob_left: "Cmd+Left",
    knob_right: "Cmd+Right",
    knob_trigger: "Cmd",
  };

  it("일반 액션은 spec 정확 매칭(대소문자 무시)", () => {
    expect(findKeymapAction(map, "Cmd+1")).toBe("board");
    expect(findKeymapAction(map, "cmd+shift+c")).toBe("calendar");
  });

  it("knob 예약 키는 매칭 제외 — knob_up='Cmd+Up' fire가 자기-매칭돼 무효 View 네비를 일으키던 버그", () => {
    expect(findKeymapAction(map, "Cmd+Up")).toBeNull();
    expect(findKeymapAction(map, "Cmd+Down")).toBeNull();
  });

  it("빈 spec은 매칭 안 됨", () => {
    expect(findKeymapAction({ board: "" }, "")).toBeNull();
  });

  it("미등록 combo는 null", () => {
    expect(findKeymapAction(map, "Cmd+9")).toBeNull();
  });
});
