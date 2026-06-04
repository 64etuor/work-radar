import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stampUtc } from "./id.ts";
import { serializeEvent, type GovEvent } from "./event.ts";

export interface WriteEventOptions {
  /** Filename suffix encoding source identity (sha7 / adr-id / hash7). */
  disambiguator?: string;
  /** Day-dir override (e.g. "undated"); default = YYYY-MM-DD derived from `now`. */
  dayBucket?: string;
}

/** Append-only write: events/<day>/HH-MM-SS_<type>[_<disambiguator>].md. Immutable (wx). */
export async function writeEvent(
  workspaceDir: string,
  evt: GovEvent,
  now: Date,
  opts: WriteEventOptions = {},
): Promise<string> {
  const s = stampUtc(now); // YYYYMMDD_HHMMSS
  const day = opts.dayBucket ?? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const hms = `${s.slice(9, 11)}-${s.slice(11, 13)}-${s.slice(13, 15)}`;
  const suffix = opts.disambiguator ? `_${opts.disambiguator}` : "";
  const dir = join(workspaceDir, "events", day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${hms}_${evt.frontmatter.type}${suffix}.md`);
  await writeFile(file, serializeEvent(evt), { flag: "wx" }); // wx: fail if exists → immutable/idempotent
  return file;
}
