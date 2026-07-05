import { describe, expect, it } from "vitest";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");
const missionCss = readFileSync?.(resolve?.(__dirname, "MissionView.css") ?? "", "utf8") ?? "";

function ruleBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(missionCss);
  return match?.[1] ?? "";
}

describe("MissionView layout", () => {
  it("keeps the mission statement edit form in the header rhythm", () => {
    const form = ruleBlock(".mission-statement-form");
    const textarea = ruleBlock(".mission-statement-form textarea");

    expect(form).toContain("width: min(860px, 100%)");
    expect(form).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(form).toContain("align-items: start");
    expect(textarea).toContain("min-height: 44px");
    expect(textarea).toContain("resize: vertical");
  });
});
