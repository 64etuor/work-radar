import { describe, it, expect } from "vitest";
import { normalizeModelId } from "../../src/decision/modelId.js";

describe("normalizeModelId", () => {
  it("lowercases and trims", () => {
    expect(normalizeModelId("  Claude ")).toBe("claude");
    expect(normalizeModelId("GPT-4o")).toBe("gpt-4o");
  });
  it("strips one explicit trailing @version or :version pin", () => {
    expect(normalizeModelId("codex:latest")).toBe("codex");
    expect(normalizeModelId("claude-3-5-sonnet@20241022")).toBe("claude-3-5-sonnet");
  });
  it("does NOT touch internal '-' tokens (no over-stripping)", () => {
    expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
  it("collapses internal whitespace", () => {
    expect(normalizeModelId("gpt  4o")).toBe("gpt 4o");
  });
});
