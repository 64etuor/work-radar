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
    // 편집 전환 시 레이아웃 시프트 0 계약: textarea가 표시 span과 같은 타이포/제로 크롬.
    expect(textarea).toContain("font-family: var(--font-display)");
    expect(textarea).toContain("font-size: var(--text-title-md)");
    expect(textarea).toContain("line-height: var(--leading-title-md)");
    expect(textarea).toContain("border: 0");
    expect(textarea).toContain("resize: none");
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
    const actions = ruleBlock(".mission-form-actions");
    const guardrailActions = ruleBlock(".mission-guardrail-form .mission-form-actions");

    expect(actions).toContain("justify-self: end");
    expect(guardrailActions).toContain("grid-area: action");
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
