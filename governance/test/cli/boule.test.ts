import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  cmdInit,
  cmdSet,
  cmdStatus,
  cmdReportExit,
  cmdRecordAttempt,
} from "../../src/cli/boule.js";
import { readConfig } from "../../src/repo/configIo.js";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boule-cli-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("parses command + --key value / --key=value / boolean --flag", () => {
    const a = parseArgs(["init", "--repo", "/p", "--kind=work", "--overwrite"]);
    expect(a.cmd).toBe("init");
    expect(a.flags.repo).toBe("/p");
    expect(a.flags.kind).toBe("work");
    expect(a.flags.overwrite).toBe(true);
  });
});

describe("cmdInit / cmdSet / cmdStatus", () => {
  it("init requires --kind and scaffolds the repo", async () => {
    await expect(cmdInit({ repo })).rejects.toThrow(/kind/);
    const msg = await cmdInit({ repo, kind: "personal", "project-name": "Demo" });
    expect(msg).toMatch(/initialized/);
    expect((await readConfig(repo)).kind).toBe("personal");
  });

  it("set mutates kind + overrides and re-validates", async () => {
    await cmdInit({ repo, kind: "personal" });
    await cmdSet({ repo, kind: "work", "autonomy-level": "full", "review-quorum": "3" });
    const cfg = await readConfig(repo);
    expect(cfg.kind).toBe("work");
    expect(cfg.overrides?.autonomyLevel).toBe("full");
    expect(cfg.overrides?.reviewQuorum).toBe(3);
  });

  it("set rejects an invalid autonomy-level", async () => {
    await cmdInit({ repo, kind: "work" });
    await expect(cmdSet({ repo, "autonomy-level": "yolo" })).rejects.toThrow(/autonomy-level/);
  });

  it("status reports the resolved policy from config", async () => {
    await cmdInit({ repo, kind: "personal" });
    const out = await cmdStatus({ repo });
    expect(out).toMatch(/policy source: config/);
    expect(out).toMatch(/kind: personal/);
    expect(out).toMatch(/autoMode: type2/);
  });

  it("status on an uninitialized repo shows the strict fallback", async () => {
    const out = await cmdStatus({ repo });
    expect(out).toMatch(/policy source: fallback/);
    expect(out).toMatch(/kind: work/);
  });

  it("requires --repo", async () => {
    await expect(cmdStatus({})).rejects.toThrow(/--repo/);
  });
});

describe("cmdReportExit — codex completion-wrapper hint", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
  // `repo` doubles as the governance workspace here (events land in <repo>/events) — fine, it's a
  // fresh temp dir per test. Mirrors the real flow: accept a plan, conduct one step ⇒ an active task.
  async function activeTask(ws: string): Promise<string> {
    const { planId } = await proposePlan(ws, { intent: "x", steps: ["step a"] }, at(0), 0.1);
    await acceptPlan(ws, { planId }, at(1), 0.2);
    const r = await conductPlan(ws, { planId }, { adapter: stubAdapter }, at(10), 0.3);
    return r.advanced!.taskId;
  }

  it("requires --workspace and --task", async () => {
    await expect(cmdReportExit({ task: "t" })).rejects.toThrow(/--workspace/);
    await expect(cmdReportExit({ workspace: repo })).rejects.toThrow(/--task/);
  });

  it("writes executor_reported_done, NOT task_completed, on clean codex exit", async () => {
    const taskId = await activeTask(repo);
    const out = await cmdReportExit({ workspace: repo, task: taskId });
    expect(out).toMatch(/^reported: /);
    const events = await readAllEvents(repo);
    const hints = events.filter(
      (e) => e.frontmatter.type === "executor_reported_done" && e.frontmatter.related_to?.includes(taskId),
    );
    const completions = events.filter(
      (e) => e.frontmatter.type === "task_completed" && e.frontmatter.related_to?.includes(taskId),
    );
    expect(hints).toHaveLength(1);
    expect(completions).toHaveLength(0);
  });
});

describe("cmdRecordAttempt — supervised attempt evidence hint", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));

  async function activeTask(ws: string): Promise<string> {
    const { planId } = await proposePlan(ws, { intent: "x", steps: ["step a"] }, at(0), 0.1);
    await acceptPlan(ws, { planId }, at(1), 0.2);
    const r = await conductPlan(ws, { planId }, { adapter: stubAdapter }, at(10), 0.3);
    return r.advanced!.taskId;
  }

  it("requires attempt evidence fields", async () => {
    await expect(cmdRecordAttempt({ task: "t" })).rejects.toThrow(/--workspace/);
    await expect(cmdRecordAttempt({ workspace: repo })).rejects.toThrow(/--task/);
    await expect(cmdRecordAttempt({ workspace: repo, task: "t" })).rejects.toThrow(/--attempt/);
  });

  it("writes executor_attempt_finished with classified outcome and no verdict fields", async () => {
    const taskId = await activeTask(repo);
    const out = await cmdRecordAttempt({
      workspace: repo,
      task: taskId,
      attempt: "0",
      "exit-code": "1",
      launched: "true",
      "worktree-dirty": "true",
      "stderr-digest": "HTTP 429 quota exceeded",
    });
    expect(out).toMatch(/^recorded-attempt: /);

    const events = await readAllEvents(repo);
    const finished = events.find(
      (e) => e.frontmatter.type === "executor_attempt_finished" && e.frontmatter.related_to?.includes(taskId),
    );
    expect(finished).toBeDefined();
    const body = JSON.parse(finished!.body);
    expect(body).toEqual({
      attemptIndex: 0,
      exitCode: 1,
      launched: true,
      worktreeDirty: true,
      stderrDigest: "HTTP 429 quota exceeded",
      outcomeClass: "token_exhausted",
      usage: "unknown",
    });
    expect(body).not.toHaveProperty("verdict");
    expect(body).not.toHaveProperty("completed");
    expect(events.some((e) => e.frontmatter.type === "task_completed")).toBe(false);
  });
});
