import { describe, expect, it } from "vitest";

import { clearSelection, selectedIds, toggleSelection } from "./selection";

describe("toggleSelection", () => {
  it("adds an id that is not present", () => {
    const next = toggleSelection(new Set(), "a");
    expect(next.has("a")).toBe(true);
    expect(next.size).toBe(1);
  });

  it("removes an id that is present", () => {
    const next = toggleSelection(new Set(["a", "b"]), "a");
    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(true);
  });

  it("returns a new set without mutating the input", () => {
    const original = new Set(["a"]);
    const next = toggleSelection(original, "b");
    expect(original.has("b")).toBe(false);
    expect(next).not.toBe(original);
    expect(next.has("b")).toBe(true);
  });
});

describe("selectedIds", () => {
  it("returns the selected ids in insertion order", () => {
    expect(selectedIds(new Set(["b", "a", "c"]))).toEqual(["b", "a", "c"]);
  });

  it("returns an empty array for an empty set", () => {
    expect(selectedIds(new Set())).toEqual([]);
  });
});

describe("clearSelection", () => {
  it("returns an empty set", () => {
    expect(clearSelection().size).toBe(0);
  });
});
