import { describe, expect, it } from "vitest";

import {
  actionForKeymapKey,
  findKeymapAction,
  knobActionFor,
  knobActionOptions,
  knobTokenForAction,
  parseKnobToken,
  resolveCombo,
} from "./appActions";

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

describe("knob 액션 토큰 (ADR-0011 후속 ① — 방향→액션 직접 바인딩)", () => {
  it("parseKnobToken: 토큰 문법 → AppAction", () => {
    expect(parseKnobToken("adjacent:prev")).toEqual({ kind: "adjacent", dir: -1 });
    expect(parseKnobToken("adjacent:next")).toEqual({ kind: "adjacent", dir: 1 });
    expect(parseKnobToken("view:board")).toEqual({ kind: "navigate", view: "board" });
    expect(parseKnobToken("toggle:calendar")).toEqual({ kind: "toggle-calendar" });
    expect(parseKnobToken("toggle:inbox")).toEqual({ kind: "toggle-inbox" });
  });

  it("parseKnobToken: 무효 토큰/무효 view/콤보 문자열은 null", () => {
    expect(parseKnobToken("view:retro")).toBeNull(); // 제거된 view
    expect(parseKnobToken("Cmd+Left")).toBeNull(); // 콤보는 토큰이 아님(호환은 knobActionFor)
    expect(parseKnobToken("")).toBeNull();
  });

  it("knobActionFor: 토큰 정본 + 레거시 콤보 read-시 호환(기존 저장값 무파괴)", () => {
    expect(knobActionFor("adjacent:prev", undefined)).toEqual({ kind: "adjacent", dir: -1 });
    // 레거시: 종전 기본값 "Cmd+Left"/"Cmd+Right" → 인접 네비로 계속 동작.
    expect(knobActionFor("Cmd+Left", MAP)).toEqual({ kind: "adjacent", dir: -1 });
    // 레거시: 메뉴 단축키 콤보 → 그 액션.
    expect(knobActionFor("Cmd+2", MAP)).toEqual({ kind: "navigate", view: "today" });
    // 죽은 콤보(자기-매칭 포함)/빈 값 → null(그 방향 끔).
    expect(knobActionFor("Cmd+Up", MAP)).toBeNull();
    expect(knobActionFor("", MAP)).toBeNull();
  });

  it("knobTokenForAction: AppAction → 토큰 라운드트립", () => {
    for (const o of knobActionOptions()) {
      const action = parseKnobToken(o.token);
      expect(action, o.token).not.toBeNull();
      expect(knobTokenForAction(action!)).toBe(o.token);
    }
  });
});
