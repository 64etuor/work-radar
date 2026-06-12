import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { listPatternsIn, type PatternView } from "../patterns/read.ts";

export interface CreateTaskInput { description: string; }
export interface CreateTaskResult { id: string; path: string; }

/** /task — write a task_created L0 event. */
export async function createTask(
  workspaceDir: string, input: CreateTaskInput, now: Date, rand: number,
): Promise<CreateTaskResult> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "task_created",
      source: "hermes",
      actor: "user",
      tags: ["task"],
    },
    body: input.description,
  };
  const path = await writeEvent(workspaceDir, evt, now);
  return { id: evt.frontmatter.id, path };
}

export interface StatusResult { eventCount: number; }

/** /status — count L0 events across all dated dirs. */
export async function status(workspaceDir: string): Promise<StatusResult> {
  const eventsDir = join(workspaceDir, "events");
  let days: string[] = [];
  try {
    days = await readdir(eventsDir);
  } catch {
    return { eventCount: 0 };
  }
  const counts = await Promise.all(
    days
      .filter((day) => !day.startsWith("."))
      .map(async (day) => {
        let files: string[] = [];
        try {
          files = await readdir(join(eventsDir, day));
        } catch {
          return 0;
        }
        return files.filter((f) => f.endsWith(".md")).length;
      }),
  );
  return { eventCount: counts.reduce((sum, count) => sum + count, 0) };
}

export interface ObservationsResult { patterns: PatternView[]; }

/** /observations — recently discovered + human-activated patterns (candidates first,
 *  then active; archived patterns are forgotten on purpose). Read-only. */
export async function observations(workspaceDir: string): Promise<ObservationsResult> {
  return { patterns: await listPatternsIn(workspaceDir, ["candidates", "active"]) };
}
