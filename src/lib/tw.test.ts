import { describe, expect, it } from "vitest";

import { twMergeTypo } from "./tw";

describe("twMergeTypo — typo-* conflict resolution", () => {
  it("typo-* strips built-in type classes that come before it", () => {
    expect(twMergeTypo("text-base leading-none font-semibold typo-title-md")).toBe(
      "typo-title-md",
    );
  });

  it("last-wins: a built-in type class after typo-* strips the typo-*", () => {
    expect(twMergeTypo("typo-title-md text-base")).toBe("text-base");
  });

  it("last-wins: typo-* after a built-in type class strips the built-in", () => {
    expect(twMergeTypo("text-base typo-title-md")).toBe("typo-title-md");
  });

  it("two typo roles collapse to the later one", () => {
    expect(twMergeTypo("typo-body-md typo-title-md")).toBe("typo-title-md");
  });

  it("color utilities are a different group and are preserved alongside typo-*", () => {
    expect(twMergeTypo("text-muted-foreground typo-caption-sm")).toBe(
      "text-muted-foreground typo-caption-sm",
    );
  });

  it("font-family: typo-mono-label strips an earlier font-family", () => {
    expect(twMergeTypo("font-sans typo-mono-label")).toBe("typo-mono-label");
  });

  it("non-type utilities are untouched", () => {
    expect(twMergeTypo("block mt-0.5 typo-body-strong")).toBe("block mt-0.5 typo-body-strong");
  });
});
