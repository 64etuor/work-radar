import type { AutonomyEnvelope, ExecutorKind } from "./envelope.ts";
import { type SpawnResultLike, type SpawnSyncLike, walkTerminalSurfaces } from "../repo/spawn.ts";
import { sessionDeniedTools } from "../mcp/verdictTools.ts";

export interface CreateWorktreeSpec {
  planId: string;
  stepIndex: number;
  /** Attempt 0 keeps the legacy step path; retries get a fresh per-attempt worktree. */
  attemptIndex?: number;
  repoRoot?: string;
}
export interface SpawnSessionSpec {
  worktreePath: string;
  stepIndex: number;
  /** the bound task — the codex completion wrapper passes it to `report-exit` on clean exit. */
  taskId: string;
  prompt: string;
  /** which CLI to launch (claude|codex). Omitted ⇒ sandboxed "codex". */
  executor?: ExecutorKind;
  /** Supervised executor attempt index; omitted keeps legacy attempt 0 behavior. */
  attemptIndex?: number;
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
    const suffix = spec.attemptIndex && spec.attemptIndex > 0 ? `-attempt${spec.attemptIndex}` : "";
    return { path: `.boule-worktrees/stub-${spec.planId}-step${spec.stepIndex}${suffix}` };
  },
  async spawnSession(spec) {
    return { surface: `stub-${spec.stepIndex}` };
  },
  async writeEnvelopeFile() {
    /* stub: no fs */
  },
};

// ── Live adapter (behind BOULE_CONDUCTOR_MODE=live) ───────────────────────────────────────────

// Re-exported from the shared spawn seam so existing importers (`import { SpawnSyncLike } from
// "../conductor/adapter.ts"`) continue to work without changes.
export type { SpawnResultLike, SpawnSyncLike } from "../repo/spawn.ts";

/** The local branch that chains step outputs for a plan: each completion-gate pass commits the
 *  step worktree's changes and advances this ref, and createWorktree bases the next step on it.
 *  Local-only — never pushed; merge-back to dev stays a human action (branch merge, not file copy). */
export function planBranchName(planId: string): string {
  return `boule/${planId}`;
}

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
  /** Absolute path to the `boule` CLI (the Boule INSTALL). The executor wrapper shells
   *  `node <completeEntrypoint> record-attempt` on every exit and `report-exit` on clean exit so
   *  the conductor sees verdict-free hints even when the model forgets the complete_task MCP call.
   *  Same install as serverEntrypoint. */
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
  log?: (line: string) => void; // PII-safe (command names + status only)
}

/** The MCP server alias the scoped session config registers boule under. Tool ids the session
 *  is denied therefore read `mcp__<alias>__<tool>`. */
const BOULE_MCP_ALIAS = "boule-governance";

/** Verdict tools an executor-role session must never reach. Defense-in-depth: the server itself
 *  unregisters these when BOULE_SESSION_ROLE=executor (structural), AND the CLI is told to deny
 *  them. A spawned session can `escalate`/`complete_task`/read, but cannot resolve a fork.
 *  Canonical list (+ per-tool rationale) lives in `src/mcp/verdictTools.ts` — server gating and
 *  this denylist derive from the same source, so they cannot drift. */
export const SESSION_DENIED_TOOLS = sessionDeniedTools(BOULE_MCP_ALIAS);

/** The scoped MCP config written into each session worktree. It launches boule with
 *  BOULE_SESSION_ROLE=executor (verdict tools structurally absent) pointed at the SAME
 *  governance workspace, so the session's escalate is visible to the Conductor. */
function sessionMcpConfig(
  serverEntrypoint: string,
  governanceWorkspace: string,
  repoRoot: string,
  taskId?: string,
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
              // BOULE_TASK_ID makes escalate's task linkage STRUCTURAL: the server defaults
              // related_task_id to it, so a session whose model garbles/omits the argument still
              // binds its fork to the task (live 2026-06-10: step5's relatedTaskId leaked into the
              // question text and the decision never related to the task).
              ...(taskId ? { BOULE_TASK_ID: taskId } : {}),
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

function withAttemptEvidenceTail(
  executorCommand: string,
  spec: { worktreePath: string; taskId: string; attemptIndex?: number },
  deps: { governanceWorkspace: string; completeEntrypoint: string },
  executor: ExecutorKind,
): string {
  const attemptIndex = spec.attemptIndex ?? 0;
  return (
    `__boule_stderr="$(mktemp)"` +
    `; __boule_stdout="$(mktemp)"` +
    `; __boule_ec="$(mktemp)"` +
    // P4(b) stdout usage capture: `tee` keeps the run VISIBLE in the cmux pane (the operational
    // source of truth) while persisting stdout for record-attempt's usage parse. A pipeline's $?
    // is tee's, so the brace group writes the EXECUTOR's exit code to a file first — that file,
    // not $?, is the preserved exit status.
    `; { ${executorCommand} 2>"$__boule_stderr"; echo $? >"$__boule_ec"; } | tee "$__boule_stdout"` +
    `; __boule_exit="$(cat "$__boule_ec")"` +
    // Numeric guard: a wedged capture (empty/garbled exit file) must read as FAILURE, never as
    // success — completion stays fail-closed even when the capture plumbing itself breaks.
    `; case "$__boule_exit" in ''|*[!0-9]*) __boule_exit=1;; esac` +
    `; __boule_dirty=false` +
    `; if [ -n "$(git -C "${spec.worktreePath}" status --porcelain 2>/dev/null)" ]; then __boule_dirty=true; fi` +
    // '[:cntrl:]' (not '\n'): cmux new-workspace --command translates a literal "\n" sequence into
    // Enter, splitting the wrapper across shell lines — it only survives via zsh's dquote/cmdsubst
    // continuation prompt (observed live 2026-06-10; fragile, and a wedge if the shell differs).
    `; __boule_digest="$(LC_ALL=C tr '[:cntrl:]' ' ' < "$__boule_stderr" | cut -c 1-500)"` +
    `; node --experimental-strip-types "${deps.completeEntrypoint}" record-attempt ` +
    `--workspace "${deps.governanceWorkspace}" --task "${spec.taskId}" --attempt ${attemptIndex} ` +
    `--exit-code "$__boule_exit" --launched true --worktree-dirty "$__boule_dirty" ` +
    `--stderr-digest "$__boule_digest" ` +
    // Usage evidence (fail-soft): record-attempt parses the captured stdout per executor shape;
    // any parse/read failure records usage:"unknown" exactly as before — never fails the record.
    `--usage-stdout-file "$__boule_stdout" --executor ${executor}` +
    `; if [ "$__boule_exit" -eq 0 ]; then node --experimental-strip-types "${deps.completeEntrypoint}" report-exit ` +
    `--workspace "${deps.governanceWorkspace}" --task "${spec.taskId}"; fi` +
    `; rm -f "$__boule_stderr" "$__boule_stdout" "$__boule_ec"` +
    `; exit "$__boule_exit"\n`
  );
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
 *    per codex-worktree-runner). Both branches append the same supervised-attempt wrapper: evidence
 *    is recorded on every exit, while report-exit remains clean-exit-only. */
export function buildSessionCommand(
  executor: ExecutorKind,
  spec: { worktreePath: string; taskId: string; attemptIndex?: number },
  deps: {
    serverEntrypoint: string;
    governanceWorkspace: string;
    completeEntrypoint: string;
    /** clean per-repo CODEX_HOME the conductor codex runs under (required for executor==="codex";
     *  materialized by ensureCleanCodexHome). Isolates from the operator's oh-my-codex/cmux hooks. */
    codexHome?: string;
  },
): string {
  if (executor === "claude") {
    throw new Error(
      "conductor: claude executor is disabled because its unattended mode has no enforceable OS sandbox",
    );
  }
  const promptCat = `"$(cat ${spec.worktreePath}/.boule/step-prompt.md)"`;
  const serverPath = deps.serverEntrypoint;
  if (!deps.codexHome) {
    throw new Error(
      "buildSessionCommand: codex requires deps.codexHome (clean hooks-free profile)",
    );
  }
  const codexCommand =
    `CODEX_HOME=${shellQuote(deps.codexHome)} ` +
    `codex exec --json --sandbox workspace-write --skip-git-repo-check -c approval_policy="never" ` +
    `-C "${spec.worktreePath}" ` +
    `-c 'mcp_servers.boule-governance.command="node"' ` +
    `-c 'mcp_servers.boule-governance.args=["--experimental-strip-types","${serverPath}"]' ` +
    `-c 'mcp_servers.boule-governance.env={BOULE_SESSION_ROLE="executor",BOULE_WORKSPACE="${deps.governanceWorkspace}",BOULE_TASK_ID="${spec.taskId}"}' ` +
    `${promptCat}`;
  return withAttemptEvidenceTail(codexCommand, spec, deps, "codex");
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
  // walkTerminalSurfaces returns [] on parse failure; we need to distinguish that from
  // "parsed but no match" — so check parse separately for the conductor-specific error message.
  try {
    JSON.parse(treeJson);
  } catch {
    throw new Error("conductor: cmux tree --json returned invalid JSON");
  }
  const match = walkTerminalSurfaces(treeJson).find((e) => e.workspaceRef === workspaceRef);
  if (match) return match.ref;
  throw new Error(`conductor: cmux tree has no terminal surface for ${workspaceRef}`);
}

/** Build a live adapter that runs real `git worktree add --detach` + `cmux new-workspace --command`
 *  + `cmux tree --json` — every session is a VISIBLE cmux workspace pane (observable, never a
 *  detached background process). Non-determinism (spawn/fs) is injected,
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

  const worktreePathFor = (planId: string, stepIndex: number, attemptIndex?: number) => {
    const suffix = attemptIndex && attemptIndex > 0 ? `-attempt${attemptIndex}` : "";
    return `${deps.worktreesRoot}/boule-${planId}-step${stepIndex}${suffix}`;
  };

  return {
    async createWorktree(spec) {
      const path = worktreePathFor(spec.planId, spec.stepIndex, spec.attemptIndex);
      // Step chaining: base on the plan branch (prior steps' committed output) when it exists so
      // each step sees its predecessors' work; without it (first step) fall back to HEAD. The probe
      // must not go through run() — a missing branch is the normal first-step case, not a failure.
      const planBranch = `refs/heads/${planBranchName(spec.planId)}`;
      const probe = deps.spawn("git", [
        "-C",
        deps.repoRoot,
        "rev-parse",
        "--verify",
        "--quiet",
        planBranch,
      ]);
      const base = probe.status === 0 ? planBranch : "HEAD";
      // Worktree is added from repoRoot into the gitignored worktrees root — never the user tree.
      run("git", ["-C", deps.repoRoot, "worktree", "add", "--detach", path, base]);
      return { path };
    },

    async spawnSession(spec) {
      // The executor invocation (claude|codex). Both run against the SCOPED executor-role MCP
      // (verdict tools structurally absent), so a spawned session can escalate/complete_task but
      // cannot self-resolve (structural INVARIANT #1). See buildSessionCommand.
      const executor = spec.executor ?? "codex";
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
      // The wrapper is ~2KB and --command is TYPED into the pane's interactive shell: a line that
      // long overflows the tty's canonical input buffer (MAX_CANON ~1024) during the shell-startup
      // race, arriving truncated and never submitted (live wedge 2026-06-10, step6 — masked before
      // by the embedded "\n" accidentally splitting the line). Write the wrapper to a script in the
      // worktree's .boule dir and type only a short `sh <script>` line.
      const scriptPath = `${spec.worktreePath}/.boule/run-step.sh`;
      await deps.fs.mkdir(`${spec.worktreePath}/.boule`, { recursive: true });
      await deps.fs.writeFile(scriptPath, command);
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
        `sh ${shellQuote(scriptPath)}\n`,
      ]);
      const workspaceRef = parseCmuxRef(open.stdout, "workspace");
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
        sessionMcpConfig(
          deps.serverEntrypoint,
          deps.governanceWorkspace,
          deps.repoRoot,
          envelope.taskId,
        ),
      );
    },
  };
}
