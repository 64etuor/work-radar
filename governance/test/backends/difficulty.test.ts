import { describe, expect, it } from "vitest";

import { inferDifficulty } from "../../src/backends/difficulty.js";

describe("inferDifficulty", () => {
  it("defaults conservatively to standard when no structural signals are present", () => {
    expect(inferDifficulty({})).toBe("standard");
  });

  it("classifies minimal no-risk work as trivial", () => {
    expect(inferDifficulty({ touchedFileCount: 1 })).toBe("trivial");
    expect(inferDifficulty({ touchedFileCount: 1, scopeTags: ["local"] })).toBe("trivial");
  });

  it("classifies broad file count, forbidden class, or broad scope as hard", () => {
    expect(inferDifficulty({ touchedFileCount: 6 })).toBe("hard");
    expect(inferDifficulty({ hasForbiddenClass: true })).toBe("hard");
    expect(inferDifficulty({ touchedFileCount: 1, scopeTags: ["architecture"] })).toBe("hard");
  });

  it("is pure and deterministic for repeated inputs", () => {
    const signals = { touchedFileCount: 2, hasForbiddenClass: false, scopeTags: ["frontend"] };
    const before = JSON.stringify(signals);

    expect(inferDifficulty(signals)).toBe(inferDifficulty(signals));
    expect(JSON.stringify(signals)).toBe(before);
  });
});
