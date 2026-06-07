import type { ConnectionAudit, ProjectConnectionStatus } from "@/bindings";

/** 프로젝트 연결 상태를 개인/업무로 나눈다(표시 그룹). */
export function groupByKind(projects: ProjectConnectionStatus[]): {
  personal: ProjectConnectionStatus[];
  work: ProjectConnectionStatus[];
} {
  return {
    personal: projects.filter((p) => p.kind === "personal"),
    work: projects.filter((p) => p.kind === "work"),
  };
}

export interface AuditSummary {
  ok: number;
  failed: number;
  warnings: number;
}

/** 전체 ✓/✗ 체크 수 + 경고(중복+환경) 총합. */
export function summarize(audit: ConnectionAudit): AuditSummary {
  const checks = audit.projects.flatMap((p) => [
    p.github,
    p.notion,
    p.notionBacklogDb,
    p.notionAgendaDb,
    p.googleCalendar,
  ]);
  return {
    ok: checks.filter((c) => c.state === "ok").length,
    failed: checks.filter((c) => c.state === "failed").length,
    warnings:
      audit.duplicates.repos.length +
      audit.duplicates.notionDbs.length +
      audit.duplicates.accounts.length +
      audit.environment.length,
  };
}

/** 경고(중복/환경)가 하나라도 있는지. */
export function hasAnyWarning(audit: ConnectionAudit): boolean {
  return summarize(audit).warnings > 0;
}
