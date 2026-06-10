import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256hex } from "../event/id.ts";

export type PersistOutcome = "written" | "skipped";

export interface PersistedProposal {
  id: string; // mep_<sha8(markdown)>
  path: string; // absolute file path under meta/proposals/
  outcome: PersistOutcome;
}

/** Content-addressed id for a meta proposal draft: identical drafts collapse to one file. */
export function proposalId(markdown: string): string {
  return `mep_${sha256hex(markdown).slice(0, 8)}`;
}

/** Persist a Meta Observer principle-proposal DRAFT under meta/proposals/ so it survives
 *  the MCP response (previously the draft was render-only and evaporated with the reply).
 *  PROPOSE-ONLY stays intact: this writes a reviewable file for a human to turn into an
 *  ADR/decision-rails PR — it never touches decision rails, principles, or events.
 *  Idempotent via content-addressed filename. */
export async function persistMetaProposal(
  workspaceDir: string,
  markdown: string,
): Promise<PersistedProposal> {
  const id = proposalId(markdown);
  const dir = join(workspaceDir, "meta", "proposals");
  const path = join(dir, `${id}.md`);
  await mkdir(dir, { recursive: true });
  try {
    if ((await readFile(path, "utf8")) === markdown) return { id, path, outcome: "skipped" };
  } catch {
    // missing → fall through to write
  }
  await writeFile(path, markdown, "utf8");
  return { id, path, outcome: "written" };
}
