import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveHandoffState, handoffsOf, type HandoffState } from "./handoff.ts";

/** PURE: events → handoff states (sorted by handoff id via handoffsOf). No I/O, emits no events. */
export function projectHandoffs(all: GovEvent[]): HandoffState[] {
  return handoffsOf(all).map((birth) => {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    return deriveHandoffState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/handoffs.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable. The ONLY writer of handoff status;
 *  no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderHandoffs(workspaceDir: string): Promise<string> {
  const states = projectHandoffs(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "handoffs.json");
  const rows = states.map((s) => ({ handoffId: s.handoffId, sessionId: s.sessionId, phase: s.phase }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
