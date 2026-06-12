import { open as fsOpen } from "node:fs/promises";
import type { ExecutorKind } from "./envelope.ts";

// P4(b) — executor stdout usage parsing (master plan 2026-06-12 §2-R6). The wrapper tail captures
// the executor's stdout to a temp file (tee — the pane stays visible) and `record-attempt
// --usage-stdout-file` parses token usage out of it, so attempts stop being usage:"unknown"
// (which budget reconstruction must treat as reserved-max). STRICTLY fail-soft: a missing file,
// unreadable bytes, or an unrecognized shape leaves usage unknown — parsing NEVER fails the
// record and never throws past its boundary (observability, not a gate).
//
// Recognized shapes (fixture basis):
//  - claude `-p --output-format stream-json --verbose`: JSONL whose final `{"type":"result",…}`
//    event carries `usage:{input_tokens,output_tokens,…}` + `total_cost_usd` (Claude Code
//    headless-mode output contract; the repo's liveReviewer/evaluateLive already treat `claude -p`
//    as the one-shot CLI). tokens = input_tokens + output_tokens (cache tokens excluded — the
//    master plan's stated contract); costUsd = total_cost_usd when numeric.
//  - codex `exec --json`: JSONL in two known generations, both already parsed by the app's
//    src-tauri/src/agent.rs precedent (nested `total_token_usage`/`token_count` key search):
//      (1) protocol events `{"msg":{"type":"token_count","info":{"total_token_usage":
//          {"total_tokens":N,…}}}}` — CUMULATIVE; the LAST one seen wins.
//      (2) experimental items `{"type":"turn.completed","usage":{"input_tokens":N,
//          "cached_input_tokens":N,"output_tokens":N}}` — PER-TURN; summed (input+output;
//          cached_input is a subset detail, not additional spend).
//    A cumulative total, when present, wins over the turn sum (it is authoritative).

export interface ParsedUsage {
  tokens?: number;
  costUsd?: number;
}

/** Bounded read: only the final 256KB of the captured stdout is scanned. Usage events are
 *  emitted at the END of both CLIs' streams, so the tail always contains them; a runaway
 *  multi-GB log can never balloon the record step (INVARIANT #5). */
export const USAGE_TAIL_BYTES = 256 * 1024;

function safeJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Depth-limited search for a `total_token_usage.total_tokens` number anywhere in the event
 *  (protocol shape nests it under `msg.info`; session files under `payload.info`). Mirrors the
 *  app's agent.rs nested key search, bounded so a hostile deep object cannot recurse away. */
function findCumulativeTotalTokens(value: unknown, depth = 0): number | null {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const ttu = rec.total_token_usage;
  if (ttu && typeof ttu === "object" && !Array.isArray(ttu)) {
    const total = nonnegativeNumber((ttu as Record<string, unknown>).total_tokens);
    if (total !== null) return total;
  }
  for (const key of Object.keys(rec)) {
    const found = findCumulativeTotalTokens(rec[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function parseClaudeUsage(stdout: string): ParsedUsage | null {
  let result: ParsedUsage | null = null;
  for (const line of stdout.split("\n")) {
    const event = safeJsonLine(line);
    if (!event || event.type !== "result") continue;
    const usage =
      event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)
        ? (event.usage as Record<string, unknown>)
        : undefined;
    const input = nonnegativeNumber(usage?.input_tokens);
    const output = nonnegativeNumber(usage?.output_tokens);
    const cost = nonnegativeNumber(event.total_cost_usd);
    if (input === null && output === null && cost === null) continue;
    const next: ParsedUsage = {};
    if (input !== null || output !== null) next.tokens = (input ?? 0) + (output ?? 0);
    if (cost !== null) next.costUsd = cost;
    result = next; // a later result event (shouldn't happen, but) wins
  }
  return result;
}

function parseCodexUsage(stdout: string): ParsedUsage | null {
  let cumulative: number | null = null;
  let turnSum = 0;
  let sawTurn = false;
  for (const line of stdout.split("\n")) {
    const event = safeJsonLine(line);
    if (!event) continue;
    const total = findCumulativeTotalTokens(event);
    if (total !== null) {
      cumulative = total; // cumulative semantics — last wins
      continue;
    }
    if (event.type !== "turn.completed") continue;
    const usage =
      event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)
        ? (event.usage as Record<string, unknown>)
        : undefined;
    const input = nonnegativeNumber(usage?.input_tokens);
    const output = nonnegativeNumber(usage?.output_tokens);
    if (input === null && output === null) continue;
    turnSum += (input ?? 0) + (output ?? 0);
    sawTurn = true;
  }
  if (cumulative !== null) return { tokens: cumulative };
  if (sawTurn) return { tokens: turnSum };
  return null;
}

/** Parse token usage from a captured executor stdout. Returns null (⇒ usage stays "unknown")
 *  for anything unrecognized — never throws. */
export function parseExecutorUsage(stdout: string, executor: ExecutorKind): ParsedUsage | null {
  try {
    if (executor === "claude") return parseClaudeUsage(stdout);
    if (executor === "codex") return parseCodexUsage(stdout);
    return null;
  } catch {
    return null; // defense in depth — a parser bug must not fail the record
  }
}

/** Read the BOUNDED tail of a captured-stdout file and parse usage from it. Every failure mode
 *  (missing file, IO error, partial line, unrecognized shape) returns null — record-attempt then
 *  records usage:"unknown" exactly as before this feature existed. */
export async function readUsageFromStdoutFile(
  path: string,
  executor: ExecutorKind,
  openFile: typeof fsOpen = fsOpen,
): Promise<ParsedUsage | null> {
  try {
    const fh = await openFile(path, "r");
    try {
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - USAGE_TAIL_BYTES);
      const length = size - start;
      if (length <= 0) return null;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      let text = buf.toString("utf8");
      // A mid-file start lands inside a line — drop the partial first line so JSON.parse sees
      // whole records only (when no newline exists the whole tail is one partial line ⇒ "").
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return parseExecutorUsage(text, executor);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
