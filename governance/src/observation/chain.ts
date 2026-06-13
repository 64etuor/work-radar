/** Shared dep-wiring for the observation chain stages (harvest → detect → hypothesis-test →
 *  meta-observe → archive-prune). Both `cmdHousekeep` (CLI) and the individual MCP tools
 *  (harvest / detect / run_hypothesis_tester / meta_observe / archive_prune) call these
 *  runner functions — this module is dep-wiring dedup only. Each stage retains its own
 *  single-stage MCP semantics (they call the individual runner, not `runObservationChain`).
 *
 *  All stage results are plain data (no side effects beyond the workspace write-seams they
 *  already inject). The workspace path + per-stage config are the only coupling between stages.
 */

import { harvest, makeWriteOne } from "../harvest/harvest.ts";
import { realGitLog } from "../harvest/gitLog.ts";
import { buildIndex, nodeIndexFs } from "../index/build.ts";
import type { DecisionRow } from "../index/types.ts";
import type { HarvestSummary } from "../harvest/harvest.ts";
import { runDetect } from "../patterns/detect.ts";
import { makeWritePattern } from "../patterns/write.ts";
import { loadCuratedKeys } from "../patterns/read.ts";
import { parsePatternConfig } from "../mcp/config.ts";
import {
  listHypotheses,
  readSupportedPatterns,
  readTestingHypotheses,
  runHypothesisTester,
  type HypothesisTesterSummary,
} from "../hypotheses/tester.ts";
import { makeWriteHypothesis } from "../hypotheses/write.ts";
import { buildMetaObservation } from "../meta/observer.ts";
import { persistMetaProposal } from "../meta/persist.ts";
import {
  runArchivePruner,
  runPatternPruner,
  type ArchivePrunerSummary,
} from "../archive/pruner.ts";
import { readAllEvents } from "../decision/readEvents.ts";

// ── Re-exported result types (callers use these shapes) ────────────────────────

export type { HarvestSummary };
export type { HypothesisTesterSummary };
export type { ArchivePrunerSummary };

export interface DetectSummary {
  written: number;
  skipped: number;
  candidates: number;
  droppedNoScope: number;
  scopesConsidered: number;
}

export interface MetaObserveResult {
  hasProposal: boolean;
  markdown?: string;
  /** Diagnostic for the no-proposal path (e.g. no verified hypotheses). */
  reason?: string;
  persisted: { id: string; outcome: string } | null;
}

export interface ChainArchiveSummary {
  hypotheses: ArchivePrunerSummary;
  patterns: ArchivePrunerSummary;
}

// ── Per-stage wired runners ────────────────────────────────────────────────────

/** Stage 1: harvest git log + decisions into L0 events (idempotent, content-addressed). */
export async function runHarvest(repoRoot: string, workspace: string): Promise<HarvestSummary> {
  return harvest({
    gitLog: () => realGitLog(repoRoot),
    loadDecisionRows: async () =>
      (await buildIndex(repoRoot, nodeIndexFs)).decisions as readonly DecisionRow[],
    writeOne: makeWriteOne(workspace),
  });
}

/** Stage 2: scan L0 corpus and emit candidate patterns. */
export async function runDetectStage(workspace: string): Promise<DetectSummary> {
  const patternCfg = parsePatternConfig(process.env);
  return runDetect({
    readEvents: () => readAllEvents(workspace),
    loadCuratedKeys: () => loadCuratedKeys(workspace),
    writePattern: makeWritePattern(workspace, { evidenceCap: patternCfg.evidenceCap }),
    options: patternCfg,
  });
}

/** Stage 3: evaluate testing hypotheses against current L0 corpus. */
export async function runHypothesisTest(
  workspace: string,
  now: Date,
): Promise<HypothesisTesterSummary> {
  return runHypothesisTester({
    readEvents: () => readAllEvents(workspace),
    readPatterns: () => readSupportedPatterns(workspace),
    readTestingHypotheses: () => readTestingHypotheses(workspace),
    writeHypothesis: makeWriteHypothesis(workspace),
    now: () => now,
  });
}

/** Stage 4: build meta-observation and persist a proposal draft if warranted (propose-only). */
export async function runMetaObserve(workspace: string): Promise<MetaObserveResult> {
  const result = buildMetaObservation({ hypotheses: await listHypotheses(workspace) });
  if (!result.hasProposal) {
    return { hasProposal: false, reason: result.reason, persisted: null };
  }
  const persisted = await persistMetaProposal(workspace, result.markdown);
  return { hasProposal: true, markdown: result.markdown, persisted };
}

/** Stage 5: archive terminal/expired hypotheses + stale candidate patterns. */
export async function runArchivePrune(workspace: string, now: Date): Promise<ChainArchiveSummary> {
  const [hypotheses, patterns] = await Promise.all([
    runArchivePruner(workspace, now.toISOString().slice(0, 10)),
    runPatternPruner(workspace, now),
  ]);
  return { hypotheses, patterns };
}
