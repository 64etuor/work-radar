import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeSpec, acceptSpec, archiveSpec, listSpecs, specTrail } from "../../src/spec/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-spec-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("spec handlers — author + lifecycle", () => {
  it("propose writes EXACTLY ONE spec_proposed, actor=author (NOT user), draft phase", async () => {
    const { specId } = await proposeSpec(dir, { title: "Governance MCP", summary: "s" }, at(0), 0.1);
    const all = await readAllEvents(dir);
    const proposals = all.filter((e) => e.frontmatter.type === "spec_proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.frontmatter.id).toBe(specId);
    expect(proposals[0]!.frontmatter.actor).toBe("author");
    expect((await specTrail(dir, { specId })).phase).toBe("draft");
  });

  it("propose throws on empty title", async () => {
    await expect(proposeSpec(dir, { title: "  ", summary: "s" }, at(0), 0.1)).rejects.toThrow(/title/i);
  });

  it("STRUCTURAL INVARIANT #1: the author's propose path writes ZERO spec_accepted (cannot self-accept)", async () => {
    await proposeSpec(dir, { title: "X", summary: "" }, at(0), 0.1);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "spec_accepted")).toBe(false);
    // Symmetric actor invariant: a proposal is never actor:user (author-only write path).
    expect(all.filter((e) => e.frontmatter.type === "spec_proposed").every((e) => e.frontmatter.actor !== "user")).toBe(true);
  });

  it("STRUCTURAL: no spec_accepted is ever actor=author (acceptance is the human gate only)", async () => {
    const { specId } = await proposeSpec(dir, { title: "X", summary: "" }, at(0), 0.1);
    await acceptSpec(dir, { specId }, at(1), 0.2);
    const all = await readAllEvents(dir);
    expect(all.filter((e) => e.frontmatter.type === "spec_accepted").every((e) => e.frontmatter.actor !== "author")).toBe(true);
  });

  it("accept_spec writes spec_accepted with actor=user (human gate); draft → accepted", async () => {
    const { specId } = await proposeSpec(dir, { title: "X", summary: "" }, at(0), 0.1);
    const r = await acceptSpec(dir, { specId }, at(1), 0.2);
    expect(r.ok).toBe(true);
    const acc = (await readAllEvents(dir)).find((e) => e.frontmatter.type === "spec_accepted");
    expect(acc!.frontmatter.actor).toBe("user");
    expect((await specTrail(dir, { specId })).phase).toBe("accepted");
  });

  it("accept is REFUSED on an already-accepted spec, and writes nothing", async () => {
    const { specId } = await proposeSpec(dir, { title: "X", summary: "" }, at(0), 0.1);
    await acceptSpec(dir, { specId }, at(1), 0.2);
    const r = await acceptSpec(dir, { specId }, at(2), 0.3);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/accepted/i);
    expect((await readAllEvents(dir)).filter((e) => e.frontmatter.type === "spec_accepted")).toHaveLength(1);
  });

  it("propose → accept → archive; trail in order, terminal archived", async () => {
    const { specId } = await proposeSpec(dir, { title: "X", summary: "" }, at(0), 0.1);
    expect((await acceptSpec(dir, { specId }, at(1), 0.2)).ok).toBe(true);
    expect((await archiveSpec(dir, { specId }, at(2), 0.3)).ok).toBe(true);
    const trail = await specTrail(dir, { specId });
    expect(trail.phase).toBe("archived");
    expect(trail.chain.map((c) => c.type)).toEqual(["spec_proposed", "spec_accepted", "spec_archived"]);
  });

  it("NEGATIVE: spec commands write ZERO decision_*, task_*, and plan_* events", async () => {
    const { specId } = await proposeSpec(dir, { title: "X", summary: "" }, at(0), 0.1);
    await acceptSpec(dir, { specId }, at(1), 0.2);
    await archiveSpec(dir, { specId }, at(2), 0.3);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type.startsWith("decision_"))).toBe(false);
    expect(all.some((e) => e.frontmatter.type.startsWith("task_"))).toBe(false);
    expect(all.some((e) => e.frontmatter.type.startsWith("plan_"))).toBe(false);
  });

  it("listSpecs omits archived specs", async () => {
    const a = await proposeSpec(dir, { title: "alive", summary: "" }, at(0), 0.1);
    const b = await proposeSpec(dir, { title: "gone", summary: "" }, at(1), 0.2);
    await archiveSpec(dir, { specId: b.specId }, at(2), 0.3);
    const open = await listSpecs(dir);
    expect(open.map((sp) => sp.specId)).toEqual([a.specId]);
  });
});
