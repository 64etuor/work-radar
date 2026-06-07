import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, cmdInit, cmdSet, cmdStatus, cmdCompleteTask } from "../../src/cli/boule.js";
import { readConfig } from "../../src/repo/configIo.js";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { escalate } from "../../src/escalate/escalate.js";
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

describe("cmdCompleteTask — codex completion-wrapper backstop", () => {
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
    await expect(cmdCompleteTask({ task: "t" })).rejects.toThrow(/--workspace/);
    await expect(cmdCompleteTask({ workspace: repo })).rejects.toThrow(/--task/);
  });

  it("completes an active task (writes task_completed) so the loop closes on clean codex exit", async () => {
    const taskId = await activeTask(repo);
    const out = await cmdCompleteTask({ workspace: repo, task: taskId });
    expect(out).toMatch(/^completed: /);
    const done = (await readAllEvents(repo)).filter(
      (e) => e.frontmatter.type === "task_completed" && e.frontmatter.related_to?.includes(taskId),
    );
    expect(done).toHaveLength(1);
  });

  it("REFUSES (writes nothing) when the task has an unresolved decision_blocked (INVARIANT #1-safe)", async () => {
    const taskId = await activeTask(repo);
    // the session escalated → open decision_blocked bound to the task; completing it must be refused
    await escalate(
      repo,
      { question: "fork?", options: [{ label: "a" }, { label: "b" }], relatedTaskId: taskId },
      at(20),
      0.4,
    );
    const before = (await readAllEvents(repo)).length;
    const out = await cmdCompleteTask({ workspace: repo, task: taskId });
    expect(out).toMatch(/^REFUSED: /);
    expect((await readAllEvents(repo)).length).toBe(before); // wrote nothing
  });
});
