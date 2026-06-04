import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveSessionState, sessionsOf, type SessionState } from "./session.ts";

/** PURE: events → session states (sorted by session id via sessionsOf). No I/O, emits no events. */
export function projectSessions(all: GovEvent[]): SessionState[] {
  return sessionsOf(all).map((birth) => {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    return deriveSessionState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/sessions.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable output. This is the ONLY writer of
 *  session status; no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderSessions(workspaceDir: string): Promise<string> {
  const states = projectSessions(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "sessions.json");
  const rows = states.map((s) => ({
    sessionId: s.sessionId,
    surface: s.surface,
    ownership: s.ownership,
    taskId: s.taskId,
    phase: s.phase,
  }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
