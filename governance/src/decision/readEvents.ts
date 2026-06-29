import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvent, type GovEvent } from "../event/event.ts";

export interface EventSnapshot {
  /** The largest event id observed in this read, or the input cursor when nothing new was found.
   *  Pass it back on the next call to read only events newer than it. */
  cursor: string | null;
  /** Events with id > the input cursor, in the same (day-sorted, file-sorted) order readAllEvents
   *  has always returned — NOT globally id-sorted. */
  events: GovEvent[];
}

/** Incremental read: every L0 event under events/<YYYY-MM-DD>/*.md whose id is greater than
 *  `cursor`. A null cursor reads the whole log (identical to the historical readAllEvents). The
 *  day-partitioned layout lets us skip entire day-dirs that predate the cursor's day WITHOUT
 *  reading them — turning a per-tick O(total) re-read into O(events since the cursor's day) for any
 *  consumer that threads a cursor. Tolerant of a missing dir.
 *
 *  Ordering note: a stamp-based id sorts by (day, time, random suffix); for the SAME id prefix an
 *  earlier day always yields a smaller id, so skipping days < cursorDay can only drop events with
 *  id < cursor — the boundary day and all later days are still id-filtered exactly. Same-second
 *  events use the id tiebreak the whole system uses; a cursor consumer should tolerate re-seeing a
 *  boundary event (writes are idempotent), so the contract is at-least-once, never lossy. */
export async function readEventsSince(
  workspaceDir: string,
  cursor: string | null,
): Promise<EventSnapshot> {
  const eventsDir = join(workspaceDir, "events");
  let days: string[] = [];
  try {
    days = await readdir(eventsDir);
  } catch {
    return { cursor, events: [] };
  }

  const cursorDay = cursor ? dayStringOf(cursor) : null;

  const dayEvents = await Promise.all(
    days
      .filter((day) => !day.startsWith("."))
      .sort()
      // Skip whole day-dirs that predate the cursor's day — their every event has id < cursor.
      .filter((day) => cursorDay === null || day >= cursorDay)
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

  let events = dayEvents.flat();
  if (cursor) events = events.filter((e) => e.frontmatter.id > cursor);

  let maxId = cursor;
  for (const e of events) {
    if (maxId === null || e.frontmatter.id > maxId) maxId = e.frontmatter.id;
  }
  return { cursor: maxId, events };
}

/** Read every L0 event under events/<YYYY-MM-DD>/*.md. Tolerant of a missing dir. */
export async function readAllEvents(workspaceDir: string): Promise<GovEvent[]> {
  return (await readEventsSince(workspaceDir, null)).events;
}

/** The day-dir string (YYYY-MM-DD) encoded in a stamp-based id, or null for stampless ids
 *  (deriveEventId ids like evt_commit_<sha>) — which disables day-skipping but not id-filtering. */
function dayStringOf(id: string): string | null {
  const m = id.match(/_(\d{4})(\d{2})(\d{2})_/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
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
