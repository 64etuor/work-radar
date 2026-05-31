import { describe, it, expect } from "vitest";
import { serializeEvent, parseEvent, type GovEvent } from "../../src/event/event.js";

const sample: GovEvent = {
  frontmatter: {
    id: "evt_20260516_143218_a3d7",
    type: "task_created",
    source: "hermes",
    actor: "user",
    tags: ["task"],
  },
  body: "본문 서술.",
};

describe("serialize/parse round-trip", () => {
  it("round-trips frontmatter + body", () => {
    const raw = serializeEvent(sample);
    const back = parseEvent(raw);
    expect(back.frontmatter.id).toBe(sample.frontmatter.id);
    expect(back.frontmatter.type).toBe("task_created");
    expect(back.frontmatter.tags).toEqual(["task"]);
    expect(back.body).toBe("본문 서술.");
  });

  it("throws when a required field is missing on serialize", () => {
    const bad = { frontmatter: { ...sample.frontmatter, id: undefined as any }, body: "x" };
    expect(() => serializeEvent(bad)).toThrow(/required field: id/);
  });

  it("throws when a required field is missing on parse", () => {
    expect(() => parseEvent("---\ntype: task_created\n---\nx")).toThrow(/required field/);
  });
});
