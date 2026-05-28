import { describe, expect, it } from "vitest";

import { detectSlashToken } from "./HermesChatInput";

describe("detectSlashToken", () => {
  it("no slash → inactive", () => {
    const result = detectSlashToken("hello world", 11);
    expect(result.active).toBe(false);
    expect(result.query).toBe("");
    expect(result.start).toBe(-1);
  });

  it("slash at start → active with empty query", () => {
    const result = detectSlashToken("/", 1);
    expect(result.active).toBe(true);
    expect(result.query).toBe("");
    expect(result.start).toBe(0);
  });

  it("/cmd → active with query 'cmd'", () => {
    const result = detectSlashToken("/cmd", 4);
    expect(result.active).toBe(true);
    expect(result.query).toBe("cmd");
    expect(result.start).toBe(0);
  });

  it("after whitespace `/c` → active with query 'c'", () => {
    const result = detectSlashToken("hello /c", 8);
    expect(result.active).toBe(true);
    expect(result.query).toBe("c");
    expect(result.start).toBe(6);
  });

  it("trailing space ends the token", () => {
    // caret is after the space, so token is empty string (no slash)
    const result = detectSlashToken("/cmd ", 5);
    expect(result.active).toBe(false);
  });
});
