import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveSpecState, specsOf, type SpecState } from "./spec.ts";

/** PURE: events → spec states (sorted by spec id via specsOf). No I/O, emits no events. */
export function projectSpecs(all: GovEvent[]): SpecState[] {
  return specsOf(all).map((sp) => {
    const grp = eventsForDecision(all, sp.frontmatter.id);
    return deriveSpecState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/specs.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable output. This is the ONLY writer
 *  of spec status; no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderSpecs(workspaceDir: string): Promise<string> {
  const states = projectSpecs(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "specs.json");
  const rows = states.map((s) => ({ specId: s.specId, title: s.title, phase: s.phase }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
