import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan, conductorStatus } from "../../src/conductor/handlers.js";
import { completeTask } from "../../src/task/handlers.js";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption } from "../../src/decision/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import {
  stubAdapter,
  makeLiveAdapter,
  buildSessionCommand,
  parseCmuxRef,
  firstTerminalSurface,
  findGroupRef,
  projectLabelFromRepoRoot,
  type SpawnResultLike,
} from "../../src/conductor/adapter.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const deps = { adapter: stubAdapter };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-cond-h-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setupActivePlan(): Promise<string> {
  const { planId } = await proposePlan(
    dir,
    { intent: "Load X", steps: ["step a", "step b"] },
    at(0),
    0.1,
  );
  await acceptPlan(dir, { planId }, at(1), 0.2);
  return planId;
}
function typesOf(all: GovEvent[]): string[] {
  return all.map((e) => e.frontmatter.type);
}
async function taskIdForStep(all: GovEvent[], text: string): Promise<string> {
  return all.find((e) => e.frontmatter.type === "task_created" && e.body === text)!.frontmatter.id;
}

describe("conductPlan — accept gate (US-001 / done-criteria #1)", () => {
  it("refuses a draft plan and writes NOTHING", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load X", steps: ["a"] }, at(0), 0.1);
    const r = await conductPlan(dir, { planId }, deps, at(10), 0.3);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/active/i);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "step_bound")).toBe(false);
    expect(all.some((e) => e.frontmatter.type === "session_spawned")).toBe(false);
  });

  it("refuses a needs_revision plan", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load X", steps: ["a"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);
    // revise → needs_revision via plan handler
    const { revisePlan } = await import("../../src/plan/handlers.js");
    await revisePlan(dir, { planId, reason: "scope" }, at(2), 0.3);
    const r = await conductPlan(dir, { planId }, deps, at(10), 0.4);
    expect(r.ok).toBe(false);
  });
});

describe("conductPlan — one step per call (done-criteria #2)", () => {
  it("first call mints exactly task_created+step_bound+session_spawned+task_started for step 0, nothing for step 1", async () => {
    const planId = await setupActivePlan();
    const r = await conductPlan(dir, { planId }, deps, at(10), 0.3);
    expect(r.ok).toBe(true);
    expect(r.advanced!.stepIndex).toBe(0);

    const all = await readAllEvents(dir);
    const conductorMinted = all.filter((e) => e.frontmatter.actor === "conductor");
    expect(typesOf(conductorMinted).sort()).toEqual(
      ["session_spawned", "step_bound", "task_created", "task_started"].sort(),
    );
    // exactly ONE task_created (step 0 only) — step 1 not materialized
    expect(all.filter((e) => e.frontmatter.type === "task_created")).toHaveLength(1);

    // distinct chronological ids for the 4 minted events
    const ids = conductorMinted.map((e) => e.frontmatter.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("conductor-minted task uses actor:conductor (NOT user)", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all = await readAllEvents(dir);
    const task = all.find((e) => e.frontmatter.type === "task_created")!;
    expect(task.frontmatter.actor).toBe("conductor");
  });

  it("a second call while step 0 is in-flight (active) advances NOTHING", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const r2 = await conductPlan(dir, { planId }, deps, at(40), 0.4);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/in-flight/i);
    const all = await readAllEvents(dir);
    expect(all.filter((e) => e.frontmatter.type === "task_created")).toHaveLength(1);
  });
});

describe("conductPlan — observe → advance (done-criteria #3)", () => {
  it("after stub task_completed for step 0, the next call materializes step 1 only; cursor 0→1", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all1 = await readAllEvents(dir);
    const t0 = await taskIdForStep(all1, "step a");
    expect((await completeTask(dir, { taskId: t0 }, at(30), 0.4)).ok).toBe(true);

    const st = await conductorStatus(dir, { planId });
    expect(st.cursor).toBe(1);

    const r2 = await conductPlan(dir, { planId }, deps, at(50), 0.5);
    expect(r2.ok).toBe(true);
    expect(r2.advanced!.stepIndex).toBe(1);
    const all2 = await readAllEvents(dir);
    expect(all2.filter((e) => e.frontmatter.type === "task_created")).toHaveLength(2);
  });
});

describe("conductPlan — halt on block (done-criteria #4)", () => {
  it("an open decision_blocked (relatedTaskId) halts; conduct advances nothing; stays halted; unblock advances", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all1 = await readAllEvents(dir);
    const t0 = await taskIdForStep(all1, "step a");

    // the spawned session escalates, binding its task → decision_blocked.related_to ∋ t0
    const esc = await escalate(
      dir,
      {
        question: "fork?",
        options: [{ label: "x" }, { label: "y" }],
        actor: "stub-0",
        relatedTaskId: t0,
      },
      at(20),
      0.4,
    );

    const stHalted = await conductorStatus(dir, { planId });
    expect(stHalted.halted).toBe(true);

    const rHalt = await conductPlan(dir, { planId }, deps, at(40), 0.5);
    expect(rHalt.ok).toBe(false);
    expect(rHalt.reason).toMatch(/halt/i);
    // stays halted across a second call — no timeout/default path
    expect((await conductPlan(dir, { planId }, deps, at(60), 0.6)).ok).toBe(false);

    // a human choose (actor:user) resolves the fork
    const ch = await chooseOption(
      dir,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      at(70),
      0.7,
    );
    expect(ch.ok).toBe(true);

    // still in-flight (task active, not completed) — conduct still waits, NOT advances a new step
    const stCleared = await conductorStatus(dir, { planId });
    expect(stCleared.halted).toBe(false);

    // complete step 0, THEN conduct advances to step 1
    expect((await completeTask(dir, { taskId: t0 }, at(80), 0.8)).ok).toBe(true);
    const rAdv = await conductPlan(dir, { planId }, deps, at(90), 0.9);
    expect(rAdv.ok).toBe(true);
    expect(rAdv.advanced!.stepIndex).toBe(1);
  });
});

describe("makeLiveAdapter — git + cmux command SEQUENCE (US-005, injected fake spawn, no real processes)", () => {
  it("createWorktree + spawnSession issue git worktree add + cmux new-workspace --command + cmux tree in order", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      // Real cmux contract: `new-workspace` prints `OK workspace:N` on stdout (the legacy-alias
      // notice goes to stderr); the workspace's terminal surface is resolved from `tree --json`.
      if (cmd === "cmux" && args[0] === "new-workspace")
        return { status: 0, stdout: "OK workspace:7\n", stderr: "" };
      if (cmd === "cmux" && args[0] === "tree")
        return {
          status: 0,
          stdout: JSON.stringify({
            windows: [
              {
                workspaces: [
                  { ref: "workspace:7", panes: [{ surfaces: [{ ref: "surface:42", type: "terminal" }] }] },
                ],
              },
            ],
          }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    const writes: Array<{ path: string; data: string }> = [];
    const fakeFs = {
      mkdir: async () => undefined,
      writeFile: async (path: string, data: string) => {
        writes.push({ path, data });
      },
    };
    const adapter = makeLiveAdapter({
      spawn: fakeSpawn,
      fs: fakeFs,
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
    });

    const wt = await adapter.createWorktree({ planId: "evt_p1", stepIndex: 0 });
    expect(wt.path).toBe(".boule-worktrees/boule-evt_p1-step0");
    await adapter.writeEnvelopeFile(
      wt.path,
      {
        planId: "evt_p1",
        stepIndex: 0,
        taskId: "evt_t0",
        worktreePath: wt.path,
        executor: "claude",
        allowedPathGlobs: [],
        allowedType2Actions: [],
        forbiddenDecisionClasses: [],
        escalationTriggers: [],
        escalateOnAnyBoundaryCrossing: true,
      },
      "PROMPT",
    );
    const sess = await adapter.spawnSession({
      worktreePath: wt.path,
      stepIndex: 0,
      prompt: "PROMPT",
    });
    // surface is the workspace's terminal surface ref (resolved from `tree --json`), NOT the
    // workspace ref — the Observer reconciles live sessions by surface ref.
    expect(sess.surface).toBe("surface:42");

    expect(calls.map((c) => `${c.cmd} ${c.args[0] ?? ""}`)).toEqual([
      "git -C",
      "cmux new-workspace",
      "cmux tree",
    ]);
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "add", "--detach", wt.path, "HEAD"]);
    // the executor is launched ATOMICALLY at workspace creation via --command (a separate `send`
    // to a background workspace surface fails), and the worktree cwd is bound.
    expect(calls[1]!.args.slice(0, 4)).toEqual(["new-workspace", "--cwd", wt.path, "--command"]);
    expect(calls[2]!.args).toEqual(["tree", "--all", "--json"]);
    // the claude invocation (in the --command arg) runs against the scoped executor-role config
    // + denies verdict tools
    const claudeCmd = calls[1]!.args[4]!;
    expect(claudeCmd).toContain("--mcp-config");
    expect(claudeCmd).toContain("--strict-mcp-config");
    expect(claudeCmd).toContain("--disallowedTools");
    expect(claudeCmd).toContain("mcp__boule-governance__choose");
    expect(claudeCmd).toContain("mcp__boule-governance__approve");
    expect(claudeCmd).toContain(`$(cat ${wt.path}/.boule/step-prompt.md)`);
    // envelope + prompt + scoped MCP config written into the worktree's .boule dir
    expect(writes.map((w) => w.path)).toEqual([
      `${wt.path}/.boule/envelope.json`,
      `${wt.path}/.boule/step-prompt.md`,
      `${wt.path}/.boule/mcp.json`,
    ]);
    const mcpJson = writes.find((w) => w.path.endsWith("mcp.json"))!.data;
    expect(mcpJson).toContain('"BOULE_SESSION_ROLE": "executor"');
    expect(mcpJson).toContain('"BOULE_WORKSPACE": "/repo/governance/workspace"');
    // executor MCP server = the Boule install entrypoint, NOT <repoRoot>/governance (the target
    // repo has no governance/ dir) — this is the per-repo loop-closure fix.
    expect(mcpJson).toContain("/install/governance/src/mcp/server.ts");
    expect(mcpJson).not.toContain("/repo/governance/src/mcp/server.ts");
    // BOULE_REPO_ROOT pins the executor's docs-reading tools to the TARGET repo (not the
    // WORKSPACE-relative default which would point at <repo>/.boule).
    expect(mcpJson).toContain('"BOULE_REPO_ROOT": "/repo"');
  });

  it("surfaces a terminal failure when git exits non-zero (no retry loop)", async () => {
    const fakeSpawn = (): SpawnResultLike => ({ status: 1, stdout: "", stderr: "fatal: boom" });
    const adapter = makeLiveAdapter({
      spawn: fakeSpawn,
      fs: { mkdir: async () => undefined, writeFile: async () => undefined },
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
    });
    await expect(adapter.createWorktree({ planId: "evt_p1", stepIndex: 0 })).rejects.toThrow(
      /failed/i,
    );
  });
});

describe("makeLiveAdapter — per-project cmux folder grouping", () => {
  // fake cmux/git: new-workspace → workspace:7; tree → one terminal surface:42 in workspace:7;
  // workspace-group list → the provided groups; everything else → ok. Records all calls.
  const makeFake = (groupsJson: string, failGroupCmds = false) => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      if (cmd === "cmux" && args[0] === "new-workspace")
        return { status: 0, stdout: "OK workspace:7\n", stderr: "" };
      if (cmd === "cmux" && args[0] === "workspace-group" && args[1] === "list")
        return failGroupCmds
          ? { status: 1, stdout: "", stderr: "no such command" }
          : { status: 0, stdout: groupsJson, stderr: "" };
      if (cmd === "cmux" && args[0] === "tree")
        return {
          status: 0,
          stdout: JSON.stringify({
            windows: [
              {
                workspaces: [
                  { ref: "workspace:7", panes: [{ surfaces: [{ ref: "surface:42", type: "terminal" }] }] },
                ],
              },
            ],
          }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, spawn };
  };
  const mkAdapter = (fake: ReturnType<typeof makeFake>) =>
    makeLiveAdapter({
      spawn: fake.spawn,
      fs: { mkdir: async () => undefined, writeFile: async () => undefined },
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
      projectLabel: "work-radar",
    });

  it("CREATES the folder anchored on the new workspace when none matches the project label", async () => {
    const fake = makeFake(JSON.stringify({ groups: [] }));
    const sess = await mkAdapter(fake).spawnSession({ worktreePath: "/wt/s0", stepIndex: 0, prompt: "P" });
    expect(sess.surface).toBe("surface:42");
    const create = fake.calls.find((c) => c.args[0] === "workspace-group" && c.args[1] === "create");
    expect(create).toBeTruthy();
    expect(create!.args).toEqual(["workspace-group", "create", "--name", "work-radar", "--from", "workspace:7"]);
    expect(fake.calls.some((c) => c.args[1] === "add")).toBe(false);
  });

  it("REUSES (adds the workspace to) an existing folder matching the project label", async () => {
    const fake = makeFake(
      JSON.stringify({ groups: [{ name: "work-radar", ref: "workspace_group:5" }] }),
    );
    const sess = await mkAdapter(fake).spawnSession({ worktreePath: "/wt/s0", stepIndex: 0, prompt: "P" });
    expect(sess.surface).toBe("surface:42");
    const add = fake.calls.find((c) => c.args[0] === "workspace-group" && c.args[1] === "add");
    expect(add!.args).toEqual([
      "workspace-group",
      "add",
      "--group",
      "workspace_group:5",
      "--workspace",
      "workspace:7",
    ]);
    expect(fake.calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  it("grouping is BEST-EFFORT: a workspace-group failure still returns the session surface", async () => {
    const fake = makeFake("", true);
    const sess = await mkAdapter(fake).spawnSession({ worktreePath: "/wt/s0", stepIndex: 0, prompt: "P" });
    expect(sess.surface).toBe("surface:42"); // loop not broken by grouping failure
  });
});

describe("cmux output parsing (real-contract helpers — live-loop de-risk)", () => {
  it("parseCmuxRef extracts the ref from `OK workspace:N` (notice on stderr, not stdout)", () => {
    expect(parseCmuxRef("OK workspace:7\n", "workspace")).toBe("workspace:7");
    expect(parseCmuxRef("OK surface:42 workspace:7\n", "surface")).toBe("surface:42");
  });
  it("parseCmuxRef throws (terminal failure) when the ref is absent", () => {
    expect(() => parseCmuxRef("OK\n", "workspace")).toThrow(/no workspace ref/);
  });
  it("firstTerminalSurface returns the workspace's terminal surface ref", () => {
    const tree = JSON.stringify({
      windows: [
        {
          workspaces: [
            { ref: "workspace:1", panes: [{ surfaces: [{ ref: "surface:1", type: "terminal" }] }] },
            { ref: "workspace:7", panes: [{ surfaces: [{ ref: "surface:42", type: "terminal" }] }] },
          ],
        },
      ],
    });
    expect(firstTerminalSurface(tree, "workspace:7")).toBe("surface:42");
  });
  it("firstTerminalSurface skips non-terminal (e.g. browser) surfaces", () => {
    const tree = JSON.stringify({
      windows: [
        {
          workspaces: [
            {
              ref: "workspace:7",
              panes: [
                { surfaces: [{ ref: "surface:9", type: "browser" }, { ref: "surface:10", type: "terminal" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(firstTerminalSurface(tree, "workspace:7")).toBe("surface:10");
  });
  it("firstTerminalSurface throws when the workspace has no terminal surface", () => {
    const tree = JSON.stringify({ windows: [{ workspaces: [{ ref: "workspace:7", panes: [] }] }] });
    expect(() => firstTerminalSurface(tree, "workspace:7")).toThrow(/no terminal surface/);
  });
  it("firstTerminalSurface throws on invalid JSON", () => {
    expect(() => firstTerminalSurface("not json", "workspace:7")).toThrow(/invalid JSON/);
  });
  it("findGroupRef returns the ref of a group matching the name, else null", () => {
    const list = JSON.stringify({
      groups: [
        { name: "other", ref: "workspace_group:1" },
        { name: "work-radar", ref: "workspace_group:5" },
      ],
    });
    expect(findGroupRef(list, "work-radar")).toBe("workspace_group:5");
    expect(findGroupRef(list, "absent")).toBeNull();
    expect(findGroupRef("not json", "work-radar")).toBeNull();
    expect(findGroupRef(JSON.stringify({ groups: [] }), "work-radar")).toBeNull();
  });
  it("projectLabelFromRepoRoot returns the repo dir basename (trailing slashes trimmed)", () => {
    expect(projectLabelFromRepoRoot("/Users/me/private_project/work-radar")).toBe("work-radar");
    expect(projectLabelFromRepoRoot("/tmp/boule-live-smoke/")).toBe("boule-live-smoke");
  });
});

describe("L3 — codex peer executor (buildSessionCommand + spawn branch + envelope)", () => {
  // serverEntrypoint is the Boule INSTALL path, deliberately NOT under /repo (the target repo) —
  // proves the executor MCP points at the install, not <repoRoot>/governance.
  const cmdDeps = {
    serverEntrypoint: "/install/governance/src/mcp/server.ts",
    governanceWorkspace: "/repo/governance/workspace",
  };

  it("claude (default) builds the scoped-mcp.json + strict + verdict denylist invocation", () => {
    const c = buildSessionCommand("claude", { worktreePath: "/wt/s0" }, cmdDeps);
    expect(c).toContain("claude --mcp-config");
    expect(c).toContain("--strict-mcp-config");
    // unattended autonomy within the worktree sandbox (see buildSessionCommand)
    expect(c).toContain("--permission-mode bypassPermissions");
    expect(c).toContain("--disallowedTools");
    expect(c).toContain("mcp__boule-governance__approve");
    // `--` must precede the positional prompt so the variadic --disallowedTools can't swallow it
    expect(c).toMatch(/--disallowedTools .*-- "\$\(cat \/wt\/s0\/\.boule\/step-prompt\.md\)"/);
    expect(c).toContain("$(cat /wt/s0/.boule/step-prompt.md)");
    expect(c).not.toContain("codex");
  });

  it("codex builds a workspace-write (NOT danger-full) exec attaching the executor-role MCP via -c", () => {
    const c = buildSessionCommand("codex", { worktreePath: "/wt/s0" }, cmdDeps);
    expect(c).toContain("codex exec");
    expect(c).toContain("--sandbox workspace-write");
    // approval gate disabled so the headless exec session can call its MCP tools (complete_task);
    // but the sandbox is KEPT — never the approvals+sandbox bypass.
    expect(c).toContain('approval_policy="never"');
    expect(c).not.toContain("danger");
    expect(c).toContain('-C "/wt/s0"');
    // same executor-role server (verdict tools structurally absent), attached via codex -c config
    expect(c).toContain("mcp_servers.boule-governance.command=");
    expect(c).toContain('BOULE_SESSION_ROLE="executor"');
    expect(c).toContain("/install/governance/src/mcp/server.ts");
    expect(c).not.toContain("/repo/governance/src/mcp/server.ts"); // never repoRoot-derived
    expect(c).toContain("$(cat /wt/s0/.boule/step-prompt.md)");
    // codex has no per-server denylist — must NOT rely on claude's flags
    expect(c).not.toContain("--disallowedTools");
  });

  it("spawnSession launches a codex invocation via --command when executor=codex (same cmux substrate)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      if (cmd === "cmux" && args[0] === "new-workspace")
        return { status: 0, stdout: "OK workspace:9\n", stderr: "" };
      if (cmd === "cmux" && args[0] === "tree")
        return {
          status: 0,
          stdout: JSON.stringify({
            windows: [
              {
                workspaces: [
                  { ref: "workspace:9", panes: [{ surfaces: [{ ref: "surface:55", type: "terminal" }] }] },
                ],
              },
            ],
          }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    const adapter = makeLiveAdapter({
      spawn: fakeSpawn,
      fs: { mkdir: async () => undefined, writeFile: async () => undefined },
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
    });
    const sess = await adapter.spawnSession({
      worktreePath: "/wt/s0",
      stepIndex: 0,
      prompt: "P",
      executor: "codex",
    });
    expect(sess.surface).toBe("surface:55");
    const created = calls.find((c) => c.cmd === "cmux" && c.args[0] === "new-workspace")!;
    expect(created.args[3]).toBe("--command");
    expect(created.args[4]).toContain("codex exec");
    expect(created.args[4]).not.toContain("claude --mcp-config");
    expect(calls.some((c) => c.cmd === "cmux" && c.args[0] === "send")).toBe(false);
  });

  it("conductPlan(executor=codex) records executor in the session_spawned envelope", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, { adapter: stubAdapter, executor: "codex" }, at(10), 0.3);
    const all = await readAllEvents(dir);
    const spawned = all.find((e) => e.frontmatter.type === "session_spawned")!;
    const body = JSON.parse(spawned.body) as { envelope: { executor: string } };
    expect(body.envelope.executor).toBe("codex");
  });

  it("conductPlan defaults to claude in the envelope when executor omitted", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, { adapter: stubAdapter }, at(10), 0.3);
    const all = await readAllEvents(dir);
    const spawned = all.find((e) => e.frontmatter.type === "session_spawned")!;
    const body = JSON.parse(spawned.body) as { envelope: { executor: string } };
    expect(body.envelope.executor).toBe("claude");
  });
});

describe("conductorStatus — read-only render", () => {
  it("renders steps, cursor, halted, done and writes nothing", async () => {
    const planId = await setupActivePlan();
    const before = (await readAllEvents(dir)).length;
    const st = await conductorStatus(dir, { planId });
    expect(st.steps.map((s) => s.text)).toEqual(["step a", "step b"]);
    expect(st.cursor).toBe(0);
    expect(st.halted).toBe(false);
    expect(st.done).toBe(false);
    expect((await readAllEvents(dir)).length).toBe(before);
  });
});
