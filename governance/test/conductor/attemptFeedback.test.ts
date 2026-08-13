import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectPreviousAttemptFeedback,
  previousAttemptLines,
  FEEDBACK_DIGEST_CAP,
} from "../../src/conductor/attemptFeedback.js";
import type { GovEvent } from "../../src/event/event.js";
import { generateId } from "../../src/event/id.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan, redispatchExecutorAttempt } from "../../src/conductor/handlers.js";
import { recordExecutorAttempt } from "../../src/task/handlers.js";
import { stubAdapter, type ConductorAdapter } from "../../src/conductor/adapter.js";
import type { ResolvedPolicy } from "../../src/repo/config.js";

const TASK = "evt_task_1";

function finishedEvent(body: unknown, sec: number, taskId = TASK): GovEvent {
  const when = new Date(Date.UTC(2026, 5, 12, 10, 0, sec));
  return {
    frontmatter: {
      id: generateId("evt", when, 0.5),
      type: "executor_attempt_finished",
      source: "agent_run",
      actor: "executor",
      tags: ["task", "attempt-hint"],
      related_to: [taskId],
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("projectPreviousAttemptFeedback (P4c — failure telemetry → next prompt)", () => {
  it("no attempts / only clean exits ⇒ null (first attempts stay byte-identical)", () => {
    expect(projectPreviousAttemptFeedback([], TASK)).toBeNull();
    const clean = [finishedEvent({ attemptIndex: 0, exitCode: 0, launched: true, worktreeDirty: false }, 0)];
    expect(projectPreviousAttemptFeedback(clean, TASK)).toBeNull();
  });

  it("projects count + last exit code + digest from the highest failed attemptIndex", () => {
    const events = [
      finishedEvent({ attemptIndex: 0, exitCode: 2, stderrDigest: "older failure" }, 0),
      finishedEvent({ attemptIndex: 1, exitCode: 137, stderrDigest: "newest failure" }, 1),
      finishedEvent({ attemptIndex: 9, exitCode: 1, stderrDigest: "other task" }, 2, "evt_other"),
    ];
    expect(projectPreviousAttemptFeedback(events, TASK)).toEqual({
      failedAttemptCount: 2,
      lastExitCode: 137,
      lastStderrDigest: "newest failure",
    });
  });

  it("caps the digest and skips garbage bodies without throwing", () => {
    const events = [
      finishedEvent("{ not json", 0),
      finishedEvent({ attemptIndex: 1, exitCode: "weird" }, 1),
      finishedEvent({ attemptIndex: 2, exitCode: 1, stderrDigest: "x".repeat(2000) }, 2),
    ];
    const fb = projectPreviousAttemptFeedback(events, TASK)!;
    expect(fb.failedAttemptCount).toBe(1);
    expect(fb.lastStderrDigest).toHaveLength(FEEDBACK_DIGEST_CAP);
  });

  it("previousAttemptLines renders the section with digest marked as DATA", () => {
    const lines = previousAttemptLines({
      failedAttemptCount: 2,
      lastExitCode: 137,
      lastStderrDigest: "boom",
    }).join("\n");
    expect(lines).toContain("## Previous attempt");
    expect(lines).toContain("code 137");
    expect(lines).toContain("boom");
    expect(lines).toContain("DATA");
    expect(lines.toLowerCase()).toContain("change your approach");
  });
});

// ── Integration: the conductor injects the section into the SECOND attempt's prompt only ──

describe("redispatch prompt failure feedback (P4c integration)", () => {
  let ws: string;
  const at = (s: number) => new Date(Date.UTC(2026, 5, 12, 12, 0, s));

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "boule-feedback-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  function capturingAdapter(prompts: string[]): ConductorAdapter {
    return {
      ...stubAdapter,
      async writeEnvelopeFile(_wt, _envelope, prompt) {
        prompts.push(prompt);
      },
    };
  }

  const policy: ResolvedPolicy = {
    kind: "personal",
    autonomyLevel: "dispatch",
    autoMode: "type2",
    reviewQuorum: 1,
    forbiddenDecisionClasses: ["scope"],
    allowedType2Actions: ["edit"],
    backends: {
      executor: {
        chain: [
          { provider: "codex" },
          { provider: "claude" },
          { provider: "command", command: "codex", model: "fallback" },
        ],
      },
    },
  };
  const viability = {
    commandExists: () => true,
    codexAuthAvailable: () => true,
    ensureCleanCodexHome: () => true,
  };

  it("first attempt has NO '## Previous attempt'; the token-exhausted retry carries digest + exit code", async () => {
    const prompts: string[] = [];
    const deps = { adapter: capturingAdapter(prompts), policy, viability };
    const { planId } = await proposePlan(ws, { intent: "I", steps: ["do the slice"] }, at(0), 0.1);
    await acceptPlan(ws, { planId }, at(1), 0.2);
    const first = await conductPlan(ws, { planId }, deps, at(10), 0.3);
    expect(first.ok).toBe(true);
    expect(prompts[0]).not.toContain("## Previous attempt");

    // the supervised wrapper records the failed attempt (exit 1 + token-exhaustion stderr digest)
    await recordExecutorAttempt(
      ws,
      {
        taskId: first.advanced!.taskId,
        attemptIndex: 0,
        exitCode: 1,
        launched: true,
        worktreeDirty: false,
        stderrDigest: "rate limit exceeded: usage cap reached for model",
      },
      at(20),
      0.4,
    );

    const retry = await redispatchExecutorAttempt(ws, { planId }, deps, at(30), 0.5);
    expect(retry.kind).toBe("advanced");
    expect(prompts).toHaveLength(2);
    const retryPrompt = prompts[1]!;
    expect(retryPrompt).toContain("## Previous attempt");
    expect(retryPrompt).toContain("code 1");
    expect(retryPrompt).toContain("rate limit exceeded: usage cap reached for model");
    expect(retryPrompt.toLowerCase()).toContain("change your approach");
    // and the feedback is additive — the standard contract sections survive
    expect(retryPrompt).toContain("## Autonomy envelope");
    expect(retryPrompt).toContain("## Completion certification");
    // observability stayed observability: no decision_* events were minted anywhere in this flow
    const types = (await readAllEvents(ws)).map((e) => e.frontmatter.type);
    expect(types.filter((t) => t.startsWith("decision_"))).toEqual([]);
  });
});
