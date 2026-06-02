import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeSpec, acceptSpec, archiveSpec } from "../../src/spec/handlers.js";
import { projectSpecs, renderSpecs } from "../../src/spec/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-specproj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function seed() {
  const a = await proposeSpec(dir, { title: "alpha", summary: "" }, at(0), 0.1);
  await acceptSpec(dir, { specId: a.specId }, at(1), 0.2);
  const b = await proposeSpec(dir, { title: "beta", summary: "" }, at(2), 0.3);
  return { a, b };
}

describe("spec projector", () => {
  it("projectSpecs is pure: no I/O, emits no events, stable across calls", async () => {
    await seed();
    const all = await readAllEvents(dir);
    const before = all.length;
    const r1 = projectSpecs(all);
    const r2 = projectSpecs(all);
    expect(r1).toEqual(r2);
    expect((await readAllEvents(dir)).length).toBe(before);
  });

  it("KEYSTONE: wipe state/ and re-render → byte-identical (projection = f(events))", async () => {
    await seed();
    const p = await renderSpecs(dir);
    const first = await readFile(p, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    const p2 = await renderSpecs(dir);
    const second = await readFile(p2, "utf8");
    expect(second).toBe(first);
  });

  it("projection reflects derived phases", async () => {
    const { a, b } = await seed();
    await archiveSpec(dir, { specId: a.specId }, at(5), 0.6);
    const states = projectSpecs(await readAllEvents(dir));
    const byId = Object.fromEntries(states.map((s) => [s.specId, s.phase]));
    expect(byId[a.specId]).toBe("archived");
    expect(byId[b.specId]).toBe("draft");
  });
});
