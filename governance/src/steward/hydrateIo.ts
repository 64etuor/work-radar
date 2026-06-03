import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveHandoffState } from "../handoff/handoff.ts";
import { canConsume } from "../handoff/guards.ts";
import { consumeHandoff } from "../handoff/handlers.ts";
import { projectPlans } from "../plan/project.ts";
import { projectTasks } from "../task/project.ts";
import { assembleBundle, type GitSummary, type IndexNeighbor, type HydrationBundle } from "./hydrate.ts";

/** Injected non-deterministic edges (git, the Phase F index, the principles index). Tests stub these;
 *  the MCP boundary wires real `git` + graphStore.getNeighbors + buildIndex. */
export interface HydrateDeps {
  gitSummary: () => Promise<GitSummary>;
  readNeighbors: (nodeId: string) => Promise<IndexNeighbor[]>;
  principles: () => Promise<string[]>;
}

export interface HydrateResult {
  ok: boolean;
  reason: string;
  bundle?: HydrationBundle;
  markdown?: string;
  eventId?: string;
}

/** hydrate — load a PENDING handoff, assemble the bundle from already-read inputs, emit ONE
 *  handoff_consumed, return { bundle, markdown }. Fail-closed if the handoff is not pending. The
 *  pure assembler does the laundering-prevention; this shell only does I/O at the edges. */
export async function hydrate(
  workspaceDir: string,
  input: { handoffId: string },
  deps: HydrateDeps,
  now: Date,
  rand: number,
): Promise<HydrateResult> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.handoffId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "handoff_requested")
    return { ok: false, reason: `unknown handoff: ${input.handoffId}` };
  const state = deriveHandoffState(grp.proposal, grp.related);
  const gate = canConsume(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const latestDraft = grp.related
    .filter((e) => e.frontmatter.type === "handoff_drafted")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))
    .at(-1);

  const plans = projectPlans(all);
  const tasks = projectTasks(all);
  const activePlan = plans.find((p) => p.phase === "active");
  const currentTask = tasks.find((t) => t.phase === "active" || t.phase === "blocked");
  const neighbors = state.sessionId ? await deps.readNeighbors(`session:${state.sessionId}`) : [];

  const { bundle, markdown } = assembleBundle({
    handoff: state,
    handoffBody: latestDraft?.body ?? "",
    log: all,
    principles: await deps.principles(),
    spec: activePlan ? `plan ${activePlan.planId}` : "(no active plan)",
    activePlan: activePlan ? `${activePlan.planId} [${activePlan.phase}] ${activePlan.title}` : "(none)",
    currentTask: currentTask ? `${currentTask.taskId} [${currentTask.phase}] ${currentTask.title}` : "(none)",
    indexNeighbors: neighbors,
    gitSummary: await deps.gitSummary(),
    // PLACEHOLDER envelope (design §0.2/§4.2): sourcing the real per-session AutonomyEnvelope
    // (.boule/envelope.json / a session_spawned fold) is DEFERRED. A placeholder still satisfies the
    // laundering ban (no bundle field can EXPAND authority); it does not yet FORWARD prior constraints.
    autonomyEnvelope: "(placeholder — real per-session envelope carry deferred; see design §0.2)",
  });

  const consumed = await consumeHandoff(workspaceDir, { handoffId: input.handoffId }, now, rand);
  if (!consumed.ok) return { ok: false, reason: consumed.reason };
  return { ok: true, reason: "", bundle, markdown, eventId: consumed.eventId };
}
