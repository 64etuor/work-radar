# Control Room "Living Blueprint" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 평평한 4-카드 Control Room을 수평 5-레인 SVG 스키매틱(Spec→Plan→Task→Session→Handoff)으로 교체해 진행/차단/승인대기를 한눈에 도식화하고, 노드 hover 시 계보를 하이라이트한다.

**Architecture:** 레이아웃·엣지·계보·vitals는 전부 순수 함수(`src/lib/controlRoomGraph.ts`)로 분리해 node 환경 vitest로 검증한다. SVG 컴포넌트(`Schematic`/`SchematicNode`/`SchematicEdge`/`NodeTooltip`/`Vitals`)는 상태 없는 dumb render이고, hover/select/filter 상태는 `Schematic`이 소유한다. v1은 실데이터 엣지(session→task, handoff→session)만 그리며, 풀-DAG 부모 ref는 별도 백엔드 PR로 분리한다(이 플랜 범위 밖).

**Tech Stack:** React + TypeScript, Tailwind v4 + shadcn(Card/Button), lucide-react, `motion`(framer-motion 후속, 신규 의존성 1건, 엣지 draw-in에만 사용), vitest(node env).

**Spec:** `docs/superpowers/specs/2026-06-07-control-room-blueprint-design.md`

**Worktree:** `feat/control-room-blueprint` @ `/Users/davidpark/private_project/work-radar-wt/control-room` (off dev `56ca525`).

---

## Conventions for every task

- 모든 명령은 워크트리 루트에서 실행: `cd /Users/davidpark/private_project/work-radar-wt/control-room`.
- 커밋 전 husky pre-commit이 `cargo fmt`/lint-staged를 돌리므로 **cargo PATH 먼저 export**:
  `export PATH="$HOME/.cargo/bin:$PATH"`.
- FE 파일은 커밋 전 `pnpm exec prettier --write <files>`로 포맷.
- 검증 게이트: `pnpm typecheck` · `pnpm lint` · `pnpm test`(vitest).
- 새 PK/타입을 bindings에 추가하지 않음 → drift 0 (Rust 무변경).

---

## File Structure

- Create `src/lib/controlRoomGraph.ts` — 순수 레이아웃/엣지/계보/vitals 로직 + 타입/상수.
- Create `src/lib/controlRoomGraph.test.ts` — 위 함수들의 vitest(node).
- Create `src/components/control-room/SchematicNode.tsx` — 블루프린트 셀 `<g>`.
- Create `src/components/control-room/SchematicEdge.tsx` — 직교 엘보 `motion.path`.
- Create `src/components/control-room/NodeTooltip.tsx` — 선택 노드 상세(HTML 오버레이).
- Create `src/components/control-room/Vitals.tsx` — 상단 계기바.
- Create `src/components/control-room/Schematic.tsx` — SVG 캔버스 + 상호작용 상태.
- Modify `src/components/control-room/ControlRoomView.tsx` — 조립 교체.
- Modify `src/components/control-room/ControlRoomView.css` — 스키매틱 클래스/키프레임.
- Modify `package.json` / lockfile — `motion` 추가.
- Keep `src/lib/controlRoom.ts`(statusTone 재사용) · `src/lib/query/governance.ts`(훅 그대로).

---

## Task 0: Add the `motion` dependency

**Files:** Modify `package.json`, `pnpm-lock.yaml`.

- [ ] **Step 1: Install**

```bash
cd /Users/davidpark/private_project/work-radar-wt/control-room
pnpm add motion
```

- [ ] **Step 2: Verify it resolves**

Run: `node -e "require.resolve('motion/react'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add package.json pnpm-lock.yaml
git commit -m "build(deps): add motion for control-room edge animation"
```

---

## Task 1: Graph types, constants, and `deriveEdges` (TDD)

**Files:**
- Create: `src/lib/controlRoomGraph.ts`
- Test: `src/lib/controlRoomGraph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/controlRoomGraph.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { ControlRoomSnapshot, SessionPhase } from "../bindings";
import { deriveEdges } from "./controlRoomGraph";

function snap(partial: Partial<ControlRoomSnapshot>): ControlRoomSnapshot {
  return {
    generatedAt: null,
    tasks: [],
    plans: [],
    specs: [],
    sessions: [],
    handoffs: [],
    orchestrator: { tasks: [], plans: [], sessions: [] },
    ...partial,
  };
}

function sess(sessionId: string, phase: SessionPhase, taskId: string | null = null) {
  return { sessionId, surface: null, ownership: "user_owned" as const, taskId, phase };
}

describe("deriveEdges", () => {
  it("links session→task and handoff→session left-to-right", () => {
    const s = snap({
      tasks: [{ taskId: "t1", title: "T1", phase: "active" }],
      sessions: [sess("s1", "active", "t1")],
      handoffs: [{ handoffId: "h1", sessionId: "s1", phase: "pending" }],
    });
    expect(deriveEdges(s)).toEqual([
      { id: "task:t1->session:s1", source: "task:t1", target: "session:s1" },
      { id: "session:s1->handoff:h1", source: "session:s1", target: "handoff:h1" },
    ]);
  });

  it("drops edges whose endpoint node is missing", () => {
    const s = snap({ sessions: [sess("s1", "active", "ghost")] });
    expect(deriveEdges(s)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: FAIL — `Failed to resolve import "./controlRoomGraph"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/controlRoomGraph.ts`:

```ts
import type { ControlRoomSnapshot, Ownership } from "../bindings";
import { type StatusTone, statusTone } from "./controlRoom";

/** Horizontal strata of the work pipeline, left → right. */
export type LaneKind = "spec" | "plan" | "task" | "session" | "handoff";
export const LANES: LaneKind[] = ["spec", "plan", "task", "session", "handoff"];

export interface GraphNode {
  id: string; // `${lane}:${rawId}` — globally unique
  lane: LaneKind;
  rawId: string;
  label: string;
  tone: StatusTone;
  phase: string;
  attention: boolean;
  ownership: Ownership | null;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string; // `${source}->${target}`
  source: string;
  target: string;
}

export interface Schematic {
  lanes: LaneKind[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export interface Vitals {
  inProgress: number;
  blocked: number;
  awaitingHuman: number;
  sessions: number;
}

// Layout geometry (also asserted by tests, so keep them here).
export const PAD_X = 24;
export const PAD_Y = 16;
export const LANE_W = 200;
export const LANE_HEADER_H = 36;
export const ROW_H = 64;
export const NODE_W = 152;
export const NODE_H = 46;

const nid = (lane: LaneKind, rawId: string) => `${lane}:${rawId}`;

/**
 * v1 edges that actually exist in the snapshot: session.taskId → task and
 * handoff.sessionId → session, oriented left→right. Edges whose endpoint node
 * is absent are dropped (safe). When the backend follow-up adds plan.specId /
 * task.planId, add the two extra loops here — components need no change.
 */
export function deriveEdges(snap: ControlRoomSnapshot): GraphEdge[] {
  const taskIds = new Set(snap.tasks.map((t) => t.taskId));
  const sessionIds = new Set(snap.sessions.map((s) => s.sessionId));
  const edges: GraphEdge[] = [];

  for (const s of snap.sessions) {
    if (s.taskId && taskIds.has(s.taskId)) {
      const source = nid("task", s.taskId);
      const target = nid("session", s.sessionId);
      edges.push({ id: `${source}->${target}`, source, target });
    }
  }
  for (const h of snap.handoffs) {
    if (sessionIds.has(h.sessionId)) {
      const source = nid("session", h.sessionId);
      const target = nid("handoff", h.handoffId);
      edges.push({ id: `${source}->${target}`, source, target });
    }
  }
  return edges;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git add src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git commit -m "feat(control-room): graph types + deriveEdges (session→task, handoff→session)"
```

---

## Task 2: `computeVitals` + `nodeMatchesVital` (TDD)

**Files:**
- Modify: `src/lib/controlRoomGraph.ts`
- Test: `src/lib/controlRoomGraph.test.ts`

- [ ] **Step 1: Write the failing test** — append to `controlRoomGraph.test.ts`:

```ts
import { computeVitals, nodeMatchesVital, type GraphNode } from "./controlRoomGraph";

function node(lane: GraphNode["lane"], phase: string, attention = false): GraphNode {
  return {
    id: `${lane}:x`,
    lane,
    rawId: "x",
    label: "x",
    tone: "muted",
    phase,
    attention,
    ownership: null,
    x: 0,
    y: 0,
  };
}

describe("computeVitals", () => {
  it("counts in-progress, blocked, and awaiting-human", () => {
    const s = snap({
      sessions: [sess("s1", "active"), sess("s2", "opening"), sess("s3", "blocked"), sess("s4", "handoff_ready")],
      handoffs: [{ handoffId: "h1", sessionId: "s1", phase: "pending" }],
      orchestrator: {
        tasks: [{ taskId: "t1", phase: "blocked", hasOpenBlock: true }],
        plans: [],
        sessions: [],
      },
    });
    expect(computeVitals(s)).toEqual({ inProgress: 2, blocked: 2, awaitingHuman: 2, sessions: 4 });
  });
});

describe("nodeMatchesVital", () => {
  it("maps node lane/phase/attention to vital buckets", () => {
    expect(nodeMatchesVital(node("session", "active"), "inProgress")).toBe(true);
    expect(nodeMatchesVital(node("task", "blocked", true), "blocked")).toBe(true);
    expect(nodeMatchesVital(node("session", "blocked"), "blocked")).toBe(true);
    expect(nodeMatchesVital(node("handoff", "pending"), "awaitingHuman")).toBe(true);
    expect(nodeMatchesVital(node("session", "checkpoint_requested"), "awaitingHuman")).toBe(true);
    expect(nodeMatchesVital(node("spec", "draft"), "inProgress")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: FAIL — `computeVitals`/`nodeMatchesVital` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `controlRoomGraph.ts`:

```ts
export type VitalKey = "inProgress" | "blocked" | "awaitingHuman";

export function computeVitals(snap: ControlRoomSnapshot): Vitals {
  const blockedTasks = snap.orchestrator.tasks.filter((t) => t.hasOpenBlock).length;
  let inProgress = 0;
  let blockedSessions = 0;
  let awaitingHuman = 0;
  for (const s of snap.sessions) {
    if (s.phase === "active" || s.phase === "opening") inProgress++;
    if (s.phase === "blocked") blockedSessions++;
    if (s.phase === "checkpoint_requested" || s.phase === "handoff_ready") awaitingHuman++;
  }
  for (const h of snap.handoffs) {
    if (h.phase === "pending") awaitingHuman++;
  }
  return {
    inProgress,
    blocked: blockedTasks + blockedSessions,
    awaitingHuman,
    sessions: snap.sessions.length,
  };
}

/** Which nodes a Vitals chip highlights. Mirrors computeVitals's rules. */
export function nodeMatchesVital(n: GraphNode, key: VitalKey): boolean {
  switch (key) {
    case "inProgress":
      return n.lane === "session" && (n.phase === "active" || n.phase === "opening");
    case "blocked":
      return (n.lane === "task" && n.attention) || (n.lane === "session" && n.phase === "blocked");
    case "awaitingHuman":
      return (
        (n.lane === "handoff" && n.phase === "pending") ||
        (n.lane === "session" && (n.phase === "checkpoint_requested" || n.phase === "handoff_ready"))
      );
    default:
      return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git add src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git commit -m "feat(control-room): computeVitals + nodeMatchesVital"
```

---

## Task 3: `buildSchematic` layout + node placement (TDD)

**Files:**
- Modify: `src/lib/controlRoomGraph.ts`
- Test: `src/lib/controlRoomGraph.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { buildSchematic, LANE_W, PAD_X } from "./controlRoomGraph";

describe("buildSchematic", () => {
  it("columns lanes and floats attention nodes to the top of a lane", () => {
    const s = snap({
      tasks: [
        { taskId: "t1", title: "calm", phase: "active" },
        { taskId: "t2", title: "stuck", phase: "blocked" },
      ],
      orchestrator: {
        tasks: [{ taskId: "t2", phase: "blocked", hasOpenBlock: true }],
        plans: [],
        sessions: [],
      },
    });
    const g = buildSchematic(s);
    const tasks = g.nodes.filter((n) => n.lane === "task");
    expect(tasks.map((n) => n.rawId)).toEqual(["t2", "t1"]); // attention first
    expect(tasks[0].attention).toBe(true);
    expect(tasks[0].x).toBe(PAD_X + 2 * LANE_W); // task is lane index 2
    expect(tasks[0].y).toBeLessThan(tasks[1].y);
  });

  it("labels sessions by surface and carries ownership", () => {
    const g = buildSchematic(
      snap({ sessions: [{ sessionId: "s1", surface: "cmux:7", ownership: "orchestrator_owned", taskId: null, phase: "active" }] }),
    );
    const node = g.nodes.find((n) => n.lane === "session");
    expect(node?.label).toBe("cmux:7");
    expect(node?.ownership).toBe("orchestrator_owned");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: FAIL — `buildSchematic` not exported.

- [ ] **Step 3: Write minimal implementation** — append:

```ts
type NodeDraft = Omit<GraphNode, "x" | "y">;

const TONE_ORDER: Record<StatusTone, number> = {
  blocked: 0,
  pressure: 1,
  active: 2,
  waiting: 3,
  done: 4,
  muted: 5,
};

function draft(
  lane: LaneKind,
  rawId: string,
  label: string,
  phase: string,
  attention: boolean,
  ownership: Ownership | null,
): NodeDraft {
  return {
    id: nid(lane, rawId),
    lane,
    rawId,
    label,
    tone: statusTone(phase as never),
    phase,
    attention,
    ownership,
  };
}

function compareNode(a: NodeDraft, b: NodeDraft): number {
  if (a.attention !== b.attention) return a.attention ? -1 : 1;
  const t = TONE_ORDER[a.tone] - TONE_ORDER[b.tone];
  if (t !== 0) return t;
  return a.rawId.localeCompare(b.rawId);
}

export function buildSchematic(snap: ControlRoomSnapshot): Schematic {
  const blockedTaskIds = new Set(
    snap.orchestrator.tasks.filter((t) => t.hasOpenBlock).map((t) => t.taskId),
  );

  const drafts: NodeDraft[] = [];
  for (const sp of snap.specs) drafts.push(draft("spec", sp.specId, sp.title, sp.phase, false, null));
  for (const p of snap.plans) drafts.push(draft("plan", p.planId, p.title, p.phase, false, null));
  for (const t of snap.tasks)
    drafts.push(draft("task", t.taskId, t.title, t.phase, blockedTaskIds.has(t.taskId), null));
  for (const s of snap.sessions) {
    const att =
      s.phase === "context_pressure_high" ||
      s.phase === "checkpoint_requested" ||
      s.phase === "handoff_ready";
    drafts.push(draft("session", s.sessionId, s.surface ?? s.sessionId, s.phase, att, s.ownership));
  }
  for (const h of snap.handoffs)
    drafts.push(draft("handoff", h.handoffId, h.handoffId, h.phase, h.phase === "pending", null));

  const nodes: GraphNode[] = [];
  let maxRows = 0;
  LANES.forEach((lane, laneIdx) => {
    const inLane = drafts.filter((n) => n.lane === lane).sort(compareNode);
    inLane.forEach((n, rowIdx) => {
      nodes.push({
        ...n,
        x: PAD_X + laneIdx * LANE_W,
        y: PAD_Y + LANE_HEADER_H + rowIdx * ROW_H,
      });
    });
    maxRows = Math.max(maxRows, inLane.length);
  });

  return {
    lanes: LANES,
    nodes,
    edges: deriveEdges(snap),
    width: PAD_X * 2 + (LANES.length - 1) * LANE_W + NODE_W,
    height: PAD_Y * 2 + LANE_HEADER_H + Math.max(1, maxRows) * ROW_H,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git add src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git commit -m "feat(control-room): buildSchematic lane layout + attention sort"
```

---

## Task 4: `lineageOf` bidirectional BFS (TDD)

**Files:**
- Modify: `src/lib/controlRoomGraph.ts`
- Test: `src/lib/controlRoomGraph.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { lineageOf } from "./controlRoomGraph";

describe("lineageOf", () => {
  const edges = [
    { id: "task:t1->session:s1", source: "task:t1", target: "session:s1" },
    { id: "session:s1->handoff:h1", source: "session:s1", target: "handoff:h1" },
    { id: "task:t9->session:s9", source: "task:t9", target: "session:s9" },
  ];

  it("walks both directions and includes connecting edge ids", () => {
    const lin = lineageOf("session:s1", edges);
    expect(lin.has("task:t1")).toBe(true);
    expect(lin.has("handoff:h1")).toBe(true);
    expect(lin.has("task:t1->session:s1")).toBe(true);
    expect(lin.has("session:s1->handoff:h1")).toBe(true);
  });

  it("excludes disconnected components", () => {
    const lin = lineageOf("session:s1", edges);
    expect(lin.has("task:t9")).toBe(false);
    expect(lin.has("task:t9->session:s9")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: FAIL — `lineageOf` not exported.

- [ ] **Step 3: Write minimal implementation** — append:

```ts
/** Bidirectional reachable set from `nodeId` (node ids), plus the edge ids whose
 *  both endpoints are reachable. Used to highlight a node's lineage on hover. */
export function lineageOf(nodeId: string, edges: GraphEdge[]): Set<string> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adj.get(a) ?? new Set<string>();
    set.add(b);
    adj.set(a, set);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }

  const seen = new Set<string>([nodeId]);
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  for (const e of edges) {
    if (seen.has(e.source) && seen.has(e.target)) seen.add(e.id);
  }
  return seen;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/controlRoomGraph.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git add src/lib/controlRoomGraph.ts src/lib/controlRoomGraph.test.ts
git commit -m "feat(control-room): lineageOf bidirectional BFS"
```

---

## Task 5: `SchematicNode` component

**Files:** Create `src/components/control-room/SchematicNode.tsx`

- [ ] **Step 1: Write the component** (no DOM test — dumb render; verified by typecheck + visual)

```tsx
import { AlertTriangle } from "lucide-react";

import { type GraphNode, NODE_H, NODE_W } from "../../lib/controlRoomGraph";

export type NodeState = "normal" | "highlight" | "dim";

interface Props {
  node: GraphNode;
  state: NodeState;
  selected: boolean;
  index: number;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function SchematicNode({ node, state, selected, index, onHover, onSelect }: Props) {
  return (
    <g
      className="cr-node"
      data-tone={node.tone}
      data-state={state}
      data-attention={node.attention || undefined}
      data-selected={selected || undefined}
      transform={`translate(${node.x}, ${node.y})`}
      style={{ animationDelay: `${Math.min(index * 18, 360)}ms` }}
      role="button"
      tabIndex={0}
      aria-label={`${node.lane} ${node.label} — ${node.phase}`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect className="cr-node-box" width={NODE_W} height={NODE_H} rx={6} />
      {node.attention && (
        <AlertTriangle className="cr-node-flag" x={NODE_W - 20} y={7} width={12} height={12} aria-hidden />
      )}
      <text className="cr-node-label" x={11} y={20}>
        {truncate(node.label, 18)}
      </text>
      <text className="cr-node-phase" x={11} y={36}>
        {node.phase}
      </text>
    </g>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/control-room/SchematicNode.tsx
git add src/components/control-room/SchematicNode.tsx
git commit -m "feat(control-room): SchematicNode blueprint cell"
```

---

## Task 6: `SchematicEdge` component (motion draw-in)

**Files:** Create `src/components/control-room/SchematicEdge.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { motion, useReducedMotion } from "motion/react";

import { type GraphEdge, type GraphNode, NODE_H, NODE_W } from "../../lib/controlRoomGraph";
import type { NodeState } from "./SchematicNode";

interface Props {
  edge: GraphEdge;
  source: GraphNode;
  target: GraphNode;
  state: NodeState;
}

export function SchematicEdge({ edge, source, target, state }: Props) {
  const reduce = useReducedMotion();
  const x1 = source.x + NODE_W;
  const y1 = source.y + NODE_H / 2;
  const x2 = target.x;
  const y2 = target.y + NODE_H / 2;
  const midX = (x1 + x2) / 2;
  // orthogonal elbow: out-right, vertical at mid-channel, into the target's left
  const d = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;

  return (
    <motion.path
      className="cr-edge"
      data-state={state}
      data-edge-id={edge.id}
      d={d}
      fill="none"
      markerEnd="url(#cr-arrow)"
      initial={reduce ? false : { pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeInOut" }}
    />
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/control-room/SchematicEdge.tsx
git add src/components/control-room/SchematicEdge.tsx
git commit -m "feat(control-room): SchematicEdge orthogonal connector with draw-in"
```

---

## Task 7: `NodeTooltip` + `Vitals` components

**Files:**
- Create `src/components/control-room/NodeTooltip.tsx`
- Create `src/components/control-room/Vitals.tsx`

- [ ] **Step 1: Write `NodeTooltip.tsx`**

```tsx
import { type GraphNode, NODE_W } from "../../lib/controlRoomGraph";

export function NodeTooltip({ node }: { node: GraphNode }) {
  return (
    <div className="cr-tooltip" style={{ left: node.x + NODE_W + 10, top: node.y }} role="dialog">
      <div className="cr-tooltip-lane">{node.lane}</div>
      <div className="cr-tooltip-title">{node.label}</div>
      <dl className="cr-tooltip-meta">
        <div>
          <dt>phase</dt>
          <dd data-tone={node.tone}>{node.phase}</dd>
        </div>
        {node.ownership && (
          <div>
            <dt>owner</dt>
            <dd>{node.ownership}</dd>
          </div>
        )}
        <div>
          <dt>id</dt>
          <dd className="cr-tooltip-id">{node.rawId}</dd>
        </div>
      </dl>
    </div>
  );
}
```

- [ ] **Step 2: Write `Vitals.tsx`**

```tsx
import { Activity, AlertTriangle, Boxes, Pause } from "lucide-react";

import type { Vitals as VitalsData, VitalKey } from "../../lib/controlRoomGraph";

interface Props {
  vitals: VitalsData;
  active: VitalKey | null;
  onToggle: (key: VitalKey) => void;
}

const CHIPS: Array<{ key: VitalKey; label: string; icon: typeof Activity; tone: string }> = [
  { key: "inProgress", label: "진행중", icon: Activity, tone: "active" },
  { key: "blocked", label: "차단", icon: AlertTriangle, tone: "blocked" },
  { key: "awaitingHuman", label: "승인 대기", icon: Pause, tone: "pressure" },
];

export function Vitals({ vitals, active, onToggle }: Props) {
  return (
    <div className="cr-vitals">
      {CHIPS.map(({ key, label, icon: Icon, tone }) => (
        <button
          key={key}
          type="button"
          className="cr-vital"
          data-tone={tone}
          data-active={active === key || undefined}
          aria-pressed={active === key}
          onClick={() => onToggle(key)}
        >
          <Icon size={15} aria-hidden />
          <span className="cr-vital-n">{vitals[key]}</span>
          <span className="cr-vital-label">{label}</span>
        </button>
      ))}
      <div className="cr-vital cr-vital--static" data-tone="muted">
        <Boxes size={15} aria-hidden />
        <span className="cr-vital-n">{vitals.sessions}</span>
        <span className="cr-vital-label">세션</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/control-room/NodeTooltip.tsx src/components/control-room/Vitals.tsx
git add src/components/control-room/NodeTooltip.tsx src/components/control-room/Vitals.tsx
git commit -m "feat(control-room): NodeTooltip + Vitals chips"
```

---

## Task 8: `Schematic` canvas (composition + interaction state)

**Files:** Create `src/components/control-room/Schematic.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useMemo, useState } from "react";

import type { ControlRoomSnapshot } from "../../bindings";
import {
  buildSchematic,
  type GraphNode,
  LANE_W,
  LANE_HEADER_H,
  type LaneKind,
  lineageOf,
  nodeMatchesVital,
  PAD_X,
  PAD_Y,
  type VitalKey,
} from "../../lib/controlRoomGraph";
import { NodeTooltip } from "./NodeTooltip";
import { SchematicEdge } from "./SchematicEdge";
import { type NodeState, SchematicNode } from "./SchematicNode";

const LANE_LABEL: Record<LaneKind, string> = {
  spec: "SPEC",
  plan: "PLAN",
  task: "TASK",
  session: "SESSION",
  handoff: "HANDOFF",
};

export function Schematic({
  snap,
  filter,
}: {
  snap: ControlRoomSnapshot;
  filter: VitalKey | null;
}) {
  const schematic = useMemo(() => buildSchematic(snap), [snap]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const focusId = hovered ?? selected;
  const lineage = useMemo(
    () => (focusId ? lineageOf(focusId, schematic.edges) : null),
    [focusId, schematic.edges],
  );
  const nodeById = useMemo(
    () => new Map(schematic.nodes.map((n) => [n.id, n])),
    [schematic.nodes],
  );

  // Esc clears the pinned selection (local state only — not an overlay).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function nodeState(n: GraphNode): NodeState {
    if (lineage) return lineage.has(n.id) ? "highlight" : "dim";
    if (filter) return nodeMatchesVital(n, filter) ? "highlight" : "dim";
    return "normal";
  }

  function edgeState(edgeId: string): NodeState {
    if (lineage) return lineage.has(edgeId) ? "highlight" : "dim";
    return "normal";
  }

  const selectedNode = selected ? (nodeById.get(selected) ?? null) : null;

  return (
    <div className="cr-canvas-wrap">
      <svg
        className="cr-canvas"
        width={schematic.width}
        height={schematic.height}
        viewBox={`0 0 ${schematic.width} ${schematic.height}`}
        onClick={() => setSelected(null)}
      >
        <defs>
          <marker
            id="cr-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path className="cr-arrow-head" d="M0,0 L8,4 L0,8 Z" />
          </marker>
        </defs>

        {schematic.lanes.map((lane, i) => (
          <text key={lane} className="cr-lane-header" x={PAD_X + i * LANE_W} y={PAD_Y + 12}>
            {LANE_LABEL[lane]}
          </text>
        ))}

        {schematic.edges.map((e) => {
          const source = nodeById.get(e.source);
          const target = nodeById.get(e.target);
          if (!source || !target) return null;
          return (
            <SchematicEdge key={e.id} edge={e} source={source} target={target} state={edgeState(e.id)} />
          );
        })}

        {schematic.nodes.map((n, i) => (
          <SchematicNode
            key={n.id}
            node={n}
            index={i}
            state={nodeState(n)}
            selected={selected === n.id}
            onHover={setHovered}
            onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
          />
        ))}
      </svg>

      {selectedNode && <NodeTooltip node={selectedNode} />}
    </div>
  );
}
```

Note: `LANE_HEADER_H` is imported only to keep geometry imports colocated; if `pnpm lint` flags it as unused, delete it from the import list.

- [ ] **Step 2: Verify it typechecks + lints**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. If lint reports `LANE_HEADER_H` unused, remove it from the import and rerun.

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/control-room/Schematic.tsx
git add src/components/control-room/Schematic.tsx
git commit -m "feat(control-room): Schematic canvas with hover lineage + select"
```

---

## Task 9: Rewrite `ControlRoomView` + extend CSS

**Files:**
- Modify `src/components/control-room/ControlRoomView.tsx`
- Modify `src/components/control-room/ControlRoomView.css`

- [ ] **Step 1: Replace `ControlRoomView.tsx` entirely**

```tsx
import "./ControlRoomView.css";

import { Gauge, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { relativeAgo } from "../../lib/controlRoom";
import { computeVitals, type VitalKey } from "../../lib/controlRoomGraph";
import { useControlRoomSnapshot } from "../../lib/query/governance";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Schematic } from "./Schematic";
import { Vitals } from "./Vitals";

export default function ControlRoomView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useControlRoomSnapshot();
  // Date.now() is impure, so seed "now" once via a lazy initializer; refreshes bump it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [filter, setFilter] = useState<VitalKey | null>(null);

  const stamp = useMemo(() => (data ? relativeAgo(data.generatedAt, nowMs) : ""), [data, nowMs]);
  const vitals = useMemo(() => (data ? computeVitals(data) : null), [data]);
  const total = data
    ? data.tasks.length + data.plans.length + data.specs.length + data.sessions.length + data.handoffs.length
    : 0;

  return (
    <div className="cr-view">
      <div className="cr-header">
        <h1 className="inline-flex items-center gap-2 text-lg font-semibold">
          <Gauge size={18} aria-hidden /> Control Room
        </h1>
        <span className="cr-stamp">
          {stamp}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => {
              setNowMs(Date.now());
              void refetch();
            }}
            disabled={isFetching}
          >
            <RefreshCw size={14} className="mr-1" /> 새로고침
          </Button>
        </span>
      </div>

      {vitals && (
        <Vitals
          vitals={vitals}
          active={filter}
          onToggle={(key) => setFilter((cur) => (cur === key ? null : key))}
        />
      )}

      {isLoading && <div className="cr-empty">불러오는 중…</div>}
      {isError && (
        <Card className="p-4">
          <div className="cr-empty">
            거버넌스 상태를 읽지 못했습니다: {String((error as Error)?.message ?? error)}
          </div>
        </Card>
      )}
      {data &&
        (total === 0 ? (
          <Card className="p-4">
            <div className="cr-empty">아직 프로젝션 없음 — 진행 중인 work가 없습니다.</div>
          </Card>
        ) : (
          <Schematic snap={data} filter={filter} />
        ))}
    </div>
  );
}
```

- [ ] **Step 2: Replace `ControlRoomView.css` entirely**

```css
/*
 * Control Room scoped tokens. Maps the master §12 status tones onto global
 * --color-wr-* design tokens where they exist; --cr-pressure has no global
 * orange token yet, so it uses a documented local fallback hex. No raw hex
 * outside this block.
 */
.cr-view {
  --cr-done: var(--color-wr-status-working, #16a34a);
  --cr-active: var(--color-wr-action-blue, #1863dc);
  --cr-waiting: var(--color-wr-status-waiting, #eab308);
  --cr-pressure: #c2590f; /* local: no global orange token (deferred) */
  --cr-blocked: var(--color-wr-coral, #ff7759);
  --cr-muted: var(--color-wr-subtle, #93939f);

  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: auto;
  height: 100%;
}

.cr-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}
.cr-stamp {
  color: var(--cr-muted);
  font-size: 0.8125rem;
}
.cr-empty {
  color: var(--cr-muted);
  font-size: 0.8125rem;
  padding: 0.5rem 0;
}

/* ── Vitals chips ─────────────────────────────────────────── */
.cr-vitals {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.cr-vital {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 0.5rem;
  background: transparent;
  font-size: 0.8125rem;
  color: var(--cr-muted);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease,
    background 0.15s ease;
}
.cr-vital--static {
  cursor: default;
}
.cr-vital[data-tone="active"] {
  color: var(--cr-active);
}
.cr-vital[data-tone="blocked"] {
  color: var(--cr-blocked);
}
.cr-vital[data-tone="pressure"] {
  color: var(--cr-pressure);
}
.cr-vital[data-active] {
  border-color: currentcolor;
  background: color-mix(in srgb, currentcolor 8%, transparent);
}
.cr-vital-n {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 0.95rem;
}
.cr-vital-label {
  color: var(--cr-muted);
}

/* ── Schematic canvas ─────────────────────────────────────── */
.cr-canvas-wrap {
  position: relative;
  overflow: auto;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 0.75rem;
  background:
    linear-gradient(var(--color-border, #eef0f2) 1px, transparent 1px) 0 0 / 100% 64px,
    var(--color-background, #fff);
  background-blend-mode: normal;
}
.cr-canvas {
  display: block;
}

.cr-lane-header {
  fill: var(--cr-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

/* edges */
.cr-edge {
  stroke: var(--cr-muted);
  stroke-width: 1.25;
  transition:
    stroke 0.15s ease,
    opacity 0.15s ease;
}
.cr-edge[data-state="dim"] {
  opacity: 0.18;
}
.cr-edge[data-state="highlight"] {
  stroke: var(--cr-active);
  stroke-width: 1.75;
}
.cr-arrow-head {
  fill: var(--cr-muted);
}

/* nodes */
.cr-node {
  cursor: pointer;
  animation: cr-node-in 0.22s ease both;
}
.cr-node-box {
  fill: var(--color-background, #fff);
  stroke: var(--cr-muted);
  stroke-width: 1.25;
  transition:
    stroke-width 0.15s ease,
    fill-opacity 0.15s ease,
    stroke-opacity 0.15s ease;
}
.cr-node[data-tone="done"] .cr-node-box {
  stroke: var(--cr-done);
}
.cr-node[data-tone="active"] .cr-node-box {
  stroke: var(--cr-active);
}
.cr-node[data-tone="waiting"] .cr-node-box {
  stroke: var(--cr-waiting);
}
.cr-node[data-tone="pressure"] .cr-node-box {
  stroke: var(--cr-pressure);
}
.cr-node[data-tone="blocked"] .cr-node-box {
  stroke: var(--cr-blocked);
}
.cr-node-label {
  fill: var(--color-foreground, #1a1a1a);
  font-size: 12px;
  font-weight: 500;
}
.cr-node-phase {
  fill: var(--cr-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.cr-node-flag {
  color: var(--cr-blocked);
}

/* interaction states — dim/highlight target children so they never fight the
   group's enter animation (which pins group opacity via fill-mode: both). */
.cr-node[data-state="dim"] .cr-node-box {
  stroke-opacity: 0.3;
  fill-opacity: 0.5;
}
.cr-node[data-state="dim"] .cr-node-label,
.cr-node[data-state="dim"] .cr-node-phase,
.cr-node[data-state="dim"] .cr-node-flag {
  opacity: 0.3;
}
.cr-node[data-state="highlight"] .cr-node-box,
.cr-node[data-selected] .cr-node-box {
  stroke-width: 2;
}
.cr-node[data-selected] .cr-node-box {
  filter: drop-shadow(0 1px 4px rgb(0 0 0 / 0.12));
}

/* attention pulse on the box (separate element from the group animation) */
.cr-node[data-attention] .cr-node-box {
  animation: cr-pulse 1.8s ease-in-out infinite;
}

@keyframes cr-node-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes cr-pulse {
  0%,
  100% {
    stroke-width: 1.5;
  }
  50% {
    stroke-width: 2.75;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cr-node,
  .cr-node[data-attention] .cr-node-box {
    animation: none;
  }
}

/* ── Tooltip ──────────────────────────────────────────────── */
.cr-tooltip {
  position: absolute;
  min-width: 12rem;
  max-width: 18rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 0.5rem;
  background: var(--color-background, #fff);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.1);
  pointer-events: none;
  z-index: 10;
}
.cr-tooltip-lane {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cr-muted);
}
.cr-tooltip-title {
  font-size: 0.9rem;
  font-weight: 600;
  margin: 0.1rem 0 0.4rem;
  word-break: break-word;
}
.cr-tooltip-meta {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin: 0;
  font-size: 0.78rem;
}
.cr-tooltip-meta > div {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
.cr-tooltip-meta dt {
  color: var(--cr-muted);
}
.cr-tooltip-meta dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.cr-tooltip-id {
  word-break: break-all;
  text-align: right;
}
```

- [ ] **Step 3: Verify gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS. (Old `bucketSessions` helper stays exported/tested; that's fine.)

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/control-room/ControlRoomView.tsx src/components/control-room/ControlRoomView.css
git add src/components/control-room/ControlRoomView.tsx src/components/control-room/ControlRoomView.css
git commit -m "feat(control-room): blueprint schematic view replaces 4-card lists"
```

---

## Task 10: Final verification gates + bindings drift check

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate set**

```bash
cd /Users/davidpark/private_project/work-radar-wt/control-room
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all PASS. `pnpm build`(tsc && vite build) confirms no SVG/JSX prop type errors and the bundle compiles with `motion`.

- [ ] **Step 2: Confirm no bindings drift (Rust untouched)**

Run: `git diff --name-only dev...HEAD | grep -E 'bindings.ts|src-tauri/' || echo "no rust/bindings change ✓"`
Expected: `no rust/bindings change ✓`

- [ ] **Step 3: Live smoke = user/cmux**

The native Tauri WKWebView visual + interaction smoke (hover lineage, attention pulse, Vitals filter, Esc deselect, tooltip placement) must be run by the user / cmux — agents cannot drive the native webview. Note this explicitly in the PR body; do not claim visual verification.

---

## Definition of Done

- [ ] `controlRoomGraph.test.ts` green (deriveEdges, computeVitals, nodeMatchesVital, buildSchematic, lineageOf).
- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build` all green.
- [ ] No `bindings.ts` / `src-tauri/` diff (frontend-only; full-DAG = separate backend PR).
- [ ] Spec §14 non-scope respected (no mutations, no pan/zoom, no unrelated refactor).
- [ ] Separate reviewer/critic pass ACCEPT (no self-approve) before any push.
- [ ] Live visual smoke flagged as user/cmux.

## Self-Review (done at authoring)

- **Spec coverage:** §4 arch→Tasks 1–9; §5 data model→Task 1; §6 layout→Task 3; §7 tones/attention/vitals→Tasks 2–3,5; §8 interaction→Task 8; §9 backend follow-up→explicitly out of scope; §10 motion→Tasks 0,6; §11 aesthetic→Task 9 CSS; §12 testing→Tasks 1–4,10; §13 files→all tasks.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `GraphNode`/`GraphEdge`/`NodeState`/`VitalKey` names identical across Tasks 1–8; `nodeMatchesVital` signature matches Vitals/Schematic usage; geometry constants (`PAD_X`,`LANE_W`,`NODE_W`,`NODE_H`,`LANE_HEADER_H`) defined in Task 1 and consumed unchanged.
