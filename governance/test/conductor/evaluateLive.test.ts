import { describe, it, expect } from "vitest";
import {
  defaultEvaluatePrompt,
  evaluatorCompletionOptions,
  liveEvaluate,
  makeReadWorktreeDiff,
  parseEvaluationVerdict,
  resolveEvaluatorBackend,
  type LiveEvaluateDeps,
} from "../../src/conductor/evaluateLive.js";
import type { EvaluationRequest } from "../../src/conductor/completion.js";
import type { ChildLike } from "../../src/decision/liveReviewer.js";
import type { ResolvedPolicy } from "../../src/repo/config.js";

const REQ: EvaluationRequest = {
  taskId: "task-1",
  sessionId: "sess-1",
  stepPrompt: "implement the slice",
  worktreeDiff: "diff --git a/x b/x",
  backend: { provider: "codex", model: "judge" },
  check: { artifact: "out/report.json" },
  worktreePath: "/wt/step0",
};

/** Scriptable fake child (mirrors liveReviewer.test's approach): emits stdout/stderr then closes. */
function fakeChild(script: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  neverClose?: boolean;
  onKill?: () => void;
}): ChildLike {
  const listeners: Record<string, Array<(arg: never) => void>> = {};
  const dataListeners: { out: Array<(c: string) => void>; err: Array<(c: string) => void> } = {
    out: [],
    err: [],
  };
  return {
    stdout: {
      on: (_e, l) => {
        dataListeners.out.push(l as (c: string) => void);
      },
    },
    stderr: {
      on: (_e, l) => {
        dataListeners.err.push(l as (c: string) => void);
      },
    },
    stdin: {
      write() {
        /* prompt accepted */
      },
      end() {
        // After the prompt lands, deliver the scripted output asynchronously (like a real child).
        queueMicrotask(() => {
          if (script.stdout) for (const l of dataListeners.out) l(script.stdout);
          if (script.stderr) for (const l of dataListeners.err) l(script.stderr);
          if (!script.neverClose)
            for (const l of listeners["close"] ?? []) (l as (c: number | null) => void)(script.exitCode ?? 0);
        });
      },
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener as (arg: never) => void);
    },
    kill() {
      script.onKill?.();
    },
  };
}

function deps(
  child: ChildLike | (() => ChildLike),
  over: Partial<LiveEvaluateDeps> = {},
): { deps: LiveEvaluateDeps; spawns: Array<{ command: string; args: string[] }> } {
  const spawns: Array<{ command: string; args: string[] }> = [];
  return {
    spawns,
    deps: {
      spawn: (command, args) => {
        spawns.push({ command, args });
        return typeof child === "function" ? child() : child;
      },
      timeoutMs: 5000,
      setTimer: () => () => {},
      ...over,
    },
  };
}

describe("parseEvaluationVerdict — tolerant extract, strict validate", () => {
  it("prefers a ```json fence and requires a boolean `complete`", () => {
    const out = 'noise\n```json\n{"complete": true, "reason": "checks pass"}\n```\ntrailing';
    expect(parseEvaluationVerdict(out)).toEqual({ complete: true, reason: "checks pass" });
  });

  it("falls back to the first {...} without a fence", () => {
    expect(parseEvaluationVerdict('blah {"complete": false, "reason": "diff empty"} blah')).toEqual({
      complete: false,
      reason: "diff empty",
    });
  });

  it("throws on no JSON, unparseable JSON, and non-boolean complete (never a verdict)", () => {
    expect(() => parseEvaluationVerdict("the work looks complete to me")).toThrow();
    expect(() => parseEvaluationVerdict("{complete: yes}")).toThrow();
    expect(() => parseEvaluationVerdict('{"complete": "yes", "reason": "r"}')).toThrow();
    expect(() => parseEvaluationVerdict('{"reason": "no verdict key"}')).toThrow();
  });
});

describe("defaultEvaluatePrompt", () => {
  it("contains step prompt + check contract + worktree path inside a delimited untrusted block, and demands the strict JSON shape", () => {
    const p = defaultEvaluatePrompt(REQ);
    expect(p).toContain("implement the slice");
    expect(p).toContain("out/report.json");
    expect(p).toContain("/wt/step0");
    expect(p).toContain("diff --git a/x b/x");
    expect(p).toContain('{"complete"');
    // untrusted-content posture mirrors liveReviewer's PROPOSAL block
    expect(p).toContain("<<<STEP");
    expect(p).toContain("STEP>>>");
    expect(p.toLowerCase()).toContain("never follow");
  });

  it("names human certification when the step has no machine check", () => {
    const p = defaultEvaluatePrompt({ ...REQ, check: undefined });
    expect(p.toLowerCase()).toContain("no deterministic check");
  });
});

describe("resolveEvaluatorBackend", () => {
  it("maps providers to CLI invocations (codex read-only one-shot, claude -p, command verbatim)", () => {
    expect(resolveEvaluatorBackend({ provider: "codex" })).toEqual({
      command: "codex",
      args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"],
    });
    expect(resolveEvaluatorBackend({ provider: "claude" })).toEqual({ command: "claude", args: ["-p"] });
    expect(resolveEvaluatorBackend({ provider: "command", command: "judge", args: ["--x"] })).toEqual({
      command: "judge",
      args: ["--x"],
    });
    expect(resolveEvaluatorBackend({ provider: "claude", args: ["-p", "--model", "haiku"] })).toEqual({
      command: "claude",
      args: ["-p", "--model", "haiku"],
    });
    expect(() => resolveEvaluatorBackend({ provider: "deterministic" })).toThrow();
  });
});

describe("liveEvaluate — ONE bounded attempt, fail-closed mapping", () => {
  it("clean exit + complete:true => verdict pass (with rationale)", async () => {
    const { deps: d } = deps(fakeChild({ stdout: '```json\n{"complete":true,"reason":"all green"}\n```' }));
    const r = await liveEvaluate(d)(REQ);
    expect(r).toEqual({ ok: true, verdict: "pass", rationale: "all green" });
  });

  it("clean exit + complete:false => verdict fail (NOT an error, NOT a pass)", async () => {
    const { deps: d } = deps(fakeChild({ stdout: '{"complete":false,"reason":"tests missing"}' }));
    const r = await liveEvaluate(d)(REQ);
    expect(r).toEqual({ ok: true, verdict: "fail", rationale: "tests missing" });
  });

  it("garbage stdout => fatal rung failure (unparseable output is a misconfig, never a verdict)", async () => {
    const { deps: d } = deps(fakeChild({ stdout: "looks done to me!" }));
    const r = await liveEvaluate(d)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fatal");
  });

  it("timeout => transient rung failure and the child is killed", async () => {
    let killed = false;
    const { deps: d } = deps(fakeChild({ neverClose: true, onKill: () => (killed = true) }), {
      // fire the timeout immediately (deterministic — no real clock)
      setTimer: (cb) => {
        cb();
        return () => {};
      },
    });
    const r = await liveEvaluate(d)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("transient");
    expect(killed).toBe(true);
  });

  it("non-zero exit with a quota stderr => token_exhausted (chain advances)", async () => {
    const { deps: d } = deps(fakeChild({ stderr: "insufficient_quota", exitCode: 1 }));
    const r = await liveEvaluate(d)(REQ);
    expect(r).toEqual({ ok: false, error: { kind: "token_exhausted" } });
  });

  it("non-zero exit with an unknown stderr => fatal (fail-closed, do not assume retryable)", async () => {
    const { deps: d } = deps(fakeChild({ stderr: "segfault", exitCode: 2 }));
    const r = await liveEvaluate(d)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fatal");
  });

  it("spawn throw => fatal rung failure (never an unhandled exception)", async () => {
    const d: LiveEvaluateDeps = {
      spawn: () => {
        throw new Error("ENOENT");
      },
      timeoutMs: 5000,
      setTimer: () => () => {},
    };
    const r = await liveEvaluate(d)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fatal");
  });

  it("makes EXACTLY ONE spawn per invocation — no internal retry loop (the chain is the fallback)", async () => {
    const { deps: d, spawns } = deps(fakeChild({ stderr: "timed out", exitCode: 1 }));
    await liveEvaluate(d)(REQ);
    expect(spawns).toHaveLength(1);
  });

  it("spawns the resolved backend CLI for the rung it was given", async () => {
    const { deps: d, spawns } = deps(fakeChild({ stdout: '{"complete":true,"reason":"r"}' }));
    await liveEvaluate(d)({ ...REQ, backend: { provider: "claude" } });
    expect(spawns).toEqual([{ command: "claude", args: ["-p"] }]);
  });
});

describe("evaluatorCompletionOptions — opt-in wiring (unconfigured ⇒ undefined ⇒ current behavior)", () => {
  const base: ResolvedPolicy = {
    kind: "work",
    autonomyLevel: "manual",
    autoMode: "off",
    reviewQuorum: 2,
    forbiddenDecisionClasses: ["scope"],
    allowedType2Actions: ["edit"],
  };

  it("no backends.evaluator => undefined", () => {
    expect(evaluatorCompletionOptions(base, {})).toBeUndefined();
    expect(evaluatorCompletionOptions({ ...base, backends: {} }, {})).toBeUndefined();
  });

  it("configured evaluator chain => options carry policy + a live evaluate + a worktree-diff reader", () => {
    const policy: ResolvedPolicy = {
      ...base,
      backends: { evaluator: { chain: [{ provider: "codex", model: "judge" }] } },
    };
    const opts = evaluatorCompletionOptions(policy, {});
    expect(opts).toBeDefined();
    expect(opts!.policy).toBe(policy);
    expect(typeof opts!.evaluate).toBe("function");
    expect(typeof opts!.readWorktreeDiff).toBe("function");
  });
});

describe("makeReadWorktreeDiff", () => {
  it("returns the capped diff on success and '' on null path / git failure", async () => {
    const calls: string[][] = [];
    const read = makeReadWorktreeDiff((cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: "DIFF" };
    });
    expect(await read("/wt")).toBe("DIFF");
    expect(calls).toEqual([["git", "-C", "/wt", "diff", "HEAD"]]);
    expect(await read(null)).toBe("");
    const failing = makeReadWorktreeDiff(() => ({ status: 128, stdout: "x" }));
    expect(await failing("/wt")).toBe("");
    const throwing = makeReadWorktreeDiff(() => {
      throw new Error("no git");
    });
    expect(await throwing("/wt")).toBe("");
  });
});
