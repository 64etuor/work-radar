---
adr-id: ADR-0009
status: accepted
date: 2026-06-07
decision-makers: [Boule governance track]
tags: [governance, orchestrator, conductor, executor, codex, live, automation]
supersedes:
---

# 0009. Live Autonomy — Codex Peer Executor, Preflight/Readiness Gates, and the Live-vs-Test Node Split

## Context and Problem Statement

**Scope**: the Boule governance sidecar (`governance/`), the Conductor (Phase C), Observer
(Phase D), and dispatch (Phase I) live path.

Boule v3 Phases A–I are built and unit-tested against **stub adapters** on `dev`, but the
**live** autonomous loop (`BOULE_CONDUCTOR_MODE=live` + `BOULE_AUTO_MODE=type2` + a real cmux
session that does work and reports `task_completed` back) had **never run end-to-end**, and the
Conductor could spawn **`claude` only**. The owner's goal is: write a spec/plan → agents
autonomously create cmux workspaces/sessions using **Claude AND Codex** → execute. This ADR records
the decisions taken in the 2026-06-07 live-autonomy master plan (L0–L6).

## Decision Drivers

- Honor "Codex 활용": the Conductor must be able to dispatch codex sessions, not just claude.
- Keep INVARIANT #1 intact: spawned sessions must not be able to self-resolve decisions.
- Make "safe to run unattended" an explicit, testable gate — not a vibe.
- Keep the deterministic core unit-testable; live steps are operator/cmux-run.

## Decisions

### 1. Codex is a peer executor on the SAME substrate (run-level selection)

- `ExecutorKind = "claude" | "codex"` is a field on the autonomy envelope (audited, tamper-evident
  via the envelope hash). `conduct_plan` / `auto_dispatch` read a **run-level**
  `BOULE_CONDUCTOR_EXECUTOR` (fail-closed to `claude`). Per-step executor is a deferred follow-up
  (needs a plan-step schema field).
- Both executors share the worktree + envelope + cmux substrate. The pure `buildSessionCommand`
  branches the invocation only:
  - **claude**: scoped `.boule/mcp.json` (`--mcp-config` + `--strict-mcp-config`) plus an explicit
    verdict-tool `--disallowedTools` denylist (defense-in-depth).
  - **codex**: `codex exec --sandbox workspace-write` (writes confined to the worktree cwd, **never
    `danger-full-access`**, per the codex-worktree-runner skill), attaching the **same**
    executor-role governance MCP via `-c mcp_servers.*`. Codex has no per-server denylist — the
    server's structural verdict-tool omission is the guarantee.
- Loop closure is identical for both: the session calls `complete_task` / `escalate` over the
  executor-role MCP.

### 2. Verdict isolation stays STRUCTURAL (not posture, not re-checked at runtime)

A Conductor-spawned session runs the governance MCP with `BOULE_SESSION_ROLE=executor`, under which
`server.ts` does **not register** the verdict tools (`approve`/`reject`/`choose`/`accept_plan`/
`accept_spec`) — `SESSION_ALLOWS_VERDICTS = false`. So a spawned claude **or** codex session can
escalate and drive its own task but **cannot** resolve a decision. Type-1 ambiguity → the session
emits `decision_blocked` → the plan halts forever (no timeout/default; ADR-0008). This is why the
readiness gate does **not** re-check verdict isolation: it is structural, covered by negative tests.

### 3. Preflight (L0) and Readiness (L4) are separate gates

- **Preflight** (read-only `preflight` tool): can the loop _physically_ run here? Required: cmux
  socket + cmux binary + git worktree. The live-mode flags are **advisory** (so preflight is useful
  _before_ arming them).
- **Readiness** (read-only `readiness` tool): is it _safe to run unattended right now_? Promotes the
  flags to **required** (conductor live, **observer live**, auto=type2) and refuses when any task is
  **stalled**. Observer-live is the load-bearing guard: running unattended without crash detection
  is the dangerous combination, because a crashed session leaves an in-flight task silently stuck.
- **Stall surfacing** (L2, read-only `stalled_tasks`): `deriveStalledTasks` joins the task and
  session projections to surface an active/blocked task whose bound session crashed. Read-only;
  resolution stays human.

### 4. Autonomy boundary unchanged — anemic auto

"Agents proceed autonomously" means _after_ `accept_plan` (a human gate, `actor:"user"`). The plan
acceptance gate is retained; full no-human-in-the-loop autonomy is deliberately **not** adopted
(INVARIANT #1; v3 design §4 "delay is a feature").

### 5. Node version split (operational)

The **vitest suite** runs on **node 20** (CI pin); esbuild transforms TS, so no runtime flag is
needed. The **runtime MCP server** runs `node --experimental-strip-types`, which requires **node
22+** (the flag does not exist on node 20). Operators must run the live loop / server on node 22+.

## Consequences

- The Conductor dispatches claude or codex on one substrate; "Codex 활용" is satisfied for
  orchestration (the in-app `agent.rs` codex job runner remains a separate track, out of scope).
- Two read-only gates (`preflight`, `readiness`) + `stalled_tasks` give operators a deterministic
  go/no-go and stall visibility before/while running unattended.
- **Open / live-gated:** the codex MCP round-trip (`complete_task` _from_ codex) is asserted
  structurally (command construction) but needs a live smoke (runbook §5) to confirm end-to-end;
  the full L1/L2/L3 live loop and the L5 Control Room GUI smoke remain operator/cmux-run.
- Codex `workspace-write` confines filesystem writes to the worktree but does not, by itself,
  disable network; network/external-write hardening for fully unattended codex runs is a follow-up
  (the External Action Gate remains the sanctioned path for real-world writes).

## References

- `governance/docs/plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` (L0–L6)
- `governance/docs/runbooks/2026-06-07-live-loop-smoke.md`
- `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` (§4, §7 Phase C/I)
- ADR-0008 (dispatch cannot write decisions)
