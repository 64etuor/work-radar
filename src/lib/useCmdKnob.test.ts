import { describe, expect, it } from "vitest";

import { modsExactlyMatch, parseTrigger } from "./useCmdKnob";

type EventMods = { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
const ev = (o: Partial<EventMods>): EventMods => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe("parseTrigger", () => {
  it("Cmd → meta only", () => {
    expect(parseTrigger("Cmd")).toEqual({ ctrl: false, meta: true, alt: false, shift: false });
  });
  it("Cmd+Shift → meta + shift", () => {
    expect(parseTrigger("Cmd+Shift")).toEqual({
      ctrl: false,
      meta: true,
      alt: false,
      shift: true,
    });
  });
  it("Ctrl → ctrl only", () => {
    expect(parseTrigger("Ctrl")).toEqual({ ctrl: true, meta: false, alt: false, shift: false });
  });
  it("빈 값/undefined → Cmd 폴백", () => {
    const fallback = { ctrl: false, meta: true, alt: false, shift: false };
    expect(parseTrigger("")).toEqual(fallback);
    expect(parseTrigger(undefined)).toEqual(fallback);
  });
});

describe("modsExactlyMatch", () => {
  const cmd = parseTrigger("Cmd");

  it("정확히 Cmd만 눌림 → true", () => {
    expect(modsExactlyMatch(ev({ metaKey: true }), cmd)).toBe(true);
  });
  it("트리거=Cmd인데 Cmd+Shift 눌림 → false (추가 모디파이어)", () => {
    expect(modsExactlyMatch(ev({ metaKey: true, shiftKey: true }), cmd)).toBe(false);
  });
  it("아무 모디파이어도 안 눌림 → false", () => {
    expect(modsExactlyMatch(ev({}), cmd)).toBe(false);
  });
  it("트리거=Cmd+Shift, 정확히 둘 눌림 → true", () => {
    expect(modsExactlyMatch(ev({ metaKey: true, shiftKey: true }), parseTrigger("Cmd+Shift"))).toBe(
      true,
    );
  });
  it("트리거=Cmd+Shift, Cmd만 눌림 → false (부족)", () => {
    expect(modsExactlyMatch(ev({ metaKey: true }), parseTrigger("Cmd+Shift"))).toBe(false);
  });
});
