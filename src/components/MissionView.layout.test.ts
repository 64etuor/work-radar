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
  it("stages the mission as an editorial header with sticky season navigation", () => {
    const top = ruleBlock(".mission-top");
    const overview = ruleBlock(".mission-season-overview");
    const navigation = ruleBlock(".mission-quarter-row");
    const tabs = ruleBlock(".mission-tabs");

    expect(top).toContain("display: grid");
    expect(top).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(overview).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(navigation).toContain("position: sticky");
    expect(navigation).toContain("z-index: var(--wr-z-raised)");
    expect(tabs).toContain("border-bottom: 1px solid var(--color-wr-border-light)");
  });

  it("presents objectives as numbered rule-separated document sections", () => {
    const objective = ruleBlock(".mission-objective");
    const head = ruleBlock(".mission-objective-head");
    const index = ruleBlock(".mission-objective-index");

    expect(objective).toContain("border-top: 1px solid var(--color-wr-border)");
    expect(objective).toContain("border-bottom: 1px solid var(--color-wr-border-light)");
    expect(objective).toContain("box-shadow: none");
    expect(head).toContain("display: grid");
    expect(head).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    expect(index).toContain("font-variant-numeric: tabular-nums");
  });

  it("keeps the editorial workflow usable on narrow windows", () => {
    expect(missionCss).toContain("@media (max-width: 720px)");
    expect(missionCss).toContain("overflow-x: auto");
    expect(missionCss).toContain("grid-template-areas:");
    expect(missionCss).toContain("grid-template-columns: minmax(180px, 1fr) auto");
    expect(missionCss).not.toContain('grid-template-areas:\n      "quarter"\n      "tabs"');
  });

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

  it("keeps the foundation tab as a single long-term-goal panel", () => {
    const lifeGrid = ruleBlock(".mission-life-grid");
    const inlineEditor = ruleBlock(".mission-horizon-item > .mission-inline-editor");
    const period = ruleBlock(".mission-inline-period");
    const actions = ruleBlock(".mission-form-actions");

    expect(lifeGrid).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(inlineEditor).toContain("display: flex");
    expect(period).toContain("width: 120px");
    expect(actions).toContain("justify-self: end");
    expect(missionCss).not.toContain("mission-guardrail-form");
  });

  it("bounds Mission dialogs to the viewport and scrolls their body", () => {
    const dialog = ruleBlock(".mission-dialog");

    expect(dialog).toContain("width: min(640px, calc(100vw - 32px))");
    expect(dialog).toContain("max-height: min(720px, calc(100vh - 48px))");
    expect(dialog).toContain("overflow-y: auto");
    expect(dialog).toContain("align-content: start");
  });
});
