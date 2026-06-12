import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvent, type GovEvent } from "../event/event.ts";

/** Read every L0 event under events/<YYYY-MM-DD>/*.md. Tolerant of a missing dir. */
export async function readAllEvents(workspaceDir: string): Promise<GovEvent[]> {
  const eventsDir = join(workspaceDir, "events");
  let days: string[] = [];
  try {
    days = await readdir(eventsDir);
  } catch {
    return [];
  }

  const dayEvents = await Promise.all(
    days
      .filter((day) => !day.startsWith("."))
      .sort()
      .map(async (day) => {
        const dayDir = join(eventsDir, day);
        let files: string[] = [];
        try {
          files = await readdir(dayDir);
        } catch {
          return [];
        }
        return Promise.all(
          files
            .filter((file) => file.endsWith(".md"))
            .sort()
            .map(async (file) => parseEvent(await readFile(join(dayDir, file), "utf8"))),
        );
      }),
  );

  return dayEvents.flat();
}

export interface DecisionGroup {
  proposal: GovEvent | null;
  related: GovEvent[]; // events whose related_to includes decisionId, chronological by id
}

/** Group a flat event list around one decision id. */
export function eventsForDecision(all: GovEvent[], decisionId: string): DecisionGroup {
  const proposal = all.find((e) => e.frontmatter.id === decisionId) ?? null;
  const related = all
    .filter((e) => e.frontmatter.id !== decisionId && (e.frontmatter.related_to ?? []).includes(decisionId))
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  return { proposal, related };
}

/** All decision-proposal events in the workspace (chronological). */
export function proposalsOf(all: GovEvent[]): GovEvent[] {
  return all
    .filter((e) => e.frontmatter.type === "decision_proposed")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
