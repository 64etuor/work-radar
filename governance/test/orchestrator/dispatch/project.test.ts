import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubAdapter } from "../../../src/conductor/adapter.js";
import { generateId } from "../../../src/event/id.js";
import { writeEvent } from "../../../src/event/writeEvent.js";
import { autoDispatch } from "../../../src/orchestrator/dispatch/dispatch.js";
import { listDispatchLog } from "../../../src/orchestrator/dispatch/project.js";

const RAND = 0.42;
let ws: string;
let sec = 0;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-dispatch-log-"));
  sec = 0;
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const at = () => new Date(Date.UTC(2026, 5, 3, 0, 0, sec++));

describe("listDispatchLog", () => {
  it("returns dispatch trail entries sorted by id", async () => {
    const proposedAt = at();
    const planId = generateId("evt", proposedAt, RAND);
    await writeEvent(ws, {
      frontmatter: {
        id: planId,
        type: "plan_proposed",
        source: "hermes",
        actor: "planner",
        tags: ["plan"],
        related_to: [],
      },
      body: "intent\n\n1. a",
    }, proposedAt);
    const acceptedAt = at();
    await writeEvent(ws, {
      frontmatter: {
        id: generateId("evt", acceptedAt, RAND),
        type: "plan_accepted",
        source: "hermes",
        actor: "user",
        tags: ["plan"],
        related_to: [planId],
      },
      body: "ok",
    }, acceptedAt);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    const log = await listDispatchLog(ws);

    expect(log.map((e) => e.type)).toContain("instruction_planned");
    expect(log.map((e) => e.type)).toContain("orchestrator_action_executed");
    const ids = log.map((e) => e.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });
});
