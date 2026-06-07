import type { AutonomyEnvelope, ExecutorKind } from "./envelope.ts";

export interface CreateWorktreeSpec {
  planId: string;
  stepIndex: number;
  repoRoot?: string;
}
export interface SpawnSessionSpec {
  worktreePath: string;
  stepIndex: number;
  prompt: string;
  /** which CLI to launch (claude|codex). Omitted ⇒ "claude" (backward-compatible). */
  executor?: ExecutorKind;
}

/** DI seam for the side-effecting half of conduct: worktree + cmux session + envelope file.
 *  The default stubAdapter is deterministic and touches NO git/cmux/fs; the live adapter
 *  injects a child_process-like spawn at the server.ts boundary (mirrors liveReviewer). */
export interface ConductorAdapter {
  createWorktree(spec: CreateWorktreeSpec): Promise<{ path: string }>;
  spawnSession(spec: SpawnSessionSpec): Promise<{ surface: string }>;
  writeEnvelopeFile(
    worktreePath: string,
    envelope: AutonomyEnvelope,
    prompt: string,
  ): Promise<void>;
}

/** Deterministic default — fixed path + `surface:stub-<k>`, no real processes/files. So with
 *  BOULE_CONDUCTOR_MODE unset, CI conducts plans without touching git/cmux/fs (design §6). */
export const stubAdapter: ConductorAdapter = {
  async createWorktree(spec) {
    return { path: `.boule-worktrees/stub-${spec.planId}-step${spec.stepIndex}` };
  },
  async spawnSession(spec) {
    return { surface: `stub-${spec.stepIndex}` };
  },
  async writeEnvelopeFile() {
    /* stub: no fs */
  },
};

// ── Live adapter (behind BOULE_CONDUCTOR_MODE=live) ───────────────────────────────────────────

/** Minimal structural seam over a child process — satisfied by node's spawnSync-like boundary
 *  and by a fake in tests. Synchronous capture keeps the command SEQUENCE assertable. */
export interface SpawnResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type SpawnSyncLike = (command: string, args: string[]) => SpawnResultLike;

/** A real filesystem write seam (node fs/promises at the boundary; a fake in tests). */
export interface FsLike {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<unknown>;
}

export interface LiveAdapterDeps {
  spawn: SpawnSyncLike; // child_process.spawnSync-like
  fs: FsLike;
  repoRoot: string; // git worktrees are added from here (NEVER the user tree directly)
  worktreesRoot: string; // gitignored root; one worktree dir per (plan, step)
  cmuxCmd: string; // the cmux binary (app bin by default)
  /** The governance workspace the spawned session's escalate must write back to (so the
   *  Conductor sees its decision_blocked). Defaults to <repoRoot>/governance/workspace. */
  governanceWorkspace: string;
  log?: (line: string) => void; // PII-safe (command names + status only)
}

/** The MCP server alias the scoped session config registers boule under. Tool ids the session
 *  is denied therefore read `mcp__<alias>__<tool>`. */
const BOULE_MCP_ALIAS = "boule-governance";

/** Verdict tools an executor-role session must never reach. Defense-in-depth: the server itself
 *  unregisters these when BOULE_SESSION_ROLE=executor (structural), AND the CLI is told to deny
 *  them. A spawned session can `escalate`/`complete_task`/read, but cannot resolve a fork. */
export const SESSION_DENIED_TOOLS = [
  `mcp__${BOULE_MCP_ALIAS}__approve`,
  `mcp__${BOULE_MCP_ALIAS}__reject`,
  `mcp__${BOULE_MCP_ALIAS}__choose`,
  `mcp__${BOULE_MCP_ALIAS}__accept_plan`,
  `mcp__${BOULE_MCP_ALIAS}__accept_spec`,
];

/** The scoped MCP config written into each session worktree. It launches boule with
 *  BOULE_SESSION_ROLE=executor (verdict tools structurally absent) pointed at the SAME
 *  governance workspace, so the session's escalate is visible to the Conductor. */
export function sessionMcpConfig(repoRoot: string, governanceWorkspace: string): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [BOULE_MCP_ALIAS]: {
            command: "node",
            args: ["--experimental-strip-types", `${repoRoot}/governance/src/mcp/server.ts`],
            env: { BOULE_SESSION_ROLE: "executor", BOULE_WORKSPACE: governanceWorkspace },
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

class CommandError extends Error {
  constructor(cmd: string, status: number | null, stderr: string) {
    super(`conductor command failed: ${cmd} (status=${status ?? "null"}) ${stderr.slice(0, 200)}`);
    this.name = "CommandError";
  }
}

/** Build the executor invocation `cmux send`s into the session pane. Pure (so the exact command is
 *  asserted in tests). Both executors run the SAME step-prompt against the SAME executor-role
 *  governance MCP (verdict tools structurally absent), so the loop closes identically: the session
 *  calls complete_task / escalate. Differences are CLI-shaped only.
 *
 *  - claude: reads the scoped `.boule/mcp.json` (--mcp-config) under --strict-mcp-config, PLUS an
 *    explicit verdict-tool --disallowedTools denylist (defense-in-depth on top of the server's
 *    structural omission).
 *  - codex: attaches the SAME executor-role server via `-c mcp_servers.*` (codex has no per-server
 *    denylist — the server's structural verdict-tool omission is the guarantee). Runs one-shot
 *    `codex exec` in a `workspace-write` sandbox confined to the worktree cwd (NEVER danger-full,
 *    per codex-worktree-runner). ⚠ The codex MCP round-trip (complete_task FROM codex) is asserted
 *    structurally here but needs a live smoke (runbook §5) to confirm end-to-end. */
export function buildSessionCommand(
  executor: ExecutorKind,
  spec: { worktreePath: string },
  deps: { repoRoot: string; governanceWorkspace: string },
): string {
  const promptCat = `"$(cat ${spec.worktreePath}/.boule/step-prompt.md)"`;
  if (executor === "codex") {
    const serverPath = `${deps.repoRoot}/governance/src/mcp/server.ts`;
    return (
      `codex exec --sandbox workspace-write --skip-git-repo-check -C "${spec.worktreePath}" ` +
      `-c 'mcp_servers.boule-governance.command="node"' ` +
      `-c 'mcp_servers.boule-governance.args=["--experimental-strip-types","${serverPath}"]' ` +
      `-c 'mcp_servers.boule-governance.env={BOULE_SESSION_ROLE="executor",BOULE_WORKSPACE="${deps.governanceWorkspace}"}' ` +
      `${promptCat}\n`
    );
  }
  const denied = SESSION_DENIED_TOOLS.map((t) => `"${t}"`).join(" ");
  return (
    `claude --mcp-config "${spec.worktreePath}/.boule/mcp.json" --strict-mcp-config ` +
    `--disallowedTools ${denied} ` +
    `${promptCat}\n`
  );
}

/** Build a live adapter that runs real `git worktree add --detach` + `cmux new-workspace` +
 *  `cmux send`. Non-determinism (spawn/fs) is injected, so the unit test asserts the exact
 *  command sequence with a fake spawn — no real processes. Each command is bounded (one shot,
 *  no retry loop) and surfaces a terminal failure (design §6). */
export function makeLiveAdapter(deps: LiveAdapterDeps): ConductorAdapter {
  const run = (command: string, args: string[]): SpawnResultLike => {
    const res = deps.spawn(command, args);
    deps.log?.(`conductor exec ${command} ${args[0] ?? ""} status=${res.status ?? "null"}`);
    if (res.status !== 0)
      throw new CommandError(`${command} ${args.join(" ")}`, res.status, res.stderr);
    return res;
  };

  const worktreePathFor = (planId: string, stepIndex: number) =>
    `${deps.worktreesRoot}/boule-${planId}-step${stepIndex}`;

  return {
    async createWorktree(spec) {
      const path = worktreePathFor(spec.planId, spec.stepIndex);
      // Worktree is added from repoRoot into the gitignored worktrees root — never the user tree.
      run("git", ["-C", deps.repoRoot, "worktree", "add", "--detach", path, "HEAD"]);
      return { path };
    },

    async spawnSession(spec) {
      // 1) open an isolated cmux workspace bound to the worktree cwd; capture surface from stdout.
      const open = run(deps.cmuxCmd, ["new-workspace", "--cwd", spec.worktreePath]);
      const surface = open.stdout.trim();
      // 2) send the executor invocation (claude|codex). Both run against the SCOPED executor-role
      //    MCP (verdict tools structurally absent), so a spawned session can escalate/complete_task
      //    but cannot self-resolve (structural INVARIANT #1). See buildSessionCommand.
      const command = buildSessionCommand(spec.executor ?? "claude", spec, {
        repoRoot: deps.repoRoot,
        governanceWorkspace: deps.governanceWorkspace,
      });
      run(deps.cmuxCmd, ["send", "--surface", surface, command]);
      return { surface };
    },

    async writeEnvelopeFile(worktreePath, envelope, prompt) {
      const bouleDir = `${worktreePath}/.boule`;
      await deps.fs.mkdir(bouleDir, { recursive: true });
      await deps.fs.writeFile(
        `${bouleDir}/envelope.json`,
        JSON.stringify(envelope, null, 2) + "\n",
      );
      await deps.fs.writeFile(`${bouleDir}/step-prompt.md`, prompt);
      // Scoped executor-role MCP config — the structural backstop for session verdict isolation.
      await deps.fs.writeFile(
        `${bouleDir}/mcp.json`,
        sessionMcpConfig(deps.repoRoot, deps.governanceWorkspace),
      );
    },
  };
}
