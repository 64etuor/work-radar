import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExecutorUsage,
  readUsageFromStdoutFile,
  USAGE_TAIL_BYTES,
} from "../../src/conductor/usageParse.js";

// ── Fixtures mirror the real CLI stdout shapes (basis: Claude Code headless stream-json output
// contract; codex shapes per the app's src-tauri/src/agent.rs `parse_codex_event` precedent —
// protocol `token_count.info.total_token_usage` events — and the newer `turn.completed` items). ──

const CLAUDE_STREAM = [
  `{"type":"system","subtype":"init","cwd":"/wt","session_id":"s1","tools":["Bash"]}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input_tokens":2,"output_tokens":3}},"session_id":"s1"}`,
  `{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"num_turns":2,"result":"done","session_id":"s1","total_cost_usd":0.0123,"usage":{"input_tokens":1500,"cache_creation_input_tokens":900,"cache_read_input_tokens":4000,"output_tokens":250}}`,
].join("\n");

const CODEX_PROTOCOL = [
  `{"id":"0","msg":{"type":"task_started"}}`,
  `{"id":"1","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5104,"cached_input_tokens":4480,"output_tokens":210,"reasoning_output_tokens":128,"total_tokens":5314},"last_token_usage":{"input_tokens":600,"output_tokens":80,"total_tokens":680},"model_context_window":272000}}}`,
  `{"id":"2","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7000,"cached_input_tokens":5000,"output_tokens":400,"reasoning_output_tokens":150,"total_tokens":7400},"last_token_usage":{"input_tokens":1896,"output_tokens":190,"total_tokens":2086}}}}`,
  `{"id":"3","msg":{"type":"agent_message","message":"done"}}`,
].join("\n");

const CODEX_TURNS = [
  `{"type":"thread.started","thread_id":"t1"}`,
  `{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}`,
  `{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":900,"output_tokens":50}}`,
].join("\n");

describe("parseExecutorUsage — claude stream-json (P4b)", () => {
  it("reads the result event: tokens = input+output, costUsd = total_cost_usd", () => {
    expect(parseExecutorUsage(CLAUDE_STREAM, "claude")).toEqual({
      tokens: 1750, // 1500 + 250 — cache tokens deliberately excluded (stated contract)
      costUsd: 0.0123,
    });
  });

  it("ignores non-result lines and survives interleaved garbage", () => {
    const noisy = `not json at all\n${CLAUDE_STREAM}\n{"type":"result" BROKEN\n`;
    expect(parseExecutorUsage(noisy, "claude")).toEqual({ tokens: 1750, costUsd: 0.0123 });
  });

  it("plain -p text output (no JSONL) ⇒ null (usage stays unknown)", () => {
    expect(parseExecutorUsage("I finished the task.\nAll tests pass.\n", "claude")).toBeNull();
  });
});

describe("parseExecutorUsage — codex --json (P4b)", () => {
  it("protocol token_count events: the LAST cumulative total_token_usage.total_tokens wins", () => {
    expect(parseExecutorUsage(CODEX_PROTOCOL, "codex")).toEqual({ tokens: 7400 });
  });

  it("turn.completed items: per-turn input+output summed across turns", () => {
    expect(parseExecutorUsage(CODEX_TURNS, "codex")).toEqual({ tokens: 25935 }); // 24885 + 1050
  });

  it("a cumulative total wins over a turn sum when both shapes appear", () => {
    const mixed = `${CODEX_TURNS}\n{"id":"9","msg":{"type":"token_count","info":{"total_token_usage":{"total_tokens":31000}}}}`;
    expect(parseExecutorUsage(mixed, "codex")).toEqual({ tokens: 31000 });
  });

  it("garbage / human-readable / empty output ⇒ null (fail-soft to unknown)", () => {
    expect(parseExecutorUsage("tokens were definitely used, trust me\n", "codex")).toBeNull();
    expect(parseExecutorUsage("", "codex")).toBeNull();
    expect(parseExecutorUsage(`{"type":"turn.completed","usage":{"input_tokens":"NaN"}}`, "codex")).toBeNull();
  });
});

describe("readUsageFromStdoutFile — bounded, never-throwing file read", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "boule-usage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses a captured stdout file", async () => {
    const p = join(dir, "out.txt");
    await writeFile(p, CLAUDE_STREAM);
    expect(await readUsageFromStdoutFile(p, "claude")).toEqual({ tokens: 1750, costUsd: 0.0123 });
  });

  it("missing file ⇒ null (the record proceeds with usage unknown)", async () => {
    expect(await readUsageFromStdoutFile(join(dir, "absent.txt"), "claude")).toBeNull();
  });

  it("reads only the bounded tail of a huge file — the usage event at the END still parses", async () => {
    const p = join(dir, "huge.txt");
    const filler = `${JSON.stringify({ type: "assistant", message: { content: "x".repeat(500) } })}\n`;
    const huge = filler.repeat(Math.ceil((USAGE_TAIL_BYTES * 2) / filler.length)) + CLAUDE_STREAM;
    await writeFile(p, huge);
    expect(await readUsageFromStdoutFile(p, "claude")).toEqual({ tokens: 1750, costUsd: 0.0123 });
  });

  it("empty file / garbage file ⇒ null", async () => {
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "");
    expect(await readUsageFromStdoutFile(empty, "codex")).toBeNull();
    const garbage = join(dir, "garbage.txt");
    await writeFile(garbage, "\x01\x02 binary-ish noise \xff");
    expect(await readUsageFromStdoutFile(garbage, "codex")).toBeNull();
  });
});
