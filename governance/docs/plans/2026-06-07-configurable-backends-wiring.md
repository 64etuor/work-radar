# Configurable Conductor Backends + Token Fallback — Wiring Plan (DRAFT / RFC)

> Status: **DRAFT — for repeated review before implementation.** Core landed; wiring below is NOT yet built.
> Branch: `plan/autonomous-orchestration` · depends on core commit `49bacf9`.
> Owner decision recorded: **fail-closed** — a fallback degrades capability, never a gate (INVARIANT #1/#5).

## 0. Why / what this is

The autonomous harness may exhaust a model's quota mid-run, and the operator wants each
conductor role's backend (which model/CLI) to be **directly configurable**. The CORE is done:

- `backends/config.ts` — schema: providers `claude|codex|command|deterministic`, per-role
  chains, `reviewers` = array of chains (one per distinct-provider quorum member),
  `deterministic` evaluator-only (`assertProviderAllowed`).
- `backends/fallback.ts` — `classifyAttempt(exit,stderr)` → `token_exhausted|transient|fatal`;
  `runWithFallback(role, chain, attempt)` → first success or role fail-closed `Terminal`
  (`executor=stall`, `reviewer=blocked`, `evaluator=needs_human`).
- `repo/config.ts` — additive `overrides.backends` (omitted ⇒ current env defaults).

This plan covers the four WIRING slices that make those chains actually drive the conductor,
reviewer, and a new evaluator role. Each slice is independent, TDD, and committed separately.

## 1. Design principles (apply to every slice)

1. **Additive / backward-compatible.** `overrides.backends` omitted ⇒ today's behaviour
   (single env-derived executor, env reviewer models). No config change = no behaviour change.
2. **Fail-closed.** Chain exhausted (all token-out, or fatal) ⇒ the role's human-pending
   terminal. Never auto-approve / auto-complete / silent-skip.
3. **Pure core, thin wiring.** Resolution/classification stays in `backends/*` (pure, tested).
   Wiring only adapts process spawning + maps `Terminal` to an existing harness event
   (stall / decision_blocked / step-not-complete).
4. **No new env round-trips for structured config.** `policyEnv()` carries scalars; the
   `backends` object reaches consumers via the resolved policy object passed in-process
   (see §2), NOT serialized through env.

## 2. Cross-cutting plumbing (decide FIRST — affects all slices)

Today `makeConductorAdapterFromEnv(env, paths)` builds the adapter purely from env, and the MCP
server resolves policy via `resolvePolicy(config)`. `backends` is structured, so:

- **Option P1 (recommended):** pass `policy.backends` as an explicit param into the adapter
  builder and the reviewer factory (`makeConductorAdapter({ ..., backends })`,
  `liveReview({ ..., chain })`). The MCP server + `boule tick` already hold the resolved policy.
- **Option P2:** serialize `backends` to a single `BOULE_BACKENDS_JSON` env var, parse in
  `fromEnv`. Keeps the "all-from-env" shape but reintroduces an env round-trip for structured
  data (contradicts principle 4).

> **REVIEW Q-P:** P1 vs P2. P1 is cleaner but touches the adapter/reviewer signatures; P2 is
> localized but stringly. Recommendation: **P1**.

## 3. Slice 1 — codex `CODEX_HOME` hook isolation (small, do first)

**Problem (root-caused 2026-06-07):** the operator's codex is wired to OMX/cmux hooks in THREE
places — `~/.codex/config.toml` `notify`, `plugin_hooks=true`, and `~/.codex/hooks.json`. A
`codex exec` launched by the conductor inherits all three; sessions get hijacked into OMX
state-management (observed: every `codex exec` here returned empty, stuck clearing a stale
`ultrawork-state.json` marker). Per-invocation `-c plugin_hooks=false` is **insufficient**
(does not cover `hooks.json`).

**Fix:** spawn conductor codex under a **dedicated clean `CODEX_HOME`** — a minimal profile dir
with a hooks-free `config.toml` — so no operator hooks load. This also fixes codex-as-reviewer /
codex-as-evaluator (slices 3/4) and codex-as-analyst generally.

**Integration:** `conductor/adapter.ts buildSessionCommand` (codex branch). Prepend
`CODEX_HOME="${cleanProfileDir}" ` to the `codex exec …` command string. The clean profile is
created once per repo run (e.g. `<workspace>/codex-home/config.toml` with `plugin_hooks=false`,
empty `notify`, no `hooks.json`). A helper `ensureCleanCodexHome(workspace)` (idempotent mkdir +
write) on the live adapter; pure command-builder takes the resolved `codexHome` path as input so
the exact command stays test-asserted.

**TDD:**
- `buildSessionCommand("codex", …, { codexHome })` includes `CODEX_HOME="…"` before `codex exec`.
- claude branch unchanged (no CODEX_HOME).
- `ensureCleanCodexHome` writes a config with `plugin_hooks = false` and no `hooks` table (fs test).

> **REVIEW Q-1a:** profile location — under `<repo>/.boule/workspace/codex-home` (per-repo,
> gitignored) vs a shared `~/.cache/boule/codex-home`. Per-repo keeps it scoped + reapable.
> **REVIEW Q-1b:** do we also need `CODEX_HOME` isolation for the claude executor? Claude hooks
> are the work-radar app's own; conductor-spawned claude has historically closed the loop, so
> NO for now — revisit if claude sessions start self-hijacking.

## 4. Slice 2 — executor chain

**Now:** executor kind is a single value (`BOULE_CONDUCTOR_EXECUTOR=claude|codex`), no fallback.

**Target:** the conductor tries `policy.backends.executor.chain` in order via `runWithFallback`.
Each attempt = spawn the session for that provider (claude/codex/command) and watch for closure.
- token_exhausted / transient on a provider ⇒ advance to next backend.
- chain exhausted ⇒ `Terminal{executor:stall}` ⇒ emit the existing **stall** surfacing (the
  session-observer stall path) so the step waits for a human. No silent skip.

**Integration:** `conductor/fromEnv.ts` + `conductor/adapter.ts` (executor selection currently
hardcoded/env). The adapter's "spawn + detect closure" becomes the `attempt` fn handed to
`runWithFallback("executor", chain, attempt)`.

**TDD (stub adapter):** chain `[codex, claude]`, codex attempt returns token_exhausted ⇒ claude
attempt runs and closes; chain all-exhausted ⇒ stall terminal recorded; single-element legacy
config (no `backends`) ⇒ identical to today.

> **REVIEW Q-2:** "transient" classification on an executor SPAWN — should a transient spawn
> failure advance to the next backend (capability loss) or retry the SAME backend first? Lean:
> bounded per-backend retry (existing backoff) THEN advance. Confirm retry budget.

## 5. Slice 3 — reviewer chain (quorum)

**Now:** `liveReview({ command, buildArgs, retry })` builds one ReviewFn; quorum runs distinct
binaries via `BOULE_REVIEWER_MODELS`.

**Target:** each quorum member = one `backends.reviewers[i].chain`. For each member,
`runWithFallback("reviewer", chain, attempt)` picks the first backend with tokens. The quorum
needs ≥`reviewQuorum` DISTINCT providers to return a verdict.
- A member whose chain is exhausted contributes NO verdict.
- If fewer than `reviewQuorum` distinct providers produced a verdict ⇒ `Terminal{reviewer:blocked}`
  ⇒ the decision stays `decision_blocked` (human). **Never auto-approve, never silently lower
  the quorum.** (codex `CODEX_HOME` from slice 1 applies to codex reviewers.)

**Integration:** `decision/liveReviewer.ts` (chain per member) + the quorum derivation in
`decision/reviewer.ts` (count distinct providers that actually returned, not just configured).

**TDD:** quorum=2, members `[claude-chain, codex-chain]`, codex token-out + its fallback also
token-out ⇒ only 1 distinct verdict ⇒ blocked (NOT approved). Both succeed ⇒ approve path.
Distinct-provider counting (two backends that resolve to the same provider don't count twice).

> **REVIEW Q-3:** is "distinct provider" the right quorum key, or "distinct model id"? Current
> quorum uses `normalizeModelId(actor)`. A chain can fall back claude→codex, changing the actual
> reviewing model — quorum must count what ACTUALLY reviewed, not the configured head. Align with
> existing `deriveDecisionState` distinct-model counting.

## 6. Slice 4 — evaluator as completion authority (largest; live-loop)

**This is the high-value fix** (OMC autoresearch evaluator-contract pattern). It directly fixes
the L3 codex ~60% `complete_task` adherence: today the conductor trusts the executor agent to
call `complete_task` over MCP. Instead:

**Target:** after the executor session exits, the conductor runs `policy.backends.evaluator.chain`
to DECIDE completion. The agent's self-reported `complete_task` (if it came) is ONE input; the
evaluator is the authority.
- Evaluator backend judges "did this step satisfy its acceptance criteria?" against the
  step-prompt + the worktree diff. Structured verdict (pass/fail + rationale), like the reviewer.
- Chain fallback as usual; **last rung = `deterministic`**: a non-LLM check (the step may declare
  a check command / expected artifact; `deterministic` runs it — exit 0 / artifact present ⇒ pass).
- Chain exhausted / inconclusive ⇒ `Terminal{evaluator:needs_human}` ⇒ step NOT marked complete;
  surfaced for a human. **Never auto-complete on no-signal.**

**Integration:** the conductor's post-session completion path (where `task_completed` is currently
folded from the executor's MCP call). Add an evaluator gate: `task_completed` is emitted by the
CONDUCTOR after the evaluator passes — not directly by the executor session. (Executor's MCP
`complete_task` becomes a *signal/hint* event, not the authority.)

**TDD (stub):** executor exits WITHOUT calling complete_task + evaluator passes ⇒ step completes
(the codex-adherence fix). Evaluator chain exhausted ⇒ needs_human, step stays open. deterministic
last-rung pass ⇒ completes with no tokens.

**LIVE smoke (operator):** a real step where codex finishes work but never calls complete_task →
evaluator closes the loop. Compare to today's hang.

> **REVIEW Q-4a:** what does the deterministic evaluator actually check? Options: (i) a per-step
> declared `check` command in the plan-step schema (needs a schema field), (ii) "worktree has a
> non-empty diff", (iii) "the step's named artifact exists". (i) is most correct but adds a plan
> field. **REVIEW Q-4b:** do we KEEP honoring a real executor `complete_task` as a fast-path
> (skip evaluator when the agent self-reports AND the evaluator is configured `trust_self_report`)
> or ALWAYS evaluate? Always-evaluate is stricter + simpler; fast-path saves tokens. Lean:
> always-evaluate, with deterministic as the cheap rung. **REVIEW Q-4c:** does forbidding the
> executor from authoritatively self-completing interact with INVARIANT #1? (It strengthens it —
> the executor already can't self-APPROVE; now it can't self-CERTIFY completion either.)

> **RECONCILIATION — a stopgap for THIS gap already shipped on dev (`b125664`, the dev-followups
> #3 track; see memory `work-radar-dev-followups-1234`).** That commit appends, in
> `conductor/adapter.ts buildSessionCommand` (codex branch only), `&& node <cliEntrypoint>
> complete-task --workspace W --task T` to the `codex exec` launch: on CLEAN codex exit it shells
> the new guarded `boule complete-task` (→ `completeTask`, which REFUSES if the task isn't active or
> has an open `decision_blocked`). It closes the loop today, but it writes `task_completed` **from
> the executor side** — exactly the authority this slice demotes. So the wrapper and this evaluator
> gate **cannot both stand as-is**: if the wrapper runs first, the task is `done` before the
> evaluator judges (the gate is bypassed). The CORE (`49bacf9`) does NOT collide (it adds
> `backends/` + `repo/config.ts`; the wrapper is in `conductor/`), so this is a design-authority
> overlap, not a merge conflict — but Slice 4's wiring lands in the same `conductor/` completion path.
>
> **Agreement (settles Q-4b as *always-evaluate*):**
> 1. **Demote, don't keep.** When this slice lands, change the codex wrapper from `&& boule
>    complete-task` (authoritative) to `&& boule report-exit` — a verdict-free *hint* event meaning
>    "executor exited clean" — and make the CONDUCTOR's post-evaluator path the SOLE writer of
>    `task_completed`. The wrapper's clean-exit then becomes the evaluator's *trigger signal*, not a
>    fast-path bypass (keeps Q-4c's "executor can't self-certify completion" intact).
> 2. **Reuse the plumbing.** The wrapper already proved the safe seam — shell a `boule` subcommand on
>    clean codex exit via install-relative `cliEntrypoint()`. The hint event reuses that exact seam
>    (rename the subcommand; write a hint, not `task_completed`).
> 3. **Keep the prompt hardening.** buildPrompt's "## Required final action: complete_task" stays — a
>    real model `complete_task` remains a useful *hint* input to the evaluator.
> 4. **Until this slice lands, the wrapper STAYS** — it is the only thing closing the codex loop on
>    dev today; removing it before the evaluator exists re-opens the ~60% adherence hang.
>
> Net: wrapper = interim stopgap (on dev now); evaluator = destination authority. **This slice's
> integration task list MUST include "retire/demote the `b125664` exit-code wrapper to a hint event."**

## 7. Sequencing & estimate

1. Slice 1 (CODEX_HOME) — small, unblocks codex backends. ~1 commit.
2. Plumbing §2 P1 — small, prerequisite for 2/3/4. ~1 commit (can fold into slice 2).
3. Slice 2 (executor chain) — medium. ~1 commit.
4. Slice 3 (reviewer chain) — medium. ~1 commit.
5. Slice 4 (evaluator authority) — large, live-loop, needs operator smoke. ~1–2 commits.

## 8. Risks / invariants checklist (verify each slice in a separate reviewer pass)

- [ ] No path lets a token-exhausted chain auto-approve (reviewer) or auto-complete (evaluator)
      or silent-skip (executor). All exhaustion ⇒ human-pending terminal.
- [ ] `deterministic` cannot appear as a reviewer/executor backend (`assertProviderAllowed`).
- [ ] Quorum counts providers/models that ACTUALLY reviewed, never the configured head.
- [ ] Omitting `overrides.backends` reproduces today's behaviour exactly (golden test).
- [ ] codex backends always spawn under the clean `CODEX_HOME` (no operator-hook hijack).
- [ ] Executor still cannot self-accept (verdict tools structurally absent) — unchanged.
- [ ] Bounded: every chain is finite; no daemon/infinite retry introduced.

## 9. Open decisions to settle across review passes (index)

Q-P (plumbing P1/P2) · Q-1a/1b (codex home location, claude isolation) · Q-2 (executor transient
retry budget) · Q-3 (quorum key = provider vs model) · Q-4a/4b/4c (deterministic check source,
always-evaluate vs self-report fast-path, INVARIANT #1 interaction).
