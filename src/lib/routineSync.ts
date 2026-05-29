/**
 * 루틴 Google 동기화 picker 순수 로직 (PR 2b-2).
 *
 * 루틴은 자신의 kind(개인/업무)와 같은 kind의 프로젝트에 매핑된다(ADR-0005). sync 후보는
 * 그 프로젝트들이 설정에서 이미 선택한 `googleCalendarIds`(로컬 JSON). 네트워크 호출 없음.
 * 이 모듈은 시간/IO 무의존 — node vitest로 단위 테스트(코드베이스 컨벤션: RTL 미도입).
 */
import type { Kind, Project, SelectedCalendar } from "@/bindings";

export type RoutineSyncCandidate = SelectedCalendar & { projectId: string };

/** project.googleCalendarIds(JSON 문자열) → SelectedCalendar[]. 깨진 JSON/형식은 빈 배열로 graceful. */
export function safeParseSelectedCalendars(json: string | null | undefined): SelectedCalendar[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is SelectedCalendar =>
        typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}

/**
 * 루틴 kind와 같은 kind의 프로젝트들이 선택한 캘린더 = sync 후보(projectId 동봉).
 * routineKind가 null이면 매핑 불가 → 빈 배열.
 */
export function routineSyncCandidates(
  projects: Project[],
  routineKind: Kind | null,
): RoutineSyncCandidate[] {
  if (routineKind == null) return [];
  // 물리 캘린더 id 기준 dedup(첫 프로젝트 유지, 안정 순서). 같은 캘린더를 여러 같은-kind
  // 프로젝트가 고르면 picker에 중복으로 뜨고, "다른 프로젝트로 같은 캘린더 이동" = 무의미한
  // DELETE+CREATE round-trip을 부른다 — id가 같으면 동일 물리 캘린더이므로 한 번만 노출한다.
  const seen = new Set<string>();
  return projects
    .filter((p) => p.kind === routineKind)
    .flatMap((p) =>
      safeParseSelectedCalendars(p.googleCalendarIds).map((c) => ({ ...c, projectId: p.id })),
    )
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
}

/**
 * 동기화 중인 루틴의 표시 라벨 — 후보에서 summary 우선, 없으면 calendarId 원문 fallback.
 * googleCalendarId가 null(미동기화)이면 null.
 */
export function routineSyncedLabel(
  candidates: RoutineSyncCandidate[],
  googleCalendarId: string | null,
): string | null {
  if (googleCalendarId == null) return null;
  const match = candidates.find((c) => c.id === googleCalendarId);
  return match?.summary || googleCalendarId;
}
