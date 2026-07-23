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

  it("uses a Korean editorial workflow with complete loading and empty states", () => {
    expect(missionViewSource).toContain('{ key: "objectives", label: "분기 목표" }');
    expect(missionViewSource).toContain('{ key: "foundation", label: "장기 목표" }');
    // 진척 스탯은 헤더가 아니라 분기 내비게이션 행에 산다(분기 파생값 + sticky 가시성).
    expect(missionViewSource).toContain('className="mission-quarter-stats"');
    // 받아쓰기(OKR AI 임포트) 어포던스는 제거됐다 — 진입 버튼 없음.
    expect(missionViewSource).not.toContain("OkrImportButton");
    expect(missionViewSource).toContain('role="status"');
    expect(missionViewSource).toContain("첫 분기 설계");
    expect(objectiveCardSource).toContain('className="mission-objective-index typo-mono-label"');
  });

  it("keeps long-term goal controls to title and period only", () => {
    expect(horizonShelfSource).toContain("mission-inline-period");
    expect(horizonShelfSource).not.toContain("WSC");
    expect(horizonShelfSource).not.toContain("mission-wsc-kind");
  });
});
