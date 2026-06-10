import { describe, expect, it } from "vitest";

import { actionForKeymapKey, findKeymapAction, resolveCombo } from "./appActions";

const MAP = {
  board: "Cmd+1",
  today: "Cmd+2",
  calendar: "Cmd+Shift+C",
  inbox: "Cmd+I",
  // knob 예약 키 — 방향 fire 콤보가 자기 자신과 매칭되면 안 된다.
  knob_up: "Cmd+Up",
  knob_down: "Cmd+Down",
  knob_left: "Cmd+Left",
  knob_right: "Cmd+Right",
  knob_trigger: "Cmd",
};

describe("findKeymapAction", () => {
  it("일반 액션은 spec 정확 매칭(대소문자 무시)", () => {
    expect(findKeymapAction(MAP, "Cmd+1")).toBe("board");
    expect(findKeymapAction(MAP, "cmd+shift+c")).toBe("calendar");
  });

  it("knob 예약 키는 매칭 제외 — knob_up='Cmd+Up' fire가 자기-매칭돼 무효 View 네비를 일으키던 버그", () => {
    expect(findKeymapAction(MAP, "Cmd+Up")).toBeNull();
    expect(findKeymapAction(MAP, "Cmd+Down")).toBeNull();
  });

  it("빈 spec/미등록 combo는 null", () => {
    expect(findKeymapAction({ board: "" }, "")).toBeNull();
    expect(findKeymapAction(MAP, "Cmd+9")).toBeNull();
  });
});

describe("actionForKeymapKey", () => {
  it("등록 view → navigate 액션", () => {
    expect(actionForKeymapKey("board")).toEqual({ kind: "navigate", view: "board" });
  });

  it("calendar/inbox → 토글 액션", () => {
    expect(actionForKeymapKey("calendar")).toEqual({ kind: "toggle-calendar" });
    expect(actionForKeymapKey("inbox")).toEqual({ kind: "toggle-inbox" });
  });

  it("미등록 키(제거된 view가 저장 keymap에 남은 경우 등)는 null — 무효 View 캐스팅 차단", () => {
    expect(actionForKeymapKey("retro")).toBeNull();
    expect(actionForKeymapKey("knob_up")).toBeNull();
  });
});

describe("resolveCombo", () => {
  it("Cmd/Ctrl+←/→는 keymap보다 먼저 인접 네비로(하드코딩 단축키와 동일 우선순위)", () => {
    expect(resolveCombo(MAP, "Cmd+Left")).toEqual({ kind: "adjacent", dir: -1 });
    expect(resolveCombo(MAP, "ctrl+right")).toEqual({ kind: "adjacent", dir: 1 });
    // keymap이 없어도 인접 네비는 해석된다(knob 기본 바인딩 보장).
    expect(resolveCombo(undefined, "Cmd+Left")).toEqual({ kind: "adjacent", dir: -1 });
  });

  it("keymap 액션 combo → 해당 AppAction", () => {
    expect(resolveCombo(MAP, "Cmd+2")).toEqual({ kind: "navigate", view: "today" });
    expect(resolveCombo(MAP, "Cmd+Shift+C")).toEqual({ kind: "toggle-calendar" });
  });

  it("knob 자기-매칭 콤보(Cmd+Up 등)는 null — 종전 버그의 end-to-end 가드", () => {
    expect(resolveCombo(MAP, "Cmd+Up")).toBeNull();
    expect(resolveCombo(MAP, "Cmd+Down")).toBeNull();
  });

  it("미등록 combo는 null(no-op)", () => {
    expect(resolveCombo(MAP, "Cmd+K")).toBeNull();
  });
});
