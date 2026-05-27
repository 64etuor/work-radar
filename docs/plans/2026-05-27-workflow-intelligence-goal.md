# Workflow Intelligence Goal

Status: active implementation plan
Date: 2026-05-27

## Target

Complete the product goal: make work-radar better at understanding current
state, organizing it, and helping the user decide the next action. The scope is
Worktree Diff UX, braindump card editing, Jobs recovery, Hermes cleanup, Cmd+K,
Skill Registry, PR Radar intelligence, and a Unified Inbox.

## Product Contract

The new system keeps the existing decision rails intact:

- AI can summarize, recommend, flag, and prepare local proposals.
- AI cannot auto-classify a card quadrant or perform external writes without the
  existing acceptance path.
- Inbox alerts are operational memory and navigation surfaces, not automatic
  decisions.
- Mac notifications must be mirrored into Inbox before or during native delivery.

This intentionally updates the older "PR Radar display-only" decision. PR Radar
may now create Inbox alerts and local AI escalation jobs. It still must not
directly mutate GitHub, Notion, Calendar, or matrix quadrant state.

## Delivery Slices

### 1. Unified Inbox Foundation

Add an `inbox_items` SQLite store, Rust commands, generated IPC bindings, query
hooks, navigation, and a first Inbox view.

Minimum fields:

- id, source, source_id, title, body
- priority, severity, status, unread
- project_id, related_entity_type, related_entity_id
- group_key, summary, action_payload JSON
- created_at, updated_at, read_at, dismissed_at

Native notification scheduling must insert or upsert an inbox item whenever the
event is user-visible. Dismissal/read state remains local until a later OS-level
dismissal bridge exists.

### 2. PR Radar Intelligence

Restore PR Radar escalation as Inbox-only intelligence:

- default poll interval: 10 minutes
- setting-backed thresholds for comments and conflict patterns
- comment icon states for unread, critical, and AI-flagged
- create or update Inbox alerts when comment count exceeds threshold or conflict
  patterns are detected
- optionally trigger bounded AI analysis jobs that summarize likely root cause,
  architecture bottleneck, repeated review points, and ownership hints

Escalation output is Inbox + Jobs proposal only. It must not create matrix
quadrants automatically.

### 3. Worktree UX

Implement a shared pane system first, then apply it to Worktree:

- persistent pane sizes
- min/max constraints
- snap and collapse states
- keyboard-accessible collapse controls
- nested pane support

Then add Worktree features:

- file timeline built from local git/file events plus review/job/inbox events
- cleanup preview with target list, risk, recovery note, and AI recommendation
  reason
- stale default: no activity for 2 days
- editable cleanup prompt via the existing skill registry model
- worktree-level AI review trigger with architecture, risky changes, dead code,
  dependency impact, missing tests, and merge-conflict risk

### 4. Braindump Card Editing

Allow direct editing inside cards:

- life wheel area multi-select / change
- personal/work quick toggle and override
- AI auto-classification remains suggested-only; manual override is the truth

### 5. Jobs Reliability

Harden job recovery:

- heartbeat timestamp for running jobs
- startup recovery that marks stale running jobs recoverable/failed
- kill fallback when registry token is missing
- forced cleanup for dangling locks and orphan work dirs
- state machine tests for invalid transitional states

### 6. Hermes Simplification

Remove the standalone Hermes navigation page and keep the modal/status-bar flow.
Clean dead routing, keymap, and palette entries.

### 7. Cmd+K Control Panel

Move Cmd+K from inventory lists to command intent:

- contextual commands
- recent commands
- pinned commands
- semantic search text
- fixed wheel/nested scroll behavior

Skills should remain discoverable, but the palette should not dump the full
registry by default.

### 8. Skill Registry Refactor

Segment skills by boundary:

- Global Skills
- External Skills: Codex, Claude, other providers
- Project Skills

Add search/filter and provider status. Preserve the invariant that skill edits
only change prompts/proposals, not automatic execution rights.

## Implementation Order

1. Inbox DB/store/IPC/view/nav and notification mirroring.
2. PR Radar threshold settings, Inbox alerts, and UI indicators.
3. Jobs recovery because AI escalation depends on reliable agent state.
4. Shared pane system and Worktree pane/collapse cleanup.
5. Worktree timeline, cleanup recommendations, and worktree review trigger.
6. Cmd+K and Skill Registry refactors.
7. Braindump card editing.
8. Hermes standalone-page removal.
9. Full verification, visual smoke, and final docs.

## Verification

Target commands:

- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm tauri dev` smoke when port/signing state allows

UI work needs visual verification for Worktree, Inbox, Cmd+K, and Skills.
