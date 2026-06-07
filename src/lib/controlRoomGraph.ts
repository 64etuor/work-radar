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

export type VitalKey = "inProgress" | "blocked" | "awaitingHuman";

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
        (n.lane === "session" &&
          (n.phase === "checkpoint_requested" || n.phase === "handoff_ready"))
      );
    default:
      return false;
  }
}

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
  for (const sp of snap.specs)
    drafts.push(draft("spec", sp.specId, sp.title, sp.phase, false, null));
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
