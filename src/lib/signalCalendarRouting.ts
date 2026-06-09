import type { Kind, Project } from "@/bindings";

/**
 * 카드 캘린더 등록용 project routing.
 *
 * `signal.projectId`는 과거 kind 변경 전 값일 수 있으므로 현재 signal.kind와 맞을 때만 신뢰한다.
 * mismatch/null이면 같은 kind 프로젝트의 첫 항목으로 재해석한다(create_signal 기본 라우팅과 동일).
 */
export function signalCalendarProjectId(
  projects: Project[],
  signalProjectId: string | null,
  signalKind: Kind | null,
): string | null {
  if (signalKind == null) return null;
  const current = signalProjectId ? projects.find((p) => p.id === signalProjectId) : null;
  if (current?.kind === signalKind) return current.id;
  return projects.find((p) => p.kind === signalKind)?.id ?? null;
}
