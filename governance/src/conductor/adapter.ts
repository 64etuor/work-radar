import type { AutonomyEnvelope, ExecutorKind } from "./envelope.ts";

export interface CreateWorktreeSpec {
  planId: string;
  stepIndex: number;
  repoRoot?: string;
}
export interface SpawnSessionSpec {
  worktreePath: string;
  stepIndex: number;
  /** the bound task — the codex completion wrapper passes it to `complete-task` on clean exit. */
  taskId: string;
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
  /** true if the path exists (any type, incl. a symlink). Idempotent clean-home materialization. */
  pathExists(path: string): Promise<boolean>;
  /** create a symlink at `link` pointing to `target` (the clean codex home's auth.json → operator). */
  symlink(target: string, link: string): Promise<unknown>;
  /** remove a file (best-effort; deletes a stray hooks.json from the clean codex home). */
  rm(path: string): Promise<unknown>;
}

export interface LiveAdapterDeps {
  spawn: SpawnSyncLike; // child_process.spawnSync-like
  fs: FsLike;
  repoRoot: string; // git worktrees are added from here (NEVER the user tree directly)
  worktreesRoot: string; // gitignored root; one worktree dir per (plan, step)
  cmuxCmd: string; // the cmux binary (app bin by default)
  /** Absolute path to the governance MCP server (the Boule INSTALL, e.g. via import.meta.url) —
   *  NOT under the target repo. A designated local repo has no governance/ dir, so the spawned
   *  session's executor-role MCP must point here, not at <repoRoot>/governance/src/mcp/server.ts. */
  serverEntrypoint: string;
  /** Absolute path to the `boule` CLI (the Boule INSTALL). The codex completion wrapper shells
   *  `node <completeEntrypoint> complete-task` on clean exit so the loop closes even when the model
   *  forgets the complete_task MCP call. Same install as serverEntrypoint, never the target repo. */
  completeEntrypoint: string;
  /** The governance workspace the spawned session's escalate must write back to (so the
   *  Conductor sees its decision_blocked). Defaults to <repoRoot>/governance/workspace. */
  governanceWorkspace: string;
  /** Operator codex auth.json path (e.g. `${CODEX_HOME:-~/.codex}/auth.json`). The conductor spawns
   *  codex under a clean per-repo CODEX_HOME (no operator hooks); that home has no auth, so when no
   *  env API key is set ensureCleanCodexHome symlinks this in — never copied (codex may refresh it;
   *  one real identity), never the operator's ~/.codex touched otherwise. */
  codexAuthPath: string;
  /** Process env — the OPENAI_API_KEY/CODEX_API_KEY check (env auth ⇒ no auth.json symlink needed). */
  env: Record<string, string | undefined>;
  /** cmux workspace-group (sidebar folder) name. Each spawned session's workspace is grouped under
   *  it — reused if the folder already exists, created otherwise — so a project's sessions stay
   *  visually separated. Omitted ⇒ no grouping. The server defaults it to the repoRoot basename. */
  projectLabel?: string;
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
  // auto_dispatch is an ORCHESTRATOR tool: it can auto-accept plans/specs (autonomyLevel) and spawn
  // sub-sessions. An executor session must never reach it — else it could open INVARIANT #1's gate
  // for its own plan. Denied here (claude denylist) AND structurally unregistered for executor role
  // in server.ts (mirrors accept_plan/accept_spec); the guarantee does not rely on env isolation.
  `mcp__${BOULE_MCP_ALIAS}__auto_dispatch`,
];

/** The scoped MCP config written into each session worktree. It launches boule with
 *  BOULE_SESSION_ROLE=executor (verdict tools structurally absent) pointed at the SAME
 *  governance workspace, so the session's escalate is visible to the Conductor. */
export function sessionMcpConfig(
  serverEntrypoint: string,
  governanceWorkspace: string,
  repoRoot: string,
): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          [BOULE_MCP_ALIAS]: {
            command: "node",
            args: ["--experimental-strip-types", serverEntrypoint],
            // BOULE_REPO_ROOT pins the executor session's server to the TARGET repo, so any
            // docs-reading tool it touches (decisions/principles/harvest) reads <repo>/docs — NOT
            // the WORKSPACE-relative default (resolve(WORKSPACE,"..","..") = <repo>/.boule, wrong).
            env: {
              BOULE_SESSION_ROLE: "executor",
              BOULE_WORKSPACE: governanceWorkspace,
              BOULE_REPO_ROOT: repoRoot,
            },
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

/** The minimal config.toml written into the conductor's clean codex profile: NO hooks, plugins,
 *  notify, or developer_instructions — so a conductor-spawned `codex exec` is never hijacked by the
 *  operator's oh-my-codex / cmux hooks (config.toml `notify`/`plugin_hooks`/`developer_instructions`
 *  + hooks.json). Absence of a plugins/ dir and hooks.json already means "off"; this makes the
 *  isolation contract explicit and durable. */
const CLEAN_CODEX_CONFIG =
  "# Boule clean Codex profile — conductor-owned. Do NOT add hooks, plugins, notify, or\n" +
  "# developer instructions here (isolating the conductor from the operator's codex is the point).\n" +
  "plugin_hooks = false\n" +
  "notify = []\n";

export interface EnsureCleanCodexHomeDeps {
  codexHome: string;
  /** operator auth.json to symlink in when no env API key is set. */
  operatorAuthPath: string;
  env: Record<string, string | undefined>;
  fs: FsLike;
}

/** Idempotently materialize a clean, hooks-free CODEX_HOME for a conductor-spawned codex, so the
 *  operator's oh-my-codex/cmux hooks never load (the hijack root cause). Writes the minimal config,
 *  removes a stray hooks.json, and ensures auth: an env API key wins (no file); else symlink the
 *  operator's auth.json (one real identity, never copied) — THROWS if neither is available so we
 *  never spawn an unauthenticated codex. NEVER wipes session/history state (reusable across ticks),
 *  and NEVER touches the operator's ~/.codex beyond reading the auth symlink target. */
export async function ensureCleanCodexHome(deps: EnsureCleanCodexHomeDeps): Promise<void> {
  const { codexHome, operatorAuthPath, env, fs } = deps;
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(`${codexHome}/config.toml`, CLEAN_CODEX_CONFIG);
  // Defense: a stray hooks.json under our OWN clean home would re-introduce hooks — remove it.
  const hooksPath = `${codexHome}/hooks.json`;
  if (await fs.pathExists(hooksPath)) await fs.rm(hooksPath);
  // Auth: env key wins (no file needed). Never put a key in the command string — codex inherits env.
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return;
  const authLink = `${codexHome}/auth.json`;
  // No env key ⇒ we need the operator's auth. Check the SOURCE first: if it's gone (operator rotated/
  // removed ~/.codex/auth.json since a prior tick created the link), surface a CLEAR pre-spawn error
  // and drop the now-dangling link — never skip on a dead symlink that would make codex fail opaquely.
  if (!(await fs.pathExists(operatorAuthPath))) {
    if (await fs.pathExists(authLink)) await fs.rm(authLink);
    throw new Error(
      `conductor: codex auth unavailable — set OPENAI_API_KEY / CODEX_API_KEY or provide ${operatorAuthPath}`,
    );
  }
  if (await fs.pathExists(authLink)) return; // idempotent — valid existing link (operator auth present)
  await fs.symlink(operatorAuthPath, authLink);
}

/** POSIX single-quote a value for safe shell interpolation (paths with spaces/specials). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
 *    per codex-worktree-runner). The codex model is flakier about issuing the closing complete_task
 *    MCP call (gpt-5.5 adherence; live smoke §5), so the codex command is followed by a guarded
 *    completion wrapper: `&& node <cli> complete-task` fires ONLY on clean exit (nonzero ⇒ skipped),
 *    and `completeTask` itself REFUSES if the task isn't active or has an unresolved decision_blocked
 *    (verdict-free, INVARIANT #1-safe — it cannot accept a plan/spec or resolve a fork). */
export function buildSessionCommand(
  executor: ExecutorKind,
  spec: { worktreePath: string; taskId: string },
  deps: {
    serverEntrypoint: string;
    governanceWorkspace: string;
    completeEntrypoint: string;
    /** clean per-repo CODEX_HOME the conductor codex runs under (required for executor==="codex";
     *  materialized by ensureCleanCodexHome). Isolates from the operator's oh-my-codex/cmux hooks. */
    codexHome?: string;
  },
): string {
  const promptCat = `"$(cat ${spec.worktreePath}/.boule/step-prompt.md)"`;
  if (executor === "codex") {
    // The governance server lives at the Boule INSTALL, not under the target repo (a designated
    // local repo has no governance/ dir) — derive it from the injected entrypoint, never repoRoot.
    const serverPath = deps.serverEntrypoint;
    // CODEX_HOME='<clean home>' redirects codex's profile (config.toml/auth/hooks/plugins) to a
    // conductor-owned hooks-free dir, so the operator's oh-my-codex/cmux hooks NEVER load (the
    // hijack root cause). The prefix env assignment applies to `codex exec` ONLY — the trailing
    // `&& node … complete-task` (boule CLI) does NOT inherit it. Required: materialized beforehand.
    if (!deps.codexHome) {
      throw new Error("buildSessionCommand: codex requires deps.codexHome (clean hooks-free profile)");
    }
    // approval_policy="never" lets the headless exec session call its MCP tools (complete_task /
    // escalate) WITHOUT a per-call approval gate — under the default policy codex blocks the MCP
    // round-trip in non-interactive exec (live smoke: "complete_task (failed)" on a PermissionRequest).
    // Autonomy stays sandboxed: --sandbox workspace-write confines writes to the worktree cwd; this
    // is NEVER --dangerously-bypass-approvals-and-sandbox (which removes the sandbox).
    // `&& node <cli> complete-task` = the adherence backstop: on clean codex exit, close the task
    // lifecycle even if the model skipped the complete_task tool call. cmux runs --command through a
    // shell, so the `&&` short-circuits on nonzero exit (no completion on failure/escalation-abort).
    return (
      `CODEX_HOME=${shellQuote(deps.codexHome)} ` +
      `codex exec --sandbox workspace-write --skip-git-repo-check -c approval_policy="never" ` +
      `-C "${spec.worktreePath}" ` +
      `-c 'mcp_servers.boule-governance.command="node"' ` +
      `-c 'mcp_servers.boule-governance.args=["--experimental-strip-types","${serverPath}"]' ` +
      `-c 'mcp_servers.boule-governance.env={BOULE_SESSION_ROLE="executor",BOULE_WORKSPACE="${deps.governanceWorkspace}"}' ` +
      `${promptCat}` +
      ` && node --experimental-strip-types "${deps.completeEntrypoint}" complete-task ` +
      `--workspace "${deps.governanceWorkspace}" --task "${spec.taskId}"\n`
    );
  }
  const denied = SESSION_DENIED_TOOLS.map((t) => `"${t}"`).join(" ");
  // bypassPermissions = unattended autonomy: without it the session blocks on the first Write/MCP
  // permission prompt in a non-interactive pane → the loop never closes.
  // ⚠ claude↔codex SANDBOX ASYMMETRY: bypassPermissions only removes approval prompts — it is NOT an
  // OS filesystem sandbox. The worktree is merely claude's cwd, NOT an enforced boundary, so a
  // misbehaving/prompt-injected claude session CAN write absolute paths outside it. (codex, below,
  // gets real FS confinement via --sandbox workspace-write.) What holds for claude regardless of
  // this flag: verdict isolation is STRUCTURAL (executor-role MCP omits verdict tools, plus
  // --strict-mcp-config + the denylist), and external writes route through the External Action Gate
  // (L4). OS-level FS confinement for claude is a deferred follow-up (plan §9.6).
  // `--` terminates option parsing so the variadic `--disallowedTools <tools...>` cannot swallow
  // the positional prompt (without it, claude launches with NO prompt and sits idle → loop hangs).
  return (
    `claude --mcp-config "${spec.worktreePath}/.boule/mcp.json" --strict-mcp-config ` +
    `--permission-mode bypassPermissions ` +
    `--disallowedTools ${denied} ` +
    `-- ${promptCat}\n`
  );
}

/** Extract the first `<kind>:<n>` ref from cmux stdout. cmux prints `OK <ref>` on success and
 *  routes the legacy-alias deprecation notice to STDERR, so a regex over stdout is robust to both
 *  the `OK ` prefix and any future notice drift. Throws (terminal failure) if the ref is absent. */
export function parseCmuxRef(stdout: string, kind: "workspace" | "surface"): string {
  const m = stdout.match(new RegExp(`${kind}:\\d+`));
  if (!m) throw new Error(`conductor: no ${kind} ref in cmux output: ${stdout.slice(0, 120)}`);
  return m[0];
}

/** First terminal surface ref inside a given workspace, parsed from `cmux tree --json`. A freshly
 *  created workspace has exactly one pane/surface; we return its ref so the Observer (which
 *  reconciles live sessions by SURFACE ref) can detect this session's crash (L2 stall safety).
 *  Mirrors observer.ts parseSurfaces but scoped to one workspace. Throws if none is found. */
export function firstTerminalSurface(treeJson: string, workspaceRef: string): string {
  let tree: unknown;
  try {
    tree = JSON.parse(treeJson);
  } catch {
    throw new Error("conductor: cmux tree --json returned invalid JSON");
  }
  const rec = (x: unknown): Record<string, unknown> =>
    x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  for (const w of asArray(rec(tree).windows)) {
    for (const ws of asArray(rec(w).workspaces)) {
      if (rec(ws).ref !== workspaceRef) continue;
      for (const p of asArray(rec(ws).panes)) {
        for (const s of asArray(rec(p).surfaces)) {
          const node = rec(s);
          if (typeof node.ref === "string" && node.ref.length > 0 && node.type === "terminal")
            return node.ref;
        }
      }
    }
  }
  throw new Error(`conductor: cmux tree has no terminal surface for ${workspaceRef}`);
}

/** Find an existing cmux workspace-group ref by name from `cmux workspace-group list --json`.
 *  Returns null when absent or the JSON is unparseable (the caller then creates the group). */
export function findGroupRef(listJson: string, name: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return null;
  }
  const rec = (x: unknown): Record<string, unknown> =>
    x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const groups = rec(parsed).groups;
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    const node = rec(g);
    if (node.name === name && typeof node.ref === "string" && node.ref.length > 0) return node.ref;
  }
  return null;
}

/** Per-project cmux folder label = the repo dir's basename, so every session spawned for a given
 *  designated local repo groups under one collapsible sidebar folder (personal vs work stay
 *  visually separated). Trailing slashes trimmed; empty ⇒ the original string. */
export function projectLabelFromRepoRoot(repoRoot: string): string {
  const parts = repoRoot.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || repoRoot;
}

/** Build a live adapter that runs real `git worktree add --detach` + `cmux new-workspace --command`
 *  + per-project `cmux workspace-group` + `cmux tree --json`. Non-determinism (spawn/fs) is injected,
 *  so the unit test asserts the exact command sequence with a fake spawn — no real processes. Each
 *  command is bounded (one shot, no retry loop) and surfaces a terminal failure (design §6). */
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
      // The executor invocation (claude|codex). Both run against the SCOPED executor-role MCP
      // (verdict tools structurally absent), so a spawned session can escalate/complete_task but
      // cannot self-resolve (structural INVARIANT #1). See buildSessionCommand.
      const executor = spec.executor ?? "claude";
      // Per-repo clean codex profile (gitignored, reusable across ticks). Built ONLY for codex so the
      // operator's oh-my-codex/cmux hooks can't hijack the spawned session (the root cause of empty
      // codex returns inside a cmux surface). Claude needs none (its hooks are the app's own).
      const codexHome = `${deps.governanceWorkspace}/codex-home`;
      if (executor === "codex") {
        await ensureCleanCodexHome({
          codexHome,
          operatorAuthPath: deps.codexAuthPath,
          env: deps.env,
          fs: deps.fs,
        });
      }
      const command = buildSessionCommand(executor, spec, {
        serverEntrypoint: deps.serverEntrypoint,
        governanceWorkspace: deps.governanceWorkspace,
        completeEntrypoint: deps.completeEntrypoint,
        codexHome,
      });
      // Create the isolated workspace AND launch the executor atomically via --command. A
      // BACKGROUND workspace runs --command immediately, but a separate `cmux send` to its surface
      // fails ("Surface is not a terminal") until that workspace is made visible — so the session
      // must be launched at creation, not sent afterward. cmux prints `OK workspace:N` on stdout
      // (the legacy-alias notice goes to stderr).
      const open = run(deps.cmuxCmd, [
        "new-workspace",
        "--cwd",
        spec.worktreePath,
        "--command",
        command,
      ]);
      const workspaceRef = parseCmuxRef(open.stdout, "workspace");
      // Group this workspace under a per-project cmux folder: reuse the folder if it already exists,
      // else create it anchored on this workspace. Best-effort — the session is already launched, so
      // a grouping failure (e.g. older cmux without workspace-group) must NOT break the loop.
      if (deps.projectLabel) {
        try {
          const list = run(deps.cmuxCmd, ["workspace-group", "list", "--json"]);
          const groupRef = findGroupRef(list.stdout, deps.projectLabel);
          if (groupRef)
            run(deps.cmuxCmd, [
              "workspace-group",
              "add",
              "--group",
              groupRef,
              "--workspace",
              workspaceRef,
            ]);
          else
            run(deps.cmuxCmd, [
              "workspace-group",
              "create",
              "--name",
              deps.projectLabel,
              "--from",
              workspaceRef,
            ]);
        } catch (e) {
          deps.log?.(
            `conductor: workspace-group grouping skipped (best-effort): ${(e as Error).message.slice(0, 120)}`,
          );
        }
      }
      // Resolve the workspace's terminal surface so the Observer can reconcile this session by ref.
      // Use `--all` (every window) to match the Observer's scope — the new workspace may land in a
      // window outside the default view; firstTerminalSurface throws (terminal failure) if absent.
      const tree = run(deps.cmuxCmd, ["tree", "--all", "--json"]);
      const surface = firstTerminalSurface(tree.stdout, workspaceRef);
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
        sessionMcpConfig(deps.serverEntrypoint, deps.governanceWorkspace, deps.repoRoot),
      );
    },
  };
}
