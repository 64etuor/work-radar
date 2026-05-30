import { describe, expect, it } from "vitest";

import { diffStats, lineDiff } from "./lineDiff";

describe("lineDiff", () => {
  it("동일하면 전부 equal", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.op === "equal")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("순수 추가", () => {
    const d = lineDiff("a\nb", "a\nx\nb");
    expect(d).toEqual([
      { op: "equal", text: "a" },
      { op: "add", text: "x" },
      { op: "equal", text: "b" },
    ]);
  });

  it("순수 삭제", () => {
    const d = lineDiff("a\nx\nb", "a\nb");
    expect(d).toEqual([
      { op: "equal", text: "a" },
      { op: "remove", text: "x" },
      { op: "equal", text: "b" },
    ]);
  });

  it("라인 수정 = remove + add", () => {
    const d = lineDiff("hello\nworld", "hello\nthere");
    expect(d).toEqual([
      { op: "equal", text: "hello" },
      { op: "remove", text: "world" },
      { op: "add", text: "there" },
    ]);
  });

  it("base가 비고 current 있음 → 전부 add(빈 라인 1개 기준)", () => {
    // "".split("\n") === [""] 이므로 빈 base는 빈 라인 하나. 한 줄 추가는 그 빈 라인 치환.
    const d = lineDiff("", "new");
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it("완전히 다른 블록", () => {
    const d = lineDiff("1\n2", "3\n4");
    expect(diffStats(d)).toEqual({ added: 2, removed: 2 });
  });
});

describe("diffStats", () => {
  it("추가/삭제 카운트(equal 제외)", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });
});
