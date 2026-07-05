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

  it("keeps guardrail forms inside the life panel instead of fixed-width overflow", () => {
    expect(missionCss).toContain(
      [
        ".mission-guardrail-form {",
        "  grid-template-columns: minmax(0, 1fr) minmax(108px, 0.7fr);",
        "  grid-template-areas:",
        '    "label label"',
        '    "area kind"',
        '    "value action";',
        "  width: 100%;",
      ].join("\n"),
    );
    expect(missionCss).toContain(
      ".mission-guardrail-form button {\n  grid-area: action;\n  justify-self: end;",
    );
    expect(missionCss).toContain(
      [
        "  .mission-guardrail-form {",
        "    grid-template-areas:",
        '      "label"',
        '      "area"',
        '      "kind"',
        '      "value"',
        '      "action";',
      ].join("\n"),
    );
  });

  it("bounds Mission dialogs to the viewport and scrolls their body", () => {
    const dialog = ruleBlock(".mission-dialog");

    expect(dialog).toContain("width: min(640px, calc(100vw - 32px))");
    expect(dialog).toContain("max-height: min(720px, calc(100vh - 48px))");
    expect(dialog).toContain("overflow-y: auto");
    expect(dialog).toContain("align-content: start");
  });
});
