import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../event/id.js";
import { writeEvent } from "../event/writeEvent.js";
import type { GovEvent } from "../event/event.js";

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
  let count = 0;
  let days: string[] = [];
  try { days = await readdir(eventsDir); } catch { return { eventCount: 0 }; }
  for (const day of days) {
    if (day.startsWith(".")) continue;
    let files: string[] = [];
    try { files = await readdir(join(eventsDir, day)); } catch { continue; }
    count += files.filter((f) => f.endsWith(".md")).length;
  }
  return { eventCount: count };
}

export interface ObservationsResult { patterns: string[]; }

/** /observations — active patterns. P1: empty (Pattern Detector lands in P3). */
export async function observations(_workspaceDir: string): Promise<ObservationsResult> {
  return { patterns: [] };
}
