import { describe, expect, it } from "vitest";

declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");
const horizonShelfSource =
  readFileSync?.(resolve?.(__dirname, "okr/HorizonShelf.tsx") ?? "", "utf8") ?? "";
const objectiveDialogSource =
  readFileSync?.(resolve?.(__dirname, "okr/ObjectiveDialog.tsx") ?? "", "utf8") ?? "";
const objectiveCardSource =
  readFileSync?.(resolve?.(__dirname, "okr/ObjectiveCard.tsx") ?? "", "utf8") ?? "";
const navSource = readFileSync?.(resolve?.(__dirname, "../lib/nav.ts") ?? "", "utf8") ?? "";

describe("MissionView copy", () => {
  it("names horizons as long-term goals in the user-facing Mission UX", () => {
    expect(horizonShelfSource).toContain(">장기 목표<");
    expect(horizonShelfSource).toContain("저장된 장기 목표가 없습니다");
    expect(horizonShelfSource).toContain('placeholder="장기 목표 또는 1년 테마"');
    expect(objectiveDialogSource).toContain("저장된 장기 목표가 없습니다");
    expect(objectiveCardSource).toContain("연결된 태그/프로젝트/장기 목표 없음");
    expect(navSource).toContain("장기 목표");
  });
});
