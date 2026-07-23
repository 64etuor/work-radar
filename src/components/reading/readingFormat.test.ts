import { describe, expect, it } from "vitest";

import {
  bookMatchesQuery,
  normalizeForMatch,
  paceInfo,
  progressPct,
  starFills,
  tierOf,
  yearOf,
} from "./readingFormat";

describe("tierOf", () => {
  it("buckets ratings into Obsidian hall-of-fame tiers", () => {
    expect(tierOf(10)).toBe("S");
    expect(tierOf(9)).toBe("S");
    expect(tierOf(8.9)).toBe("A");
    expect(tierOf(7)).toBe("A");
    expect(tierOf(5)).toBe("B");
    expect(tierOf(3)).toBe("C");
    expect(tierOf(1)).toBe("D");
    expect(tierOf(0.5)).toBe("none");
    expect(tierOf(null)).toBe("none");
  });
});

describe("starFills", () => {
  it("maps 0..10 rating to five star fill percents", () => {
    expect(starFills(10)).toEqual([100, 100, 100, 100, 100]);
    expect(starFills(5)).toEqual([100, 100, 50, 0, 0]);
    expect(starFills(0)).toEqual([0, 0, 0, 0, 0]);
    expect(starFills(9)).toEqual([100, 100, 100, 100, 50]);
  });
});

describe("progressPct", () => {
  it("clamps to 0..100 and returns null without page count", () => {
    expect(progressPct(206, 412)).toBe(50);
    expect(progressPct(500, 412)).toBe(100);
    expect(progressPct(0, 412)).toBe(0);
    expect(progressPct(50, null)).toBeNull();
    expect(progressPct(50, 0)).toBeNull();
  });
});

describe("paceInfo", () => {
  it("computes expected books from year progress (Obsidian formula)", () => {
    // 연말: 기대 = 목표 전체.
    const end = paceInfo(40, 52, "2026-12-31");
    expect(end.expected).toBe(52);
    expect(end.diff).toBe(-12);
    expect(end.remaining).toBe(12);

    // 연초: 기대 0권 근처, 달성률 클램프.
    const start = paceInfo(60, 52, "2026-01-01");
    expect(start.expected).toBe(0);
    expect(start.pct).toBe(100);
    expect(start.remaining).toBe(0);
    expect(start.monthlyGoal).toBe(5);
  });
});

describe("normalizeForMatch / bookMatchesQuery", () => {
  it("matches regardless of spacing and punctuation", () => {
    expect(normalizeForMatch("바보들은 항상 남의 탓만 한다!")).toBe(
      normalizeForMatch("바보들은항상남의탓만한다"),
    );
    const book = {
      title: "바보들은 항상 남의 탓만 한다",
      subtitle: null,
      authors: ["존 밀러"],
    };
    expect(bookMatchesQuery(book, "바보들은항상")).toBe(true);
    expect(bookMatchesQuery(book, "남의 탓만")).toBe(true);
    expect(bookMatchesQuery(book, "존밀러")).toBe(true);
    // 검색어가 제목보다 길어도(부제까지 입력) 제목이 포함되면 매치.
    expect(
      bookMatchesQuery(
        { title: "코스모스", subtitle: null, authors: [] },
        "코스모스 가능한 세계들",
      ),
    ).toBe(true);
    expect(bookMatchesQuery(book, "완전 다른 책")).toBe(false);
    expect(bookMatchesQuery(book, "바")).toBe(false);
  });
});

describe("yearOf", () => {
  it("extracts the year with a sane fallback", () => {
    expect(yearOf("2026-07-23")).toBe(2026);
    expect(yearOf("")).toBe(new Date().getFullYear());
  });
});
