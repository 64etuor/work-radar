# Boule v2 First Slice — 1B (Python fabric bridge) Implementation Plan

> **Status:** ✅ DONE — 아래 step 체크박스는 back-fill 안 함(이 트랙 관행). 완료 증거 정본: [INDEX](../INDEX.md) + `docs/decisions.md` breadcrumb.
>
> 체크박스 = 빌드 시점 기록(사람용). 런타임 task 상태는 이벤트 파생(오케스트레이터 정본) — `governance/workspace/HARNESS.md` §3.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the v2 escalation round-trip across the process boundary — a `decision_blocked` event in `BOULE_WORKSPACE` reaches a Telegram topic on the phone, and a human tap routes back through the gated MCP `choose` to land a `decision_chosen` — by adding a bounded outbound adapter + an inbound interceptor to the user's live `~/.hermes` fabric, with Python never writing a verdict event.

**Architecture:** Two independent mechanisms (build/test separately). **Outbound** = a bounded Python `sync-once` that reads pending escalations from the TS sidecar (via a new read-only `pending_escalations` MCP command — no markdown re-parsing in Python), builds a NormalizedEvent, and pipes it into the existing `~/.claude/hooks/cmux_notify_telegram.py` sink (which owns the only network call). **Inbound** = a `try_governance_reply` guard prepended at `telegram.py:~4963` ahead of `try_forward`: a BOULE-prefixed exact-match reply invokes MCP `choose` via a bounded one-shot MCP client and is consumed (not forwarded); anything else falls through unchanged. Python's ONLY write-path is the gated MCP `choose` (INVARIANT #1).

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), vitest 2, MCP SDK 1.29 (Client + `StdioClientTransport`), Python 3.13 (stdlib only — `json`/`subprocess`/`pathlib`/`urllib`), pytest.

**Spec:** `governance/docs/design/2026-06-01-ssot-governance-harness-escalation-roundtrip-slice1.md` — **read the 2026-06-02 Addendum (§A1–A4)**: it is the binding current-fabric reference (outbound is now a NormalizedEvent; sink lives at `~/.claude/hooks/`; choose = MCP stdio one-shot; tap = text-reply token; live smoke = user-run).

---

## Zone map (READ FIRST — which tasks touch the live fabric)

| Task | Zone                                           | Touches live `~/.hermes`?                                                 | Runnable headless by an agent? |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| 1    | repo `governance/src`                          | no                                                                        | yes                            |
| 2    | repo `governance/bridge`                       | no                                                                        | yes                            |
| 3    | repo `governance/bridge`                       | no (executes the sink in `--dry-run` only — prints, no send, no mutation) | yes                            |
| 4    | **LIVE** `~/.hermes/.../gateway`               | **YES — daily-driver fabric**                                             | test yes; install gated        |
| 5    | **LIVE** `~/.hermes/.../platforms/telegram.py` | **YES — daily-driver fabric**                                             | install gated                  |
| 6    | repo docs + verify                             | no                                                                        | yes                            |
| 7    | **LIVE** — user-run phone smoke + critic       | **YES**                                                                   | no (user runs)                 |

**Gate:** Tasks 1–3 + 6 are repo-only and proceed after this plan is approved. Tasks 4–5 edit the user's live Telegram/cmux fabric — apply them ONLY after the user re-confirms at the Task 4 gate. Task 7 is executed by the user from the runbook; the agent verifies the resulting events. Commit only — **do NOT push** (Boule parked).

---

## Conventions (footguns — read before coding)

- Runtime `governance/src/**` imports use the **`.ts`** extension; test files import src with the **`.js`** extension (vitest maps `.js`→`.ts`). Getting this backwards breaks the run.
- TS commands run from `governance/`: tests `pnpm test`, typecheck `pnpm exec tsc --noEmit`.
- `src/mcp/server.ts` connects stdio on import → NEVER imported by tests; test the logic below it. The `bridge/boule-mcp.mjs` one-shot client is the ONLY thing that spawns the server.
- The MCP server resolves its events dir as `BOULE_WORKSPACE ?? governance/workspace` (`server.ts:33`). Outbound (read) and inbound (`choose`) MUST use the same `BOULE_WORKSPACE`. This plan pins **one** value and threads it everywhere.
- Python: stdlib only (the fabric ships no third-party deps in these scripts). Tests use `pytest` (already used across `~/.hermes/.../tests` and `~/.claude/hooks/tests`).
- Export `PATH="$HOME/.cargo/bin:$PATH"` before any `git commit` (husky pre-commit runs cargo fmt). FE/markdown is auto-prettied by lint-staged.
- Commit only; **do NOT push** (Boule parked).

---

## File Structure

**Repo (headless, safe):**

- `governance/src/escalate/pending.ts` (CREATE) — `pendingEscalations(workspace)`: returns unresolved `decision_blocked` escalations as structured JSON (decisionId, blockedEventId, question, options w/ reply tokens, sessionId). Reuses `readAllEvents`/`eventsForDecision`/`deriveDecisionState` — token/format knowledge stays in TS (SSOT).
- `governance/src/mcp/server.ts` (MODIFY) — register read-only `pending_escalations` tool.
- `governance/bridge/boule-mcp.mjs` (CREATE) — generic one-shot MCP client: spawns the server via `StdioClientTransport`, calls one tool, prints the result text, exits. Used by the Python inbound interceptor AND the smoke runbook.
- `governance/bridge/boule_sync_telegram.py` (CREATE) — bounded `sync-once` outbound adapter (the only NEW network-adjacent Boule code; it pipes to the sink, imports no network client).
- `governance/.gitignore` (MODIFY/CREATE) — ignore `workspace/.bridge/` (sent-markers are runtime state).
- Tests: `governance/test/escalate/pending.test.ts`, `governance/bridge/test_boule_sync_telegram.py`.

**Live fabric (gated):**

- `~/.hermes/hermes-agent/gateway/governance_bridge.py` (CREATE) — `classify_reply(text)` (pure) + `try_governance_reply(text, *, choose=…)` (shells `boule-mcp.mjs choose` by default; `choose` injectable for tests).
- `~/.hermes/hermes-agent/gateway/platforms/telegram.py` (MODIFY ~`:4963`) — prepend a 6-line guard ahead of the existing `try_forward` block.
- `~/.hermes/hermes-agent/tests/gateway/test_governance_bridge.py` (CREATE) — the one characterization test (3 branches).

---

## Task 1: TS read-only `pendingEscalations` (repo, headless)

**Files:**

- Create: `governance/src/escalate/pending.ts`
- Test: `governance/test/escalate/pending.test.ts`

- [ ] **Step 1: Write the failing test**

Create `governance/test/escalate/pending.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption } from "../../src/decision/handlers.js";
import { pendingEscalations } from "../../src/escalate/pending.js";
import { parseToken } from "../../src/escalate/token.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-pending-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("pendingEscalations", () => {
  it("lists an unresolved escalation with bound reply tokens", async () => {
    const esc = await escalate(
      ws,
      {
        question: "DB: sqlite or postgres?",
        options: [{ label: "sqlite" }, { label: "postgres" }],
      },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    const pending = await pendingEscalations(ws);
    expect(pending).toHaveLength(1);
    const p = pending[0];
    expect(p.decisionId).toBe(esc.decisionId);
    expect(p.blockedEventId).toBe(esc.blockedEventId);
    expect(p.question).toBe("DB: sqlite or postgres?");
    expect(p.options.map((o) => o.token)).toEqual(["opt0", "opt1"]);
    // each reply token is bound to BOTH ids
    const parsed = parseToken(p.options[0].reply);
    expect(parsed!.decisionId).toBe(esc.decisionId);
    expect(parsed!.blockedEventId).toBe(esc.blockedEventId);
  });

  it("omits an escalation once it is chosen (no re-send on next sync)", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      new Date("2026-06-02T10:05:00Z"),
      0.5,
    );
    expect(await pendingEscalations(ws)).toHaveLength(0);
  });

  it("surfaces the escalating session id (null for a manual/user escalate)", async () => {
    await escalate(
      ws,
      { question: "manual?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    expect((await pendingEscalations(ws))[0].sessionId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `governance/`): `pnpm test -- pending`
Expected: FAIL — `Cannot find module ".../src/escalate/pending.ts"`.

- [ ] **Step 3: Write the implementation**

Create `governance/src/escalate/pending.ts`:

```ts
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveDecisionState } from "../decision/decision.ts";
import type { GovEvent } from "../event/event.ts";

export interface PendingOption {
  token: string;
  label: string;
  reply: string;
}
export interface PendingEscalation {
  decisionId: string;
  blockedEventId: string;
  question: string;
  options: PendingOption[];
  /** The escalating cmux session id, or null for a manual/user escalate. */
  sessionId: string | null;
  agentRecommendation: string | null;
}

/** Read-only: every decision_blocked whose decision is NOT yet terminal (no verdict),
 *  rendered with its bound reply tokens. The Python outbound adapter consumes this so the
 *  token format + resolution logic live only here (SSOT); Python parses no markdown. */
export async function pendingEscalations(workspaceDir: string): Promise<PendingEscalation[]> {
  const all = await readAllEvents(workspaceDir);
  const out: PendingEscalation[] = [];
  for (const b of all) {
    if (b.frontmatter.type !== "decision_blocked") continue;
    const decisionId = (b.frontmatter.related_to ?? [])[0];
    if (!decisionId) continue;
    const grp = eventsForDecision(all, decisionId);
    if (!grp.proposal) continue;
    const state = deriveDecisionState(grp.proposal, grp.related);
    if (state.verdict) continue; // already chosen/approved/rejected → not pending
    let body: {
      question?: string;
      options?: PendingOption[];
      agent_recommendation?: string | null;
    };
    try {
      body = JSON.parse(b.body);
    } catch {
      continue; // a malformed blocked body is not a routable escalation
    }
    const actor = b.frontmatter.actor;
    out.push({
      decisionId,
      blockedEventId: b.frontmatter.id,
      question: body.question ?? "",
      options: Array.isArray(body.options) ? body.options : [],
      sessionId: actor && actor !== "user" ? actor : null,
      agentRecommendation: body.agent_recommendation ?? null,
    });
  }
  return out;
}
```

> Note: confirm `eventsForDecision` returns `{ proposal, related }` and `deriveDecisionState(proposal, related)` exists with that shape (used identically in `test/escalate/escalate.test.ts` and the 1A choose tests). If `GovEvent.frontmatter.actor` is typed narrower, widen the local read with `as string | undefined`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- pending`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/escalate/pending.ts governance/test/escalate/pending.test.ts
git commit -m "feat(governance): pendingEscalations read-only query for the 1B bridge"
```

---

## Task 2: `boule-mcp.mjs` one-shot client + register `pending_escalations` (repo, headless)

**Files:**

- Modify: `governance/src/mcp/server.ts`
- Create: `governance/bridge/boule-mcp.mjs`

- [ ] **Step 1: Register the read-only tool**

In `governance/src/mcp/server.ts`, add the import near the other handler imports:

```ts
import { pendingEscalations } from "../escalate/pending.ts";
```

Register alongside the existing tools (use the file's `WORKSPACE` const). It is **read-only** → safe to expose:

```ts
// v2 slice1B — READ-ONLY: the outbound Telegram adapter reads pending escalations from here
// (no markdown parsing in Python; the token format stays in TS).
server.registerTool(
  "pending_escalations",
  {
    description:
      "미해소 Type 0 에스컬레이션 목록 (decision_blocked, verdict 없음) — read-only, bridge용",
    inputSchema: {},
  },
  async () => {
    const list = await pendingEscalations(WORKSPACE);
    return { content: [{ type: "text", text: JSON.stringify(list) }] };
  },
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Write the one-shot MCP client**

Create `governance/bridge/boule-mcp.mjs`:

```js
#!/usr/bin/env node
// Bounded one-shot MCP client for the Boule governance server.
//   node bridge/boule-mcp.mjs <tool> [json-args]
// Spawns the stdio server, calls ONE tool, prints its text result to stdout, exits.
// Used by the inbound Telegram interceptor (choose) and the live-smoke runbook
// (escalate / pending_escalations / why). BOULE_WORKSPACE is inherited from env.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "src", "mcp", "server.ts");

const tool = process.argv[2];
if (!tool) {
  process.stderr.write("usage: boule-mcp.mjs <tool> [json-args]\n");
  process.exit(2);
}
let args = {};
if (process.argv[3]) {
  try {
    args = JSON.parse(process.argv[3]);
  } catch {
    process.stderr.write("invalid JSON args\n");
    process.exit(2);
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["--experimental-strip-types", serverEntry],
  // Inherit env so BOULE_WORKSPACE (and PATH) reach the server unchanged.
  env: process.env,
  cwd: resolve(here, ".."),
});
const client = new Client({ name: "boule-bridge", version: "1.0.0" });

try {
  await client.connect(transport);
  const res = await client.callTool({ name: tool, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  process.stdout.write(text + "\n");
  process.exitCode = res.isError ? 1 : 0;
} catch (err) {
  process.stderr.write(`boule-mcp error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
```

- [ ] **Step 4: Prove the client headlessly (manual round-trip)**

Run (from `governance/`, pinning a throwaway workspace):

```bash
BOULE_WORKSPACE="$(mktemp -d)" node bridge/boule-mcp.mjs escalate \
  '{"question":"DB?","options":[{"label":"sqlite"},{"label":"postgres"}]}'
```

Expected: prints the `escalate` JSON (a `decisionId`, `blockedEventId`, two bound `BOULE:` tokens). Then, reusing the **same** `BOULE_WORKSPACE`, `node bridge/boule-mcp.mjs pending_escalations '{}'` prints a one-element array. Record the observed transcript in the done-line. If it cannot be driven, say "could not run" — do not claim it passed.

- [ ] **Step 5: Full TS suite + drift check**

```bash
pnpm test
pnpm exec tsc --noEmit
git -C /Users/davidpark/private_project/work-radar status --short
```

Expected: all green; changes confined to `governance/**`. No `bindings.ts`/`src-tauri`/migration churn (the MCP is stdio, not Tauri IPC — INVARIANT #4).

- [ ] **Step 6: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/mcp/server.ts governance/bridge/boule-mcp.mjs
git commit -m "feat(governance): register pending_escalations + boule-mcp one-shot client (1B)"
```

---

## Task 3: Outbound `sync-once` adapter (repo; executes the sink in `--dry-run` only)

**Files:**

- Create: `governance/bridge/boule_sync_telegram.py`
- Create: `governance/bridge/test_boule_sync_telegram.py`
- Modify/Create: `governance/.gitignore`

- [ ] **Step 1: Ignore runtime sent-markers**

Append to `governance/.gitignore` (create if absent):

```gitignore
# 1B outbound bridge runtime state (sent-markers, cursors)
workspace/.bridge/
```

- [ ] **Step 2: Write the failing test**

Create `governance/bridge/test_boule_sync_telegram.py`. It tests the PURE pieces (NormalizedEvent build + dedup) with no network and no MCP spawn (the `pending_escalations` reader is injected):

```python
import json
import pathlib
import tempfile
import unittest

import boule_sync_telegram as bridge


def _esc(decision_id="evt_d", blocked_id="evt_b", session_id=None):
    return {
        "decisionId": decision_id,
        "blockedEventId": blocked_id,
        "question": "DB: sqlite or postgres?",
        "options": [
            {"token": "opt0", "label": "sqlite", "reply": f"BOULE:{blocked_id}:{decision_id}:opt0"},
            {"token": "opt1", "label": "postgres", "reply": f"BOULE:{blocked_id}:{decision_id}:opt1"},
        ],
        "sessionId": session_id,
        "agentRecommendation": None,
    }


class BuildNormalizedEvent(unittest.TestCase):
    def test_routable_and_carries_title_detail_and_tokens(self):
        ne = bridge.build_normalized_event(_esc())
        self.assertTrue(ne["routable"])
        self.assertIn("sqlite or postgres", ne["title"])
        # every reply token appears verbatim so the operator can copy-reply it
        self.assertIn("BOULE:evt_b:evt_d:opt0", ne["detail"])
        self.assertIn("BOULE:evt_b:evt_d:opt1", ne["detail"])

    def test_topic_key_reuses_session_when_present_else_dedicated_boule_topic(self):
        self.assertEqual(bridge.build_normalized_event(_esc(session_id="sess-9"))["key"], "session:sess-9")
        ne = bridge.build_normalized_event(_esc())  # no session
        self.assertEqual(ne["key"], "boule:evt_d")
        self.assertEqual(ne["workspace_title"], "Boule")


class Dedup(unittest.TestCase):
    def test_already_sent_blocked_ids_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            marker = pathlib.Path(d) / "telegram-sent.json"
            marker.write_text(json.dumps({"evt_b": {"sent_at": "x"}}), encoding="utf-8")
            sent = bridge.load_sent(marker)
            self.assertEqual(bridge.select_unsent([_esc(blocked_id="evt_b"), _esc(blocked_id="evt_z")], sent, limit=10),
                             [e for e in [_esc(blocked_id="evt_z")]])

    def test_limit_bounds_the_batch(self):
        batch = [_esc(blocked_id=f"evt_{i}") for i in range(5)]
        self.assertEqual(len(bridge.select_unsent(batch, {}, limit=2)), 2)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `governance/bridge/`): `python3 -m pytest test_boule_sync_telegram.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'boule_sync_telegram'`.

- [ ] **Step 4: Write the implementation**

Create `governance/bridge/boule_sync_telegram.py`:

```python
#!/usr/bin/env python3
"""Bounded outbound bridge: push pending Boule escalations to Telegram (sync-once).

Reads pending escalations from the TS sidecar (the read-only `pending_escalations`
MCP command via bridge/boule-mcp.mjs — NO markdown parsing here), builds a
NormalizedEvent, and pipes it into the existing Telegram sink. Idempotent: each
blocked-event id is sent at most once (sent-marker file). Bounded by --limit; no
daemon, no poll loop (INVARIANT #5). This script imports NO network client — the
sink (~/.claude/hooks/cmux_notify_telegram.py) owns the only network call (#3).

Usage:
  BOULE_WORKSPACE=/path/to/workspace python3 boule_sync_telegram.py [--limit N] [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
MCP_CLIENT = HERE / "boule-mcp.mjs"
DEFAULT_SINK = pathlib.Path.home() / ".claude" / "hooks" / "cmux_notify_telegram.py"
SINK = pathlib.Path(os.environ.get("BOULE_TELEGRAM_SINK", str(DEFAULT_SINK)))


def _utc() -> str:
    return _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _workspace() -> pathlib.Path:
    ws = os.environ.get("BOULE_WORKSPACE")
    if not ws:
        raise SystemExit("BOULE_WORKSPACE is required (must match the escalate/choose workspace)")
    return pathlib.Path(ws)


def marker_path(workspace: pathlib.Path) -> pathlib.Path:
    return workspace / ".bridge" / "telegram-sent.json"


def load_sent(path: pathlib.Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_sent(path: pathlib.Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def fetch_pending(workspace: pathlib.Path) -> list[dict[str, Any]]:
    """Call the read-only TS reader; never parse markdown here."""
    cp = subprocess.run(
        ["node", str(MCP_CLIENT), "pending_escalations", "{}"],
        text=True, capture_output=True, timeout=30,
        env={**os.environ, "BOULE_WORKSPACE": str(workspace)},
    )
    if cp.returncode != 0:
        raise SystemExit(f"pending_escalations failed: {cp.stderr.strip()}")
    out = cp.stdout.strip()
    return json.loads(out) if out else []


def select_unsent(pending: list[dict[str, Any]], sent: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    fresh = [e for e in pending if e.get("blockedEventId") not in sent]
    return fresh[: max(0, limit)]


def _render_detail(esc: dict[str, Any]) -> str:
    lines = [esc.get("question", ""), "", "고른 항목의 코드만 그대로 답장하세요:"]
    for o in esc.get("options", []):
        lines.append("")
        lines.append(f"[{o.get('token')}] {o.get('label')}")
        lines.append(o.get("reply", ""))
    rec = esc.get("agentRecommendation")
    if rec:
        lines += ["", f"(추천: {rec})"]
    return "\n".join(lines)


def build_normalized_event(esc: dict[str, Any]) -> dict[str, Any]:
    """A NormalizedEvent (the SSOT shape cmux_notify_telegram.py consumes). Routing/title/
    detail decided here; the sink only does topic-create + render + send."""
    session_id = esc.get("sessionId")
    question = esc.get("question", "")
    if session_id:
        # Reuse the escalating session's topic (the operator's {workspace} — {task} lane).
        key = f"session:{session_id}"
        workspace_title = ""  # the sink inherits the last-known workspace name for this key
        pane_name = ""
    else:
        # No session → a dedicated per-decision Boule topic named "Boule — <question>".
        key = f"boule:{esc.get('decisionId')}"
        workspace_title = "Boule"
        pane_name = question[:80]
    return {
        "routable": True,
        "key": key,
        "title": f"🟣 DECISION NEEDED — {question}"[:200],
        "detail": _render_detail(esc),
        "workspace_title": workspace_title,
        "pane_name": pane_name,
        "session_id": session_id or "",
        "surface": "",
        "cwd": "",
        "event": "BouleEscalation",
    }


def post_to_sink(ne: dict[str, Any], *, dry_run: bool) -> bool:
    argv = ["python3", str(SINK)] + (["--dry-run"] if dry_run else [])
    cp = subprocess.run(argv, input=json.dumps(ne, ensure_ascii=False),
                        text=True, capture_output=True, timeout=30)
    if dry_run and cp.stdout:
        sys.stdout.write(cp.stdout)
    return cp.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    workspace = _workspace()
    sent_file = marker_path(workspace)
    sent = load_sent(sent_file)
    batch = select_unsent(fetch_pending(workspace), sent, limit=a.limit)
    if not batch:
        print("nothing to send")
        return 0
    for esc in batch:
        ne = build_normalized_event(esc)
        if post_to_sink(ne, dry_run=a.dry_run):
            if not a.dry_run:  # dry-run never records markers → repeatable
                sent[esc["blockedEventId"]] = {"sent_at": _utc(), "topic_key": ne["key"]}
        else:
            print(f"WARN: sink rejected escalation {esc.get('blockedEventId')}", file=sys.stderr)
    if not a.dry_run:
        save_sent(sent_file, sent)
    print(f"processed {len(batch)} escalation(s){' (dry-run)' if a.dry_run else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run (from `governance/bridge/`): `python3 -m pytest test_boule_sync_telegram.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Headless end-to-end via the real sink in `--dry-run` (no network)**

Run (from `governance/`):

```bash
export BOULE_WORKSPACE="$(mktemp -d)"
node bridge/boule-mcp.mjs escalate '{"question":"DB: sqlite or postgres?","options":[{"label":"sqlite"},{"label":"postgres"}]}' >/dev/null
python3 bridge/boule_sync_telegram.py --dry-run --limit 5
```

Expected: the sink prints a dry-run payload whose `text` contains the question + both `BOULE:` reply tokens, addressed to a `boule:<decisionId>` topic. No Telegram traffic, no sent-markers written (dry-run). Record the observed payload in the done-line. If it cannot run, say "could not run".

- [ ] **Step 7: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/bridge/boule_sync_telegram.py governance/bridge/test_boule_sync_telegram.py governance/.gitignore
git commit -m "feat(governance): bounded sync-once outbound Telegram adapter (1B, dry-run proven)"
```

---

## ⛔ GATE — Tasks 4 & 5 edit the user's LIVE `~/.hermes` daily-driver fabric

Before Task 4, STOP and get explicit user re-confirmation. Tasks 1–3 are repo-only and committed. Tasks 4–5 modify the user's running Telegram/cmux gateway. Apply them only on a fresh user "go". The user is actively using this fabric (the topics registry was written minutes ago).

---

## Task 4: Inbound `governance_bridge.py` + characterization test (LIVE fabric — gated)

**Files:**

- Create: `~/.hermes/hermes-agent/gateway/governance_bridge.py`
- Create: `~/.hermes/hermes-agent/tests/gateway/test_governance_bridge.py`

- [ ] **Step 1: Write the characterization test (the one test that pins INVARIANT #1)**

Create `~/.hermes/hermes-agent/tests/gateway/test_governance_bridge.py`:

```python
import importlib
import sys
import pathlib

GATEWAY = pathlib.Path.home() / ".hermes" / "hermes-agent" / "gateway"
if str(GATEWAY.parent) not in sys.path:
    sys.path.insert(0, str(GATEWAY.parent))

from gateway import governance_bridge as gb  # noqa: E402


def test_valid_token_invokes_choose_and_is_consumed():
    calls = []
    consumed = gb.try_governance_reply(
        "BOULE:evt_b:evt_d:opt0",
        choose=lambda d, b, o: calls.append((d, b, o)) or True,
    )
    assert consumed is True              # consumed → NOT forwarded to the pane
    assert calls == [("evt_d", "evt_b", "opt0")]


def test_normal_reply_is_not_consumed_so_it_falls_through_to_try_forward():
    calls = []
    consumed = gb.try_governance_reply("restart the build", choose=lambda *_: calls.append(1) or True)
    assert consumed is False             # not governance → caller runs try_forward
    assert calls == []                   # choose never invoked


def test_malformed_boule_token_is_consumed_but_never_invokes_choose():
    calls = []
    consumed = gb.try_governance_reply("BOULE:nope", choose=lambda *_: calls.append(1) or True)
    assert consumed is True              # BOULE-prefixed → consumed (NOT forwarded — no token leak to pane)
    assert calls == []                   # malformed → choose NOT invoked, nothing written
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `~/.hermes/hermes-agent/`): `python3 -m pytest tests/gateway/test_governance_bridge.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'gateway.governance_bridge'`.

- [ ] **Step 3: Write the implementation**

Create `~/.hermes/hermes-agent/gateway/governance_bridge.py`:

```python
"""Governance (Boule) inbound bridge for Telegram topic replies.

A reply that is EXACTLY a Boule option token (BOULE:<blocked>:<decision>:<opt>) is a
human verdict on a Type 0 escalation. It must NOT be blind-forwarded into a cmux pane;
instead it invokes the gated MCP `choose` tool and is consumed. Anything else is not a
governance reply and falls through to the normal cmux pane router unchanged.

INVARIANT #1: this module NEVER writes a decision_* event. Its only write-path is the
gated MCP `choose` (a bounded one-shot MCP client). Match is EXACT-equality only — never
substring/keyword (that bug-class is precisely substring routing).
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
import subprocess
from typing import Callable, Optional

logger = logging.getLogger(__name__)

PREFIX = "BOULE"
SEP = ":"

# Repo-side one-shot MCP client + the workspace the escalate/choose share.
_REPO_GOV = pathlib.Path.home() / "private_project" / "work-radar" / "governance"
MCP_CLIENT = pathlib.Path(os.environ.get("BOULE_MCP_CLIENT", str(_REPO_GOV / "bridge" / "boule-mcp.mjs")))
BOULE_WORKSPACE = os.environ.get("BOULE_WORKSPACE", str(_REPO_GOV / "workspace"))


def classify_reply(text: str):
    """Return (is_boule, parsed) where parsed is (decision, blocked, option) or None.

    is_boule is True for any BOULE-prefixed message (even malformed) so the caller
    consumes it instead of leaking a token into a pane. parsed is non-None ONLY for a
    well-formed, exact-shape token (4 colon fields, no empty field).
    """
    s = text.strip()
    if not s.startswith(PREFIX + SEP):
        return (False, None)
    parts = s.split(SEP)
    if len(parts) != 4 or parts[0] != PREFIX or not all(parts[1:]):
        return (True, None)  # BOULE-prefixed but malformed → consume, do not invoke choose
    _, blocked_event_id, decision_id, option_token = parts
    return (True, (decision_id, blocked_event_id, option_token))


def _invoke_choose(decision_id: str, blocked_event_id: str, option_token: str) -> bool:
    """Bounded one-shot MCP `choose` call. The MCP tool (actor:user + binding guard) is the
    gate; this never writes an event itself."""
    payload = json.dumps(
        {"decision_id": decision_id, "blocked_event_id": blocked_event_id, "option_token": option_token}
    )
    try:
        cp = subprocess.run(
            ["node", str(MCP_CLIENT), "choose", payload],
            text=True, capture_output=True, timeout=30,
            env={**os.environ, "BOULE_WORKSPACE": BOULE_WORKSPACE},
        )
    except Exception as e:
        logger.warning("governance choose spawn failed: %s", e)
        return False
    if cp.returncode != 0:
        logger.warning("governance choose returned non-zero: %s", cp.stderr.strip())
        return False
    logger.info("governance choose ok: decision=%s option=%s", decision_id, option_token)
    return True


def try_governance_reply(text: str, *, choose: Optional[Callable[[str, str, str], bool]] = None) -> bool:
    """Return True iff `text` was a governance reply (and thus CONSUMED — caller must NOT
    forward it to a cmux pane). Return False for non-governance text (caller falls through
    to try_forward). `choose` is injectable for tests; defaults to the MCP one-shot."""
    is_boule, parsed = classify_reply(text)
    if not is_boule:
        return False
    if parsed is None:
        logger.info("consumed malformed BOULE reply (not forwarded, choose not invoked)")
        return True  # consumed; never forwarded, never written
    fn = choose or _invoke_choose
    decision_id, blocked_event_id, option_token = parsed
    fn(decision_id, blocked_event_id, option_token)
    return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `~/.hermes/hermes-agent/`): `python3 -m pytest tests/gateway/test_governance_bridge.py -q`
Expected: PASS (3 tests — the three INVARIANT-#1 branches).

- [ ] **Step 5: Commit (in the fabric's own git, if tracked) OR note for the user**

The `~/.hermes` fabric is the user's repo, not work-radar. Do NOT commit fabric changes into work-radar. If `~/.hermes` is a git repo, stage just these two files and let the USER commit/verify in their fabric. Otherwise leave the files in place and record the change in the work-radar `docs/decisions.md` breadcrumb (Task 6). Either way: this is a live-fabric change — surface it to the user explicitly.

---

## Task 5: Prepend the inbound guard in `telegram.py` (LIVE fabric — gated)

**Files:**

- Modify: `~/.hermes/hermes-agent/gateway/platforms/telegram.py` (just above the existing cmux `try_forward` block at `:4964`)

- [ ] **Step 1: Read the current anchor to confirm it has not moved**

Run: `grep -n "from gateway.cmux_topic_router import try_forward" ~/.hermes/hermes-agent/gateway/platforms/telegram.py`
Expected: the import line inside `_handle_text_message` (was `:4965` on 2026-06-02). If the line number drifted, re-locate the `try_forward` block before editing — the edit must land **immediately before** it.

- [ ] **Step 2: Insert the governance guard**

In `_handle_text_message`, **immediately before** the existing block:

```python
        try:
            from gateway.cmux_topic_router import try_forward
```

insert this guard (so a governance tap is intercepted before the pane router ever sees it):

```python
        # Governance (Boule) Type 0 verdict: a reply that is EXACTLY a BOULE option token is
        # a human decision, not a pane steer. Intercept BEFORE try_forward so the token is
        # never injected into a cmux pane. Non-governance text falls through unchanged.
        try:
            from gateway.governance_bridge import try_governance_reply
            if try_governance_reply(msg.text):
                return
        except Exception:
            # Never let governance routing break normal gateway message handling.
            pass
```

The result: governance guard → (return if consumed) → existing cmux `try_forward` block → normal LLM path. Leave the existing `try_forward` block byte-for-byte unchanged.

- [ ] **Step 3: Syntax + import check (no behavior change for non-governance text)**

Run:

```bash
python3 -c "import ast; ast.parse(open('$HOME/.hermes/hermes-agent/gateway/platforms/telegram.py').read()); print('parse ok')"
python3 -c "import sys; sys.path.insert(0,'$HOME/.hermes/hermes-agent'); import gateway.governance_bridge; print('import ok')"
```

Expected: `parse ok` + `import ok`.

- [ ] **Step 4: Run the fabric's gateway tests to confirm no regression**

Run (from `~/.hermes/hermes-agent/`): `python3 -m pytest tests/gateway -q`
Expected: PASS (existing gateway suite + the new `test_governance_bridge.py`). If the fabric suite has unrelated pre-existing failures, note them explicitly; the new test + telegram import must be green.

- [ ] **Step 5: Hand the live-fabric diff to the user**

Show the two-file diff (`telegram.py` guard + `governance_bridge.py`) and the new test. The USER commits in their `~/.hermes` repo. Do not push anything; do not commit fabric files into work-radar.

---

## Task 6: Gitignore, docs breadcrumb, full headless re-verify (repo)

**Files:**

- Modify: `docs/decisions.md` (append-only Phase log)

- [ ] **Step 1: Append the decisions breadcrumb**

Add one line to the tail of `docs/decisions.md`:

```markdown
- **2026-06-02 — Boule v2 slice1B (Python fabric bridge).** Outbound = bounded `sync-once` (`governance/bridge/boule_sync_telegram.py`) reading the read-only `pending_escalations` MCP command and piping a NormalizedEvent into `~/.claude/hooks/cmux_notify_telegram.py` (dry-run proven; TS imports no network client — #3/#5). Inbound = `gateway/governance_bridge.py` `try_governance_reply` prepended at `telegram.py:~4964` ahead of `try_forward`, invoking gated MCP `choose` via the `boule-mcp.mjs` one-shot on EXACT token match (consume-not-forward; malformed consumed, never written — #1). Live fabric edits applied with explicit user go; live phone smoke = user-run. Commit only; Boule parked.
```

- [ ] **Step 2: Full TS suite + drift confirmation**

Run (from `governance/`): `pnpm test && pnpm exec tsc --noEmit`
Then: `git -C /Users/davidpark/private_project/work-radar status --short`
Expected: green; repo changes confined to `governance/**` + `docs/**`. No `~/.hermes` files staged in work-radar; no `bindings.ts`/`src-tauri`/migration churn.

- [ ] **Step 3: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
git add docs/decisions.md
git commit -m "docs(governance): slice1B done-line (Python fabric bridge, dry-run proven)"
```

---

## Task 7: Live phone round-trip smoke (USER-RUN) + critic pass

- [ ] **Step 1: User runs the smoke runbook**

Provide the user this exact runbook (agent does NOT run it — it originates real Telegram traffic on the daily-driver fabric):

```bash
# Pick ONE workspace and use it for every step.
export BOULE_WORKSPACE="$HOME/private_project/work-radar/governance/workspace"
cd "$HOME/private_project/work-radar/governance"

# 1) Mint an escalation (no session → a dedicated "Boule — …" topic)
node bridge/boule-mcp.mjs escalate \
  '{"question":"Slice1B smoke: ping?","options":[{"label":"pong"},{"label":"nope"}]}'
#   → note the printed decisionId (evt_…)

# 2) Push it to the phone
python3 bridge/boule_sync_telegram.py --limit 5
#   → a "🟣 DECISION NEEDED — Slice1B smoke: ping?" card appears in a Boule topic

# 3) ON THE PHONE: reply in that topic with ONLY the code under "pong",
#    e.g.  BOULE:evt_b…:evt_d…:opt0

# 4) Verify the verdict landed (actor:user) and the chain is complete
node bridge/boule-mcp.mjs why '{"decisionId":"<evt_d from step 1>"}'
#   → phase: chosen ; chain includes decision_blocked + decision_chosen (actor:user)
```

- [ ] **Step 2: Agent verifies the resulting events (read-only)**

After the user reports the tap, the agent (read-only) runs `node bridge/boule-mcp.mjs why '{"decisionId":"…"}'` against the same `BOULE_WORKSPACE` and confirms: `phase: chosen`, a `decision_chosen` with `actor:user`, related_to the blocked event. Record the observed chain. If the user could not run the smoke, state "live smoke could not run" — do NOT claim the round-trip passed.

- [ ] **Step 3: Independent critic (opus, separate pass)**

Dispatch the `critic` agent (opus) on the full 1B change set. It must explicitly check: (a) Python has NO write-path to a `decision_*` event — only the MCP `choose` writes `decision_chosen` (actor:user, binding guard); (b) token match is EXACT-equality only (no substring routing); (c) malformed `BOULE:` is consumed, never forwarded, never written; (d) outbound is bounded (`--limit`, sent-markers), no daemon/poll, no auto-default; (e) TS imports no network client; (f) no `bindings.ts`/Rust/migration drift. Resolve any blocker before "done".

---

## Done criteria (1B)

- [ ] `pending_escalations` read-only MCP command returns unresolved escalations with bound reply tokens; `boule-mcp.mjs` drives any tool as a bounded one-shot.
- [ ] Outbound `sync-once` builds a NormalizedEvent and routes it through the real sink in `--dry-run` (question + both `BOULE:` tokens present); idempotent via sent-markers; `--limit` bounded; no daemon.
- [ ] Inbound `try_governance_reply` characterization test green on all 3 branches (valid→choose+consume / normal→fall-through / malformed→consume-no-write); `telegram.py` guard prepended ahead of `try_forward`; fabric gateway suite green.
- [ ] Python never writes a `decision_*` event (only gated MCP `choose` does, actor:user, binding guard).
- [ ] `pnpm test` green, `tsc` clean, repo drift confined to `governance/**` + `docs/**`, no `bindings.ts`/Rust/migration changes.
- [ ] Live phone round-trip smoke **observed by the user** (or explicitly "could not run"); agent-verified `why` chain shows `phase: chosen` + `decision_chosen` actor:user.
- [ ] Independent **critic (opus, separate pass)** ACCEPT. Commit only — **do NOT push** (Boule parked). `docs/decisions.md` done-line.

## Out of scope (deferred — unchanged from spec §8)

Planner, Conductor + cmux spawning, full Type-1-via-Guardian flow, inline-keyboard (callback_query) taps, per-thread tap binding (token + binding guard already authorize), the `decision-rails.md` rail landing (its own Meta-Observer PR gate), Slack mirror, Pattern Detector (L0→L1). A scheduled/automatic outbound `sync-once` trigger (cmux hook/cron) is also deferred — 1B runs it manually for the smoke.
