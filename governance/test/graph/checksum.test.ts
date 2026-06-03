import { describe, it, expect } from "vitest";
import { checksumProjection } from "../../src/graph/checksum.js";
import type { GraphProjection } from "../../src/graph/types.js";

const base: GraphProjection = {
  events: [
    {
      event_id: "b", content_hash: "h2", event_type: "task_created", occurred_at: null, actor: "u",
      source: "hermes", subject_type: "task", subject_id: "b", authority_decision_id: null, payload_jsonb: {},
    },
    {
      event_id: "a", content_hash: "h1", event_type: "task_started", occurred_at: null, actor: "u",
      source: "agent_run", subject_type: "task", subject_id: "b", authority_decision_id: null, payload_jsonb: {},
    },
  ],
  nodes: [
    { node_id: "task:b", node_type: "task", canonical_id: "b", title: "T", state_jsonb: { phase: "active" } },
  ],
  edges: [],
};

describe("checksumProjection", () => {
  it("is independent of input row order", () => {
    const shuffled: GraphProjection = { ...base, events: [...base.events].reverse() };
    expect(checksumProjection(base)).toBe(checksumProjection(shuffled));
  });

  it("changes when any row content changes", () => {
    const mutated: GraphProjection = {
      ...base,
      nodes: [{ ...base.nodes[0], state_jsonb: { phase: "done" } }],
    };
    expect(checksumProjection(mutated)).not.toBe(checksumProjection(base));
  });
});
