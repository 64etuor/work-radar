import { describe, expect, it } from "vitest";

import { paginate } from "./pagination";

describe("paginate", () => {
  it("computes page count and bounds for an exact multiple", () => {
    const p = paginate(40, 20, 0);
    expect(p).toEqual({ page: 0, pageCount: 2, start: 0, end: 20 });
    expect(paginate(40, 20, 1)).toEqual({ page: 1, pageCount: 2, start: 20, end: 40 });
  });

  it("puts the remainder on the last page", () => {
    const p = paginate(45, 20, 2);
    expect(p).toEqual({ page: 2, pageCount: 3, start: 40, end: 45 });
  });

  it("clamps a requested page beyond the end (scope shrank) to the last page", () => {
    // 12페이지를 보다가 스코프가 바뀌어 총 25건이 된 경우 → 마지막 페이지(1)로.
    const p = paginate(25, 20, 12);
    expect(p.page).toBe(1);
    expect(p.start).toBe(20);
    expect(p.end).toBe(25);
  });

  it("clamps negative or fractional requested pages to a valid page", () => {
    expect(paginate(30, 20, -3).page).toBe(0);
    expect(paginate(30, 20, 1.7)).toEqual({ page: 1, pageCount: 2, start: 20, end: 30 });
  });

  it("handles an empty list as a single empty page", () => {
    const p = paginate(0, 20, 0);
    expect(p).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  it("handles fewer rows than one page", () => {
    const p = paginate(7, 20, 0);
    expect(p).toEqual({ page: 0, pageCount: 1, start: 0, end: 7 });
  });

  it("guards degenerate page sizes", () => {
    expect(paginate(5, 0, 0).end).toBe(1); // size clamped to 1
    expect(paginate(5, -4, 0).pageCount).toBe(5);
  });
});
