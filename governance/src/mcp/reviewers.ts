import type { BackendChain, BackendSpec } from "../backends/config.ts";
import { backendIdentity } from "../backends/identity.ts";
import type { ChildLike, LiveReviewDeps, SpawnLike } from "../decision/liveReviewer.ts";
import { defaultReviewPrompt, liveReview, liveReviewChain, parseVerdict } from "../decision/liveReviewer.ts";
import type { ReviewFn, ReviewerEntry } from "../decision/reviewer.ts";
import { parseReviewerArgs, parseReviewerModels, resolveReviewerCommand } from "./config.ts";

type Env = Record<string, string | undefined>;

export interface BuildReviewerEntriesInput {
  env: Env;
  fallbackReviewerModel: string;
  live: boolean;
  reviewerChains?: BackendChain[];
  spawn?: SpawnLike;
  log?: (line: string) => void;
}

function placeholderReviewFor(model: string): ReviewFn {
  return async (req) => ({
    verdict: "concerns",
    rationale: `[placeholder reviewer — set BOULE_REVIEWER_MODE=live to wire a real model] reviewed "${req.title}".`,
    reviewerModel: model,
  });
}

function reviewerModelForBackend(spec: BackendSpec): string {
  if (spec.model) return spec.model;
  if (spec.provider === "command") return spec.command ?? "command";
  return spec.provider;
}

function resolveBackend(spec: BackendSpec): { command: string; args: string[]; reviewerModel: string } {
  if (spec.provider === "command") {
    return { command: spec.command ?? "command", args: spec.args ?? [], reviewerModel: reviewerModelForBackend(spec) };
  }
  return {
    command: spec.provider,
    args: spec.args ?? (spec.provider === "codex" ? parseReviewerArgs(undefined) : []),
    reviewerModel: reviewerModelForBackend(spec),
  };
}

function liveDeps(
  input: BuildReviewerEntriesInput,
  command: string,
  args: string[],
  reviewerModel: string,
): LiveReviewDeps {
  const spawn =
    input.spawn ??
    (() => {
      throw new Error("live reviewer spawn is not configured");
    });
  return {
    spawn,
    command,
    buildArgs: () => args,
    buildPrompt: defaultReviewPrompt,
    reviewerModel,
    parse: parseVerdict,
    timeoutMs: Number(input.env.BOULE_REVIEWER_TIMEOUT_MS ?? 120000),
    maxAttempts: Number(input.env.BOULE_REVIEWER_MAX_ATTEMPTS ?? 2),
    backoffMs: 500,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (cb, ms) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
    rand: Math.random,
    log: input.log,
  };
}

export function buildReviewerEntries(input: BuildReviewerEntriesInput): ReviewerEntry[] {
  if (input.reviewerChains) {
    return input.reviewerChains.map((member, i) => {
      const head = member.chain[0];
      const model = `reviewer-chain-${i + 1}:${backendIdentity(head)}`;
      return {
        model,
        fn: liveReviewChain({
          ...liveDeps(input, "", [], model),
          chain: member.chain,
          resolveBackend,
        }),
      };
    });
  }

  const models = parseReviewerModels(input.env.BOULE_REVIEWER_MODELS, input.fallbackReviewerModel);
  return models.map((model) => {
    if (!input.live) return { model, fn: placeholderReviewFor(model) };
    const { command, args } = resolveReviewerCommand(model, input.env);
    return { model, fn: liveReview(liveDeps(input, command, args, model)) };
  });
}

export type { ChildLike };
