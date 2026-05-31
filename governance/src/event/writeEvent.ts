import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stampUtc } from "./id.ts";
import { serializeEvent, type GovEvent } from "./event.ts";

/** Append-only write: events/YYYY-MM-DD/HH-MM-SS_<type>.md. Immutable (wx). */
export async function writeEvent(workspaceDir: string, evt: GovEvent, now: Date): Promise<string> {
  const s = stampUtc(now);            // YYYYMMDD_HHMMSS
  const day = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const hms = `${s.slice(9, 11)}-${s.slice(11, 13)}-${s.slice(13, 15)}`;
  const dir = join(workspaceDir, "events", day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${hms}_${evt.frontmatter.type}.md`);
  await writeFile(file, serializeEvent(evt), { flag: "wx" }); // wx: fail if exists → immutable
  return file;
}
