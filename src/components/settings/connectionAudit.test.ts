import { describe, expect, it } from "vitest";

import type { ConnCheck, ConnectionAudit, ProjectConnectionStatus } from "@/bindings";

import { groupByKind, hasAnyWarning, summarize } from "./connectionAudit";

const ok: ConnCheck = { state: "ok", detail: "GitHub: octocat" };
const failed: ConnCheck = { state: "failed", detail: "HTTP 401" };
const none: ConnCheck = { state: "not_configured", detail: "" };

function proj(
  id: string,
  kind: "personal" | "work",
  over: Partial<ProjectConnectionStatus> = {},
): ProjectConnectionStatus {
  return {
    projectId: id,
    name: id,
    kind,
    github: none,
    notion: none,
    notionBacklogDb: none,
    notionAgendaDb: none,
    googleCalendar: none,
    gmail: none,
    ...over,
  };
}

function audit(
  projects: ProjectConnectionStatus[],
  over: Partial<ConnectionAudit> = {},
): ConnectionAudit {
  return {
    projects,
    duplicates: { repos: [], notionDbs: [], accounts: [] },
    environment: [],
    ...over,
  };
}

describe("connectionAudit", () => {
  it("groups projects by kind, preserving order", () => {
    const g = groupByKind([proj("a", "personal"), proj("b", "work"), proj("c", "personal")]);
    expect(g.personal.map((p) => p.projectId)).toEqual(["a", "c"]);
    expect(g.work.map((p) => p.projectId)).toEqual(["b"]);
  });

  it("summarizes ok/failed checks and total warnings", () => {
    const a = audit([proj("a", "work", { github: ok, notion: failed })], {
      duplicates: {
        repos: [{ identity: "o/r", projects: [] }],
        notionDbs: [],
        accounts: [{ service: "github", identity: "octocat", projects: [], crossKind: true }],
      },
      environment: [{ code: "cli.gh_multiple_installs", message: "..." }],
    });
    const s = summarize(a);
    expect(s.ok).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.warnings).toBe(3); // 1 repo dup + 1 account dup + 1 env
    expect(hasAnyWarning(a)).toBe(true);
  });

  it("reports no warnings when clean", () => {
    expect(hasAnyWarning(audit([proj("a", "work", { github: ok })]))).toBe(false);
  });
});
