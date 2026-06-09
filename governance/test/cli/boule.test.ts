import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  cmdInit,
  cmdSet,
  cmdStatus,
  cmdSnapshot,
  cmdReportExit,
  cmdRecordAttempt,
} from "../../src/cli/boule.js";
import { readConfig } from "../../src/repo/configIo.js";
import { boulePaths } from "../../src/repo/paths.js";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import type { GovEvent } from "../../src/event/event.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boule-cli-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function rawConfig(): Promise<string> {
  return await readFile(boulePaths(repo).config, "utf8");
}

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

  it("set --backends round-trips validated JSON into overrides.backends", async () => {
    await cmdInit({ repo, kind: "work" });
    const backends = {
      executor: { chain: [{ provider: "codex", model: "gpt-5-codex-small" }] },
      reviewers: [{ chain: [{ provider: "claude", model: "claude-sonnet-4-5" }] }],
      evaluator: { chain: [{ provider: "deterministic" }] },
    };

    await cmdSet({ repo, backends: JSON.stringify(backends) });

    expect((await readConfig(repo)).overrides?.backends).toEqual(backends);
  });

  it("set --backends invalid JSON throws and leaves config unchanged", async () => {
    await cmdInit({ repo, kind: "work" });
    await cmdSet({ repo, "autonomy-level": "dispatch", "review-quorum": "2" });
    const before = await rawConfig();

    await expect(cmdSet({ repo, backends: '{"executor":' })).rejects.toThrow(/--backends must be valid JSON/);

    expect(await rawConfig()).toBe(before);
  });

  it("set --backends schema-invalid JSON throws and leaves config unchanged", async () => {
    await cmdInit({ repo, kind: "work" });
    await cmdSet({ repo, "review-quorum": "2" });
    const before = await rawConfig();

    await expect(cmdSet({ repo, backends: JSON.stringify({ executor: { chain: [] } }) })).rejects.toThrow();

    expect(await rawConfig()).toBe(before);
  });

  it("set --backends rejects deterministic executor chains before writing", async () => {
    await cmdInit({ repo, kind: "work" });
    await cmdSet({ repo, "review-quorum": "2" });
    const before = await rawConfig();

    await expect(
      cmdSet({
        repo,
        backends: JSON.stringify({ executor: { chain: [{ provider: "deterministic" }] } }),
      }),
    ).rejects.toThrow(/deterministic.*executor/);

    expect(await rawConfig()).toBe(before);
  });

  it("set --routing and --price-table round-trip valid JSON", async () => {
    await cmdInit({ repo, kind: "work" });
    const routing = {
      executor: {
        trivial: { provider: "codex", model: "gpt-5-codex-small" },
        hard: { provider: "claude", model: "claude-opus-4-1" },
      },
    };
    const priceTable = {
      codex: {
        "gpt-5-codex-small": { estimatedTokens: 2000, costPerStepUsd: 0.01 },
      },
      claude: {
        "claude-opus-4-1": { estimatedTokens: 40000, costPerStepUsd: 1.2 },
      },
    };

    await cmdSet({
      repo,
      routing: JSON.stringify(routing),
      "price-table": JSON.stringify(priceTable),
    });

    const cfg = await readConfig(repo);
    expect(cfg.overrides?.routing).toEqual(routing);
    expect(cfg.overrides?.priceTable).toEqual(priceTable);
  });

  it("set --routing and --price-table invalid input leaves config unchanged", async () => {
    await cmdInit({ repo, kind: "work" });
    await cmdSet({ repo, "autonomy-level": "dispatch" });
    const before = await rawConfig();

    await expect(
      cmdSet({
        repo,
        routing: JSON.stringify({ executor: { standard: { provider: "deterministic" } } }),
      }),
    ).rejects.toThrow(/deterministic.*executor/);
    expect(await rawConfig()).toBe(before);

    await expect(
      cmdSet({
        repo,
        "price-table": JSON.stringify({ codex: { default: { estimatedTokens: 1 } } }),
      }),
    ).rejects.toThrow();
    expect(await rawConfig()).toBe(before);
  });

  it("set --backends null or empty object clears overrides.backends", async () => {
    await cmdInit({ repo, kind: "work" });
    const backends = {
      executor: { chain: [{ provider: "codex", model: "gpt-5-codex-small" }] },
    };
    await cmdSet({ repo, backends: JSON.stringify(backends), "review-quorum": "2" });

    await cmdSet({ repo, backends: "null" });
    expect((await readConfig(repo)).overrides).toEqual({ reviewQuorum: 2 });

    await cmdSet({ repo, backends: JSON.stringify(backends) });
    await cmdSet({ repo, backends: "{}" });
    expect((await readConfig(repo)).overrides).toEqual({ reviewQuorum: 2 });
  });

  it("set omitting backend flags preserves existing overrides", async () => {
    await cmdInit({ repo, kind: "work" });
    const backends = {
      executor: { chain: [{ provider: "codex", model: "gpt-5-codex-small" }] },
    };
    const routing = { executor: { trivial: { provider: "codex", model: "gpt-5-codex-small" } } };
    const priceTable = {
      codex: {
        "gpt-5-codex-small": { estimatedTokens: 2000, costPerStepUsd: 0.01 },
      },
    };
    await cmdSet({
      repo,
      backends: JSON.stringify(backends),
      routing: JSON.stringify(routing),
      "price-table": JSON.stringify(priceTable),
      "review-quorum": "2",
    });

    await cmdSet({ repo, "autonomy-level": "full" });

    expect((await readConfig(repo)).overrides).toEqual({
      autonomyLevel: "full",
      reviewQuorum: 2,
      backends,
      routing,
      priceTable,
    });
  });

  it("status reports the resolved policy from config", async () => {
    await cmdInit({ repo, kind: "personal" });
    const out = await cmdStatus({ repo });
    expect(out).toMatch(/policy source: config/);
    expect(out).toMatch(/kind: personal/);
    expect(out).toMatch(/autoMode: type2/);
  });

  it("status shows backends/routing/priceTable presence", async () => {
    await cmdInit({ repo, kind: "work" });
    await cmdSet({
      repo,
      backends: JSON.stringify({
        executor: { chain: [{ provider: "codex", model: "gpt-5-codex-small" }] },
        reviewers: [{ chain: [{ provider: "claude", model: "claude-sonnet-4-5" }] }],
      }),
      routing: JSON.stringify({
        executor: { trivial: { provider: "codex", model: "gpt-5-codex-small" } },
      }),
      "price-table": JSON.stringify({
        codex: {
          "gpt-5-codex-small": { estimatedTokens: 2000, costPerStepUsd: 0.01 },
        },
      }),
    });

    const out = await cmdStatus({ repo });
    expect(out).toMatch(/backends: SET \(executor chain 1, reviewers 1 \[1\], evaluator unset\)/);
    expect(out).toMatch(/routing: SET \(executor difficulties: trivial\)/);
    expect(out).toMatch(/priceTable: SET \(providers 1\)/);
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

describe("cmdSnapshot", () => {
  it("folds <repo>/.boule/workspace/events and writes no events", async () => {
    const workspace = boulePaths(repo).workspace;
    const event: GovEvent = {
      frontmatter: {
        id: "evt_20260608_101500_0001",
        type: "task_created",
        source: "system",
        actor: "test",
        tags: [],
      },
      body: "Snapshot task",
    };
    await writeEvent(workspace, event, new Date(Date.UTC(2026, 5, 8, 10, 15, 0)));
    const before = (await readAllEvents(workspace)).map((e) => e.frontmatter.id);

    const out = await cmdSnapshot({ repo, json: true });
    const after = (await readAllEvents(workspace)).map((e) => e.frontmatter.id);
    const snap = JSON.parse(out);

    expect(after).toEqual(before);
    expect(snap.generatedAt).toBe("2026-06-08T10:15:00Z");
    expect(snap.tasks).toEqual([
      { taskId: "evt_20260608_101500_0001", title: "Snapshot task", phase: "ready" },
    ]);
    expect(snap.orchestrator.tasks).toEqual([
      { taskId: "evt_20260608_101500_0001", phase: "ready", hasOpenBlock: false },
    ]);
  });

  it("returns an empty snapshot for a repo with no event directory", async () => {
    expect(JSON.parse(await cmdSnapshot({ repo, json: true }))).toEqual({
      generatedAt: null,
      tasks: [],
      plans: [],
      specs: [],
      sessions: [],
      handoffs: [],
      orchestrator: { tasks: [], plans: [], sessions: [] },
    });
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

  it("optionally records trusted numeric usage without parsing agent output", async () => {
    const taskId = await activeTask(repo);
    await cmdRecordAttempt({
      workspace: repo,
      task: taskId,
      attempt: "0",
      "exit-code": "0",
      launched: "true",
      "worktree-dirty": "false",
      "usage-tokens": "3000",
      "usage-cost": "0.09",
    });

    const finished = (await readAllEvents(repo)).find(
      (e) => e.frontmatter.type === "executor_attempt_finished" && e.frontmatter.related_to?.includes(taskId),
    );
    expect(JSON.parse(finished!.body)).toMatchObject({
      attemptIndex: 0,
      usage: { tokens: 3000, costUsd: 0.09 },
    });
  });
});
