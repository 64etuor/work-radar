import { describe, expect, it } from "vitest";

import {
  defaultProjectCalendarColor,
  normalizeHexColor,
  projectCalendarColors,
  readableTextColor,
} from "./projectCalendarColor";

describe("projectCalendarColor", () => {
  it("normalizes hex input and rejects invalid colors", () => {
    expect(normalizeHexColor("2d6cdf")).toBe("#2D6CDF");
    expect(normalizeHexColor("#1f8a70")).toBe("#1F8A70");
    expect(normalizeHexColor("blue")).toBeNull();
  });

  it("picks readable text for light and dark backgrounds", () => {
    expect(readableTextColor("#111827")).toBe("#FFFFFF");
    expect(readableTextColor("#F8FAFC")).toBe("#111827");
  });

  it("uses deterministic project defaults when no color is configured", () => {
    expect(defaultProjectCalendarColor("project-a")).toMatch(/^#[0-9A-F]{6}$/);
    expect(projectCalendarColors("project-a", null).background).toBe(
      defaultProjectCalendarColor("project-a"),
    );
  });
});
