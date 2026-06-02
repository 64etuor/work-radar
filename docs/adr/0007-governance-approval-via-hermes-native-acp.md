---
adr-id: ADR-0007
status: accepted
date: 2026-06-01
decision-makers: [Boule governance track]
tags: [governance, hermes, acp, mcp, ipc]
supersedes:
---

# 0007. Governance Human-Approval Surface: Hermes-native ACP, not MCP Elicitation

## Context and Problem Statement

**Scope**: the Boule governance sidecar (`governance/`) and its human-approval surface
inside work-radar's Hermes panel.

The governance harness needs human sign-off for Type 1 (irreversible) decisions, surfaced
as a tappable approval card (main design §5.2; §5.1 lists `ask_user`/`send_file` MCP tools).
The open question was _how_ a governance MCP tool reaches the human: the governance MCP
server speaks MCP to Hermes (it is spawned by Hermes via the `session/new` `mcpServers`
injection), while the human surface — the P2b card — is driven by ACP
`session/request_permission` **from the agent**. Two process hops separate an MCP tool call
from the card.

## Decision Drivers

- The governance sidecar must stay pure decision logic; UI/transport concerns belong to the
  agent runtime (separation of concerns).
- A chosen mechanism must actually reach the human through the _existing_ Hermes ↔ work-radar
  channel — verifiable from source, not assumed.
- INVARIANT #1: automation must not penetrate the decision rail; the human gate is preserved.

## Considered Options

- **A — governance MCP `ask_user` via `server.elicitInput`** (MCP elicitation).
- **B — Hermes-native tool-call approval → ACP `session/request_permission` → P2b card.**
- **C — extend Hermes to bridge MCP elicitation → ACP.**

## Decision Outcome

**Rule**: The governance sidecar MUST NOT implement a human-facing `ask_user`/`send_file` via
MCP elicitation. Human approval MUST ride the agent runtime's native tool-call approval, which
Hermes already bridges to ACP `session/request_permission` and which work-radar already renders
as the P2b ask-user card.

Chosen option: **B**. Option A is _architecturally refuted_ (see evidence); Option C is out of
lane (`~/.hermes` is owned by the skills track / a separate repo).

This **supersedes** the §5.1 `ask_user`/`send_file` MCP-tool line _for the approval use-case_:
those tools are not built on the governance server.

### Consequences

- Good: the governance server stays a pure decision/event store; no UI coupling; reuses the
  already-shipped, headless-tested P2b card path.
- Good: no dependency on a Hermes capability that does not exist.
- Bad: governance cannot _proactively_ prompt the human on its own — a prompt only appears when
  the agent invokes an approval-gated governance tool (acceptable: the agent is the actor that
  drives decisions).

### Confirmation

The refutation of Option A is reproducible from source (cited below). The chosen path is
exercised by P2b's headless reducer/thunk/render tests; the live in-app card smoke is unblocked
once the dev-DB migration skew is resolved (`WORK_RADAR_DEV_DB` override, same change set).

### Anti-Patterns

- Re-introducing `server.elicitInput` (or any `elicitation/create`) in the governance MCP
  server — it will throw at runtime under Hermes.
- Adding human-facing UI tools (`ask_user`, `send_file`, dialogs) to the governance sidecar.

## Pros and Cons of the Options

### Option A — MCP elicitation

- Bad: **refuted.** Hermes builds its MCP client as the stock
  `mcp.ClientSession(read, write, **sampling_kwargs)`
  (`~/.hermes/hermes-agent/tools/mcp_tool.py:1466,1489`) with **no `elicitation_callback`**, so
  it never declares `elicitation` capability to the MCP servers it loads. The MCP SDK
  (`@modelcontextprotocol/sdk` 1.29.0, `server/index.js:351-366`) makes `elicitInput` throw
  `"Client does not support form elicitation"` unless the client declared `elicitation.form`.
  The request would never reach the human.
- Bad: even if it didn't throw, work-radar declares only
  `clientCapabilities: { fs: {}, terminal: false }` to Hermes
  (`src-tauri/src/hermes_agent/acp_client.rs:182`) — no elicitation bridge to the card.

### Option B — Hermes-native ACP approval (chosen)

- Good: Hermes already bridges its agent's tool-call approval to ACP `request_permission`
  (`~/.hermes/hermes-agent/acp_adapter/server.py:1404`), and P2b renders that as the card.
- Good: zero new surface in the sidecar.
- Bad: not a _governance-initiated_ prompt (agent-mediated only).

### Option C — extend Hermes

- Bad: `~/.hermes` is the skills track's lane / a separate repo; concurrent-WIP contamination
  risk; not this branch's responsibility.

## More Information

- Related: P2b card design
  (`governance/docs/design/2026-06-01-ssot-governance-harness-p2b-askuser-card-design.md`),
  main harness design §5.1/§5.2
  (`governance/docs/design/2026-05-31-ssot-governance-harness-design.md`).
- Investigation + dev-DB skew fix spec:
  `governance/docs/design/2026-06-01-ssot-governance-harness-approval-finding-devdb-skew-design.md`.
- Key files: `governance/src/mcp/server.ts`, `src-tauri/src/hermes_agent/acp_client.rs`.
