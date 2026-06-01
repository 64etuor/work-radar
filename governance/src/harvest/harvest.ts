import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import type { DecisionRow } from "../index/types.ts";
import { parseGitLog } from "./gitLog.ts";
import { commitItem, adrItem, decisionItem, type HarvestItem } from "./sources.ts";

export type WriteOutcome = "written" | "skipped";

export interface HarvestDeps {
  /** Raw `git log` stdout (or throws when git is unavailable). */
  gitLog: () => Promise<string>;
  /** Decision/ADR rows (typically buildIndex(repoRoot, fs).decisions). */
  loadDecisionRows: () => Promise<readonly DecisionRow[]>;
  /** Idempotent writer: "written" on a fresh event, "skipped" if already present. */
  writeOne: (item: HarvestItem) => Promise<WriteOutcome>;
}

export interface HarvestSummary {
  written: number;
  skipped: number;
}

/** Gather all sources → content-addressed items → idempotent writes. Fail-soft per source. */
export async function harvest(deps: HarvestDeps): Promise<HarvestSummary> {
  const items: HarvestItem[] = [];

  try {
    items.push(...parseGitLog(await deps.gitLog()).map(commitItem));
  } catch {
    // git unavailable / not a repo → 0 commit events
  }

  let rows: readonly DecisionRow[] = [];
  try {
    rows = await deps.loadDecisionRows();
  } catch {
    rows = [];
  }
  for (const row of rows) {
    items.push(row.kind === "adr" ? adrItem(row) : decisionItem(row));
  }

  const summary: HarvestSummary = { written: 0, skipped: 0 };
  for (const item of items) {
    const outcome = await deps.writeOne(item);
    if (outcome === "written") summary.written++;
    else summary.skipped++;
  }
  return summary;
}

/** Real idempotent writer over a workspace dir. EEXIST (already harvested) → "skipped". */
export function makeWriteOne(workspaceDir: string): (item: HarvestItem) => Promise<WriteOutcome> {
  return async (item) => {
    const evt: GovEvent = {
      frontmatter: {
        id: item.id,
        type: item.type,
        source: item.source,
        actor: item.actor,
        tags: item.tags,
        ...(item.refs ? { related_to: item.refs } : {}),
      },
      body: item.body,
    };
    try {
      await writeEvent(workspaceDir, evt, item.stampAt, {
        disambiguator: item.disambiguator,
        dayBucket: item.dayBucket,
      });
      return "written";
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return "skipped";
      throw e;
    }
  };
}
