import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdRecordAttempt } from "../../src/cli/boule.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";

// P4b — `record-attempt --usage-stdout-file <path> --executor claude|codex`: the CLI parses the
// wrapper-captured executor stdout into usage tokens/cost. FAIL-SOFT is the contract under test:
// missing/garbage files record usage:"unknown" exactly as before, and the record NEVER fails.

let dir: string; // workspace AND scratch for stdout files
let taskId: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 12, 12, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-recusage-"));
  const { planId } = await proposePlan(dir, { intent: "x", steps: ["step a"] }, at(0), 0.1);
  await acceptPlan(dir, { planId }, at(1), 0.2);
  const r = await conductPlan(dir, { planId }, { adapter: stubAdapter }, at(10), 0.3);
  taskId = r.advanced!.taskId;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseFlags(extra: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  return {
    workspace: dir,
    task: taskId,
    attempt: "0",
    "exit-code": "0",
    launched: "true",
    "worktree-dirty": "false",
    ...extra,
  };
}

async function lastAttemptBody(): Promise<Record<string, unknown>> {
  const all = await readAllEvents(dir);
  const evt = all.filter((e) => e.frontmatter.type === "executor_attempt_finished").at(-1)!;
  return JSON.parse(evt.body) as Record<string, unknown>;
}

const CLAUDE_RESULT = `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.05,"usage":{"input_tokens":100,"output_tokens":25}}\n`;

describe("cmdRecordAttempt --usage-stdout-file (P4b fail-soft usage parse)", () => {
  it("happy path: parses claude stream-json stdout into trusted usage {tokens, costUsd}", async () => {
    const stdoutFile = join(dir, "claude-out.txt");
    await writeFile(stdoutFile, CLAUDE_RESULT);
    const r = await cmdRecordAttempt(
      baseFlags({ "usage-stdout-file": stdoutFile, executor: "claude" }),
    );
    expect(r).toContain("recorded-attempt");
    expect((await lastAttemptBody()).usage).toEqual({ tokens: 125, costUsd: 0.05 });
  });

  it("happy path: parses codex --json protocol stdout into trusted usage {tokens}", async () => {
    const stdoutFile = join(dir, "codex-out.txt");
    await writeFile(
      stdoutFile,
      `{"id":"1","msg":{"type":"token_count","info":{"total_token_usage":{"total_tokens":5314}}}}\n`,
    );
    const r = await cmdRecordAttempt(
      baseFlags({ "usage-stdout-file": stdoutFile, executor: "codex" }),
    );
    expect(r).toContain("recorded-attempt");
    expect((await lastAttemptBody()).usage).toEqual({ tokens: 5314 });
  });

  it("missing file ⇒ usage stays 'unknown' and the record still succeeds (fail-soft)", async () => {
    const r = await cmdRecordAttempt(
      baseFlags({ "usage-stdout-file": join(dir, "vanished.txt"), executor: "claude" }),
    );
    expect(r).toContain("recorded-attempt");
    expect((await lastAttemptBody()).usage).toBe("unknown");
  });

  it("unrecognized stdout shape ⇒ 'unknown', record succeeds", async () => {
    const stdoutFile = join(dir, "plain.txt");
    await writeFile(stdoutFile, "I completed the task. 12345 tokens of pure prose.\n");
    const r = await cmdRecordAttempt(
      baseFlags({ "usage-stdout-file": stdoutFile, executor: "claude" }),
    );
    expect(r).toContain("recorded-attempt");
    expect((await lastAttemptBody()).usage).toBe("unknown");
  });

  it("unknown --executor value ⇒ 'unknown' (degrades, never errors)", async () => {
    const stdoutFile = join(dir, "out.txt");
    await writeFile(stdoutFile, CLAUDE_RESULT);
    const r = await cmdRecordAttempt(
      baseFlags({ "usage-stdout-file": stdoutFile, executor: "gemini" }),
    );
    expect(r).toContain("recorded-attempt");
    expect((await lastAttemptBody()).usage).toBe("unknown");
  });

  it("explicit --usage-tokens/--usage-cost are direct assertions and WIN over the file parse", async () => {
    const stdoutFile = join(dir, "out.txt");
    await writeFile(stdoutFile, CLAUDE_RESULT);
    const r = await cmdRecordAttempt(
      baseFlags({
        "usage-stdout-file": stdoutFile,
        executor: "claude",
        "usage-tokens": "999",
      }),
    );
    expect(r).toContain("recorded-attempt");
    expect((await lastAttemptBody()).usage).toEqual({ tokens: 999 });
  });
});
