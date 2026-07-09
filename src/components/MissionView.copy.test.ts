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
const missionViewSource =
  readFileSync?.(resolve?.(__dirname, "MissionView.tsx") ?? "", "utf8") ?? "";
const routineLinkSource =
  readFileSync?.(resolve?.(__dirname, "okr/RoutineLinkControl.tsx") ?? "", "utf8") ?? "";
const systemDiagnosisSource =
  readFileSync?.(resolve?.(__dirname, "weekly/SystemDiagnosis.tsx") ?? "", "utf8") ?? "";
const sprintTimerSource =
  readFileSync?.(resolve?.(__dirname, "SprintTimer.tsx") ?? "", "utf8") ?? "";
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

  it("frames routines as KR automation and sprint focus as automatic sync", () => {
    expect(routineLinkSource).toContain("루틴으로 자동화");
    expect(routineLinkSource).toContain("KR 진행이 자동 집계");
    expect(systemDiagnosisSource).toContain("자동 동기화");
    expect(systemDiagnosisSource).not.toContain("주간 목표로 교체");
    expect(systemDiagnosisSource).not.toContain("주간 목표로 연결");
    expect(sprintTimerSource).not.toContain("주간 목표로 교체");
  });

  it("keeps the foundation tab focused on long-term goals without guardrail management", () => {
    expect(missionViewSource).toContain("<HorizonShelf horizons={horizons.data ?? []} />");
    expect(missionViewSource).not.toContain("GuardrailPanel");
    expect(missionViewSource).not.toContain("useGuardrails");
  });

  it("keeps long-term goal controls to title and period only", () => {
    expect(horizonShelfSource).toContain("mission-inline-period");
    expect(horizonShelfSource).not.toContain("WSC");
    expect(horizonShelfSource).not.toContain("mission-wsc-kind");
  });
});
