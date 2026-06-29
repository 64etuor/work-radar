import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvent, type GovEvent } from "../event/event.ts";
import { parseIdStampUtc, stampUtc } from "../event/id.ts";

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
 *  Contract: a null cursor reads the WHOLE log (every event, including stampless harvested ones);
 *  a non-null cursor returns the stamp-based events strictly newer than it. Stampless harvested ids
 *  (evt_commit_/evt_adr_/evt_decision_) are ordered BELOW every stamp id (see orderKey) so they can
 *  never advance the cursor nor mask a newer stamp event — and are therefore excluded from
 *  incremental (non-null-cursor) reads. They remain fully visible on the null-cursor full read that
 *  the graph index rebuilds from. Same-second stamp events use the id tiebreak; a cursor consumer
 *  may re-see a boundary event (writes are idempotent), so the contract is at-least-once over stamp
 *  events, never lossy. */
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
      // Skip whole day-dirs that predate the cursor's day — every stamp event there is older, and
      // any stampless event there orders below the cursor anyway (correctness is in orderKey).
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
  if (cursor) {
    const cur = orderKey(cursor);
    // An incremental read carries only stamp events — stampless harvested ids belong to the full
    // null-cursor rebuild, never the orchestration tail. Excluding them here also closes the
    // degenerate stampless-cursor bootstrap (a zero-stamp-event workspace) where a raw-greater
    // stampless id could otherwise leak in once.
    events = events.filter(
      (e) => parseIdStampUtc(e.frontmatter.id) !== null && orderKey(e.frontmatter.id) > cur,
    );
  }

  // Advance the cursor by ORDER KEY (so a stampless id never becomes the cursor when any stamp
  // event is present), but return the raw id of that max event.
  let maxKey = cursor ? orderKey(cursor) : "";
  let maxId = cursor;
  for (const e of events) {
    const k = orderKey(e.frontmatter.id);
    if (maxId === null || k > maxKey) {
      maxKey = k;
      maxId = e.frontmatter.id;
    }
  }
  return { cursor: maxId, events };
}

/** A total order over event ids: chronological for stamp ids, with stampless harvested ids
 *  (evt_commit_/evt_adr_/evt_decision_) placed BELOW every stamp id. Raw string compare would do
 *  the opposite — 'evt_commit…' sorts above 'evt_2026…' (0x63 > 0x32) — which would let a harvested
 *  id poison an incremental cursor and drop every newer stamp event. */
function orderKey(id: string): string {
  const d = parseIdStampUtc(id);
  if (!d) return `0_${id}`; // stampless class "0" sorts below the stamp class "1"
  return `1_${stampUtc(d)}_${id}`; // chronological; raw id is the same-second tiebreak
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
