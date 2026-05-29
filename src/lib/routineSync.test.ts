import { describe, expect, it } from "vitest";

import type { Project } from "@/bindings";

import {
  routineSyncCandidates,
  routineSyncedLabel,
  safeParseSelectedCalendars,
} from "./routineSync";

function project(over: Partial<Project>): Project {
  return {
    id: "p",
    name: "P",
    kind: "personal",
    notionBacklogDbId: null,
    notionAgendaDbId: null,
    googleCalendarIds: null,
    calendarColor: null,
    defaultWriteCalendarId: null,
    credentialRef: "ref",
    createdAt: "2026-05-29T00:00:00",
    updatedAt: "2026-05-29T00:00:00",
    ...over,
  } as Project;
}

const calsJson = (cals: { id: string; summary: string }[]) => JSON.stringify(cals);

describe("safeParseSelectedCalendars", () => {
  it("null/빈 문자열/깨진 JSON → 빈 배열", () => {
    expect(safeParseSelectedCalendars(null)).toEqual([]);
    expect(safeParseSelectedCalendars(undefined)).toEqual([]);
    expect(safeParseSelectedCalendars("")).toEqual([]);
    expect(safeParseSelectedCalendars("{not json")).toEqual([]);
    expect(safeParseSelectedCalendars('{"id":"x"}')).toEqual([]); // 배열 아님
  });

  it("id 없는 항목은 걸러낸다", () => {
    const parsed = safeParseSelectedCalendars(
      JSON.stringify([{ id: "a", summary: "A" }, { summary: "no-id" }, 42]),
    );
    expect(parsed).toEqual([{ id: "a", summary: "A" }]);
  });
});

describe("routineSyncCandidates", () => {
  const personalA = project({
    id: "pa",
    kind: "personal",
    googleCalendarIds: calsJson([{ id: "cal-me", summary: "내 캘린더" }]),
  });
  const workA = project({
    id: "wa",
    kind: "work",
    googleCalendarIds: calsJson([{ id: "cal-work", summary: "업무" }]),
  });

  it("routineKind null이면 매핑 불가 → 빈 배열", () => {
    expect(routineSyncCandidates([personalA, workA], null)).toEqual([]);
  });

  it("같은 kind 프로젝트의 캘린더만 후보(projectId 동봉)", () => {
    const out = routineSyncCandidates([personalA, workA], "personal");
    expect(out).toEqual([{ id: "cal-me", summary: "내 캘린더", projectId: "pa" }]);
  });

  it("업무 루틴은 업무 프로젝트 캘린더만 — 개인 노출 0(교차 차단)", () => {
    const out = routineSyncCandidates([personalA, workA], "work");
    expect(out).toEqual([{ id: "cal-work", summary: "업무", projectId: "wa" }]);
  });

  it("같은 kind 프로젝트가 여러 개면 모두 평탄화", () => {
    const personalB = project({
      id: "pb",
      kind: "personal",
      googleCalendarIds: calsJson([{ id: "cal-family", summary: "가족" }]),
    });
    const out = routineSyncCandidates([personalA, personalB], "personal");
    expect(out.map((c) => c.projectId)).toEqual(["pa", "pb"]);
    expect(out.map((c) => c.id)).toEqual(["cal-me", "cal-family"]);
  });

  it("두 같은-kind 프로젝트가 같은 물리 캘린더를 고르면 중복 제거(첫 프로젝트 유지)", () => {
    // 같은 물리 캘린더 cal-me가 두 개인 프로젝트의 후보로 중복되면 picker에 같은 캘린더가
    // 두 번 뜨고, "다른 프로젝트로 같은 캘린더 이동" = 무의미한 DELETE+CREATE round-trip을 부른다.
    // → 물리 캘린더 id 기준 dedup(첫 프로젝트 유지, 안정 순서).
    const personalB = project({
      id: "pb",
      kind: "personal",
      googleCalendarIds: calsJson([{ id: "cal-me", summary: "내 캘린더(공유)" }]),
    });
    const out = routineSyncCandidates([personalA, personalB], "personal");
    expect(out).toEqual([{ id: "cal-me", summary: "내 캘린더", projectId: "pa" }]);
  });

  it("선택 캘린더 없는 프로젝트는 후보 0(막다른 길 안내용)", () => {
    const empty = project({ id: "pe", kind: "personal", googleCalendarIds: null });
    expect(routineSyncCandidates([empty], "personal")).toEqual([]);
  });
});

describe("routineSyncedLabel", () => {
  const candidates = routineSyncCandidates(
    [
      project({
        id: "pa",
        kind: "personal",
        googleCalendarIds: calsJson([{ id: "cal-me", summary: "내 캘린더" }]),
      }),
    ],
    "personal",
  );

  it("미동기화(null)면 null", () => {
    expect(routineSyncedLabel(candidates, null)).toBeNull();
  });

  it("후보에 있으면 summary", () => {
    expect(routineSyncedLabel(candidates, "cal-me")).toBe("내 캘린더");
  });

  it("후보에서 사라졌으면(설정 변경) calendarId 원문 fallback", () => {
    expect(routineSyncedLabel(candidates, "cal-gone")).toBe("cal-gone");
  });
});
