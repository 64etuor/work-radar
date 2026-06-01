# P3 Slice 2a — Gateway L0 Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand, idempotent `harvest` MCP command that scans repo activity (git log + `docs/decisions.md` + `docs/adr/*.md`) and writes content-addressed L0 events into the gitignored event store.

**Architecture:** Pure parsers/mappers (`parseGitLog`, source mappers) feed a thin orchestrator (`harvest`) whose impure dependencies — a git-log runner, the Slice-1 `buildIndex` row loader, and an idempotent event writer — are injected at the MCP boundary, exactly mirroring how `server.ts` injects `spawn`/`nowFn` and `buildIndex` injects `fs`. Events are content-addressed (full source identity in the id; sha7/hash7 only in filenames), so re-running writes nothing new via `writeEvent`'s `wx` flag.

**Tech Stack:** Node 24 (`--experimental-strip-types`), TypeScript (`.ts` runtime imports / `.js` test imports), vitest, `gray-matter` (via reused Slice-1 parsers), `node:crypto`, `node:child_process`. No new dependency, no DB, no network beyond local `git`.

**Spec:** `docs/superpowers/specs/2026-06-01-ssot-governance-harness-l0-harvest-design.md`

**Working directory for all commands:** `governance/` (run `pnpm test` / `pnpm exec tsc --noEmit` from there).

**Reused, already-tested units (do not modify):** `src/index/build.ts` (`buildIndex`, `nodeIndexFs`), `src/index/types.ts` (`DecisionRow`), `src/index/decisionLog.ts`, `src/index/adr.ts`, `src/event/event.ts` (`GovEvent`, `EventType`, `EventSource`).

---

## File Structure

| File                            | Responsibility                                         | New/Modify               |
| ------------------------------- | ------------------------------------------------------ | ------------------------ |
| `src/event/id.ts`               | add `sha256hex` + `deriveEventId` (deterministic ids)  | Modify (additive)        |
| `src/event/writeEvent.ts`       | add optional `{ disambiguator, dayBucket }` opts       | Modify (back-compatible) |
| `src/harvest/gitLog.ts`         | pure `parseGitLog` + impure boundary `realGitLog`      | Create                   |
| `src/harvest/sources.ts`        | `RawCommit`/`DecisionRow` → `HarvestItem` mappers      | Create                   |
| `src/harvest/harvest.ts`        | `harvest` orchestrator + `makeWriteOne` writer factory | Create                   |
| `src/mcp/server.ts`             | register the `harvest` MCP command (thin glue)         | Modify                   |
| `test/event/id.test.ts`         | `deriveEventId`/`sha256hex` cases                      | Modify                   |
| `test/event/writeEvent.test.ts` | disambiguator + dayBucket cases                        | Modify                   |
| `test/harvest/gitLog.test.ts`   | `parseGitLog` cases                                    | Create                   |
| `test/harvest/sources.test.ts`  | mapper cases                                           | Create                   |
| `test/harvest/harvest.test.ts`  | orchestrator (fakes) + real-tmpdir idempotency         | Create                   |
| `docs/decisions.md`             | one-line breadcrumb                                    | Modify                   |

`realGitLog` is the only impure, non-unit-tested unit (a thin `execFile` wrapper, like `server.ts`'s `nodeSpawn`); everything below the injection boundary is deterministically tested.

---

### Task 1: Deterministic event ids (`deriveEventId` + `sha256hex`)

**Files:**

- Modify: `src/event/id.ts`
- Test: `test/event/id.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/event/id.test.ts`:

```ts
import { deriveEventId, sha256hex } from "../../src/event/id.js";

describe("sha256hex", () => {
  it("is stable and 64 hex chars", () => {
    expect(sha256hex("abc")).toBe(sha256hex("abc"));
    expect(sha256hex("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256hex("abc")).not.toBe(sha256hex("abd"));
  });
});

describe("deriveEventId", () => {
  it("embeds full source identity, never truncated", () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";
    expect(deriveEventId("commit", sha)).toBe(`evt_commit_${sha}`);
    expect(deriveEventId("adr", "ADR-0007")).toBe("evt_adr_ADR-0007");
  });
  it("hashes the normalized text for decision ids", () => {
    const key = "some decision bullet";
    expect(deriveEventId("decision", key)).toBe(`evt_decision_${sha256hex(key)}`);
  });
  it("is deterministic across calls", () => {
    expect(deriveEventId("commit", "deadbeef")).toBe(deriveEventId("commit", "deadbeef"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/event/id.test.ts`
Expected: FAIL — `deriveEventId`/`sha256hex` are not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/event/id.ts`:

```ts
import { createHash } from "node:crypto";

/** Stable lowercase sha256 hex of a string. */
export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deterministic event id from full, stable source identity.
 *  commit  → evt_commit_<full-40-hex-sha>
 *  adr     → evt_adr_<full-adr-id>            (e.g. evt_adr_ADR-0007)
 *  decision→ evt_decision_<sha256(normalized bullet text)>
 *  No truncation in the id itself; sha7/hash7 are filename/display-only. */
export function deriveEventId(kind: "commit" | "adr" | "decision", sourceKey: string): string {
  if (kind === "commit") return `evt_commit_${sourceKey}`;
  if (kind === "adr") return `evt_adr_${sourceKey}`;
  return `evt_decision_${sha256hex(sourceKey)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/event/id.test.ts`
Expected: PASS (existing `generateId`/`stampUtc` tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/event/id.ts test/event/id.test.ts
git commit -m "feat(governance): deterministic deriveEventId + sha256hex (P3 harvest)"
```

---

### Task 2: `writeEvent` optional disambiguator + dayBucket

**Files:**

- Modify: `src/event/writeEvent.ts`
- Test: `test/event/writeEvent.test.ts`

**Why:** harvested events need (a) a filename suffix encoding source identity so same-second/same-type items never collide, and (b) a non-date `undated` day bucket for dateless items. Existing callers (`handlers.ts`, `decision/handlers.ts`, `reviewer.ts`) pass no opts and must be unaffected.

- [ ] **Step 1: Write the failing test** — append to `test/event/writeEvent.test.ts` (match the file's existing imports/`ws` setup; if it has none, use the block below verbatim):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/event/writeEvent.js";
import type { GovEvent } from "../../src/event/event.js";

const evt: GovEvent = {
  frontmatter: { id: "evt_x", type: "commit_recorded", source: "git", actor: "alice", tags: [] },
  body: "did a thing",
};
const at = new Date(Date.UTC(2026, 5, 1, 9, 8, 7));

describe("writeEvent options", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "boule-we-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("appends a disambiguator suffix to the filename", async () => {
    const p = await writeEvent(ws, evt, at, { disambiguator: "a1b2c3d" });
    expect(p.endsWith("09-08-07_commit_recorded_a1b2c3d.md")).toBe(true);
    expect(p).toContain("/events/2026-06-01/");
  });

  it("routes to an undated day bucket when dayBucket is set", async () => {
    const p = await writeEvent(ws, evt, new Date(0), {
      disambiguator: "deadbee",
      dayBucket: "undated",
    });
    expect(p).toContain("/events/undated/");
    expect(p.endsWith("00-00-00_commit_recorded_deadbee.md")).toBe(true);
  });

  it("is unchanged with no opts (back-compat) and immutable on re-write", async () => {
    const p = await writeEvent(ws, evt, at);
    expect(p.endsWith("09-08-07_commit_recorded.md")).toBe(true);
    await expect(writeEvent(ws, evt, at)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/event/writeEvent.test.ts`
Expected: FAIL — `writeEvent` does not accept a 4th opts arg (disambiguator/dayBucket ignored).

- [ ] **Step 3: Write minimal implementation** — replace the body of `src/event/writeEvent.ts` with:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stampUtc } from "./id.ts";
import { serializeEvent, type GovEvent } from "./event.ts";

export interface WriteEventOptions {
  /** Filename suffix encoding source identity (sha7 / adr-id / hash7). */
  disambiguator?: string;
  /** Day-dir override (e.g. "undated"); default = YYYY-MM-DD derived from `now`. */
  dayBucket?: string;
}

/** Append-only write: events/<day>/HH-MM-SS_<type>[_<disambiguator>].md. Immutable (wx). */
export async function writeEvent(
  workspaceDir: string,
  evt: GovEvent,
  now: Date,
  opts: WriteEventOptions = {},
): Promise<string> {
  const s = stampUtc(now); // YYYYMMDD_HHMMSS
  const day = opts.dayBucket ?? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const hms = `${s.slice(9, 11)}-${s.slice(11, 13)}-${s.slice(13, 15)}`;
  const suffix = opts.disambiguator ? `_${opts.disambiguator}` : "";
  const dir = join(workspaceDir, "events", day);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${hms}_${evt.frontmatter.type}${suffix}.md`);
  await writeFile(file, serializeEvent(evt), { flag: "wx" }); // wx: fail if exists → immutable/idempotent
  return file;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run test/event/writeEvent.test.ts test/mcp/handlers.test.ts test/decision/handlers.test.ts`
Expected: PASS — new opts work AND existing callers (no opts) are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/event/writeEvent.ts test/event/writeEvent.test.ts
git commit -m "feat(governance): writeEvent disambiguator + dayBucket opts (P3 harvest)"
```

---

### Task 3: `parseGitLog` (pure) + `realGitLog` (boundary)

**Files:**

- Create: `src/harvest/gitLog.ts`
- Test: `test/harvest/gitLog.test.ts`

**Format contract:** the runner emits `--pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1e` — fields unit-separated (`\x1f`), records separated (`\x1e`). This avoids newline/colon ambiguity in subjects.

- [ ] **Step 1: Write the failing test** — create `test/harvest/gitLog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseGitLog } from "../../src/harvest/gitLog.js";

const US = "\x1f";
const RS = "\x1e";
const rec = (sha: string, iso: string, an: string, subj: string) =>
  [sha, iso, an, subj].join(US) + RS;

describe("parseGitLog", () => {
  it("parses unit/record-separated commits", () => {
    const raw =
      rec("a".repeat(40), "2026-06-01T09:08:07+09:00", "Alice", "feat: x") +
      rec("b".repeat(40), "2026-05-30T12:00:00Z", "Bob", "fix: y");
    const out = parseGitLog(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sha).toBe("a".repeat(40));
    expect(out[0].author).toBe("Alice");
    expect(out[0].subject).toBe("feat: x");
    expect(out[0].committedAt.toISOString()).toBe("2026-06-01T00:08:07.000Z");
  });

  it("skips blank/malformed records and bad dates", () => {
    const raw =
      rec("c".repeat(40), "2026-06-01T00:00:00Z", "C", "ok") +
      "   " +
      RS + // blank
      ["d".repeat(40), "not-a-date", "D", "z"].join(US) +
      RS; // bad date
    const out = parseGitLog(raw);
    expect(out.map((c) => c.author)).toEqual(["C"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/harvest/gitLog.test.ts`
Expected: FAIL — module `src/harvest/gitLog.ts` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/harvest/gitLog.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface RawCommit {
  sha: string; // full 40-hex commit hash (stable identity)
  committedAt: Date; // committer date
  author: string; // author name → event actor
  subject: string; // first line → event body
}

const US = "\x1f";
const RS = "\x1e";

/** Pure: parse `git log --pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1e` stdout. */
export function parseGitLog(raw: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const record of raw.split(RS)) {
    const r = record.trim();
    if (!r) continue;
    const parts = r.split(US);
    if (parts.length < 4) continue;
    const [sha, iso, author, ...rest] = parts;
    if (!sha.trim() || !iso.trim()) continue;
    const committedAt = new Date(iso.trim());
    if (Number.isNaN(committedAt.getTime())) continue;
    out.push({
      sha: sha.trim(),
      committedAt,
      author: author.trim(),
      subject: rest.join(US).trim(),
    });
  }
  return out;
}

/** Impure boundary: run `git log` in repoRoot and return raw stdout. */
export async function realGitLog(repoRoot: string): Promise<string> {
  const { stdout } = await pexec(
    "git",
    ["-C", repoRoot, "log", "--no-color", `--pretty=format:%H${US}%cI${US}%an${US}%s${RS}`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/harvest/gitLog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/gitLog.ts test/harvest/gitLog.test.ts
git commit -m "feat(governance): parseGitLog + realGitLog boundary (P3 harvest)"
```

---

### Task 4: Source mappers (`commitItem` / `adrItem` / `decisionItem`)

**Files:**

- Create: `src/harvest/sources.ts`
- Test: `test/harvest/sources.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/harvest/sources.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { commitItem, adrItem, decisionItem } from "../../src/harvest/sources.js";
import { sha256hex } from "../../src/event/id.js";
import type { RawCommit } from "../../src/harvest/gitLog.js";
import type { DecisionRow } from "../../src/index/types.js";

const commit: RawCommit = {
  sha: "a".repeat(40),
  committedAt: new Date(Date.UTC(2026, 5, 1, 9, 8, 7)),
  author: "Alice",
  subject: "feat: thing",
};

const adrRow: DecisionRow = {
  id: "ADR-0007",
  kind: "adr",
  title: "Approval Surface",
  status: "accepted",
  date: "2026-06-01",
  tags: ["governance"],
  supersedes: [],
  refs: ["ADR-0003"],
  excerpt: "…",
  sourcePath: "docs/adr/0007.md",
};

const dlRow: DecisionRow = {
  id: "DL-005",
  kind: "decision-log",
  title: "Some Phase tradeoff",
  status: undefined,
  date: undefined,
  tags: [],
  supersedes: [],
  refs: [],
  excerpt: "…",
  sourcePath: "docs/decisions.md",
};

describe("commitItem", () => {
  it("maps a commit to a content-addressed event item", () => {
    const it_ = commitItem(commit);
    expect(it_.id).toBe(`evt_commit_${"a".repeat(40)}`);
    expect(it_.type).toBe("commit_recorded");
    expect(it_.source).toBe("git");
    expect(it_.actor).toBe("Alice");
    expect(it_.body).toBe("feat: thing");
    expect(it_.stampAt).toBe(commit.committedAt);
    expect(it_.dayBucket).toBeUndefined();
    expect(it_.disambiguator).toBe("a".repeat(7));
  });
});

describe("adrItem", () => {
  it("uses the ADR date and carries refs", () => {
    const it_ = adrItem(adrRow);
    expect(it_.id).toBe("evt_adr_ADR-0007");
    expect(it_.type).toBe("decision_proposed");
    expect(it_.source).toBe("adr");
    expect(it_.refs).toEqual(["ADR-0003"]);
    expect(it_.stampAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(it_.dayBucket).toBeUndefined();
    expect(it_.disambiguator).toBe("ADR-0007");
  });
  it("falls back to undated when the ADR has no date", () => {
    const it_ = adrItem({ ...adrRow, date: undefined });
    expect(it_.dayBucket).toBe("undated");
    expect(it_.stampAt.getTime()).toBe(0);
  });
});

describe("decisionItem", () => {
  it("is content-hash based and always undated", () => {
    const it_ = decisionItem(dlRow);
    const key = "some phase tradeoff";
    expect(it_.id).toBe(`evt_decision_${sha256hex(key)}`);
    expect(it_.type).toBe("decision_recorded");
    expect(it_.source).toBe("decisions_doc");
    expect(it_.dayBucket).toBe("undated");
    expect(it_.disambiguator).toBe(sha256hex(key).slice(0, 7));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/harvest/sources.test.ts`
Expected: FAIL — module `src/harvest/sources.ts` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/harvest/sources.ts`:

```ts
import type { EventType, EventSource } from "../event/event.ts";
import type { DecisionRow } from "../index/types.ts";
import type { RawCommit } from "./gitLog.ts";
import { deriveEventId, sha256hex } from "../event/id.ts";

export interface HarvestItem {
  id: string;
  type: EventType;
  source: EventSource;
  actor: string;
  body: string;
  tags: string[];
  refs?: string[];
  stampAt: Date; // historical date for path/time
  dayBucket?: string; // "undated" for dateless items; else derived from stampAt
  disambiguator: string; // short, collision-free filename suffix
}

const EPOCH = new Date(0);

export function commitItem(c: RawCommit): HarvestItem {
  return {
    id: deriveEventId("commit", c.sha),
    type: "commit_recorded",
    source: "git",
    actor: c.author || "unknown",
    body: c.subject,
    tags: [],
    stampAt: c.committedAt,
    disambiguator: c.sha.slice(0, 7),
  };
}

export function adrItem(row: DecisionRow): HarvestItem {
  const dated = row.date ? new Date(`${row.date}T00:00:00Z`) : null;
  const valid = dated && !Number.isNaN(dated.getTime()) ? dated : null;
  return {
    id: deriveEventId("adr", row.id),
    type: "decision_proposed",
    source: "adr",
    actor: "system",
    body: row.title,
    tags: row.tags,
    refs: row.refs.length ? row.refs : undefined,
    stampAt: valid ?? EPOCH,
    dayBucket: valid ? undefined : "undated",
    disambiguator: row.id,
  };
}

export function decisionItem(row: DecisionRow): HarvestItem {
  const key = row.title.trim().replace(/\s+/g, " ").toLowerCase(); // normalized bullet text
  return {
    id: deriveEventId("decision", key),
    type: "decision_recorded",
    source: "decisions_doc",
    actor: "system",
    body: row.title,
    tags: [],
    refs: row.refs.length ? row.refs : undefined,
    stampAt: EPOCH,
    dayBucket: "undated",
    disambiguator: sha256hex(key).slice(0, 7),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/harvest/sources.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/sources.ts test/harvest/sources.test.ts
git commit -m "feat(governance): harvest source mappers commit/adr/decision (P3 harvest)"
```

---

### Task 5: `harvest` orchestrator + `makeWriteOne`

**Files:**

- Create: `src/harvest/harvest.ts`
- Test: `test/harvest/harvest.test.ts`

**Design:** the orchestrator depends only on injected functions — `gitLog()` (raw stdout), `loadDecisionRows()` (wraps `buildIndex().decisions`), and `writeOne(item)` (returns `"written"`/`"skipped"`). `makeWriteOne(workspaceDir)` is the real writer: it builds the `GovEvent` and calls `writeEvent`, mapping an `EEXIST` (already-harvested) to `"skipped"`. Both sources fail soft.

- [ ] **Step 1: Write the failing test** — create `test/harvest/harvest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvest, makeWriteOne } from "../../src/harvest/harvest.js";
import { status } from "../../src/mcp/handlers.js";
import type { DecisionRow } from "../../src/index/types.js";

const US = "\x1f";
const RS = "\x1e";
const gitOut =
  ["a".repeat(40), "2026-06-01T00:00:00Z", "Alice", "feat: x"].join(US) +
  RS +
  ["b".repeat(40), "2026-05-30T00:00:00Z", "Bob", "fix: y"].join(US) +
  RS;

const rows: DecisionRow[] = [
  {
    id: "ADR-0007",
    kind: "adr",
    title: "Surface",
    status: "accepted",
    date: "2026-06-01",
    tags: [],
    supersedes: [],
    refs: [],
    excerpt: "",
    sourcePath: "docs/adr/0007.md",
  },
  {
    id: "DL-001",
    kind: "decision-log",
    title: "A tradeoff",
    status: undefined,
    date: undefined,
    tags: [],
    supersedes: [],
    refs: [],
    excerpt: "",
    sourcePath: "docs/decisions.md",
  },
];

describe("harvest (fakes)", () => {
  it("tallies written vs skipped and is idempotent on a second run", async () => {
    const seen = new Set<string>();
    const writeOne = async (item: { id: string }) => {
      if (seen.has(item.id)) return "skipped" as const;
      seen.add(item.id);
      return "written" as const;
    };
    const deps = {
      gitLog: async () => gitOut,
      loadDecisionRows: async () => rows,
      writeOne,
    };
    const first = await harvest(deps);
    expect(first.written).toBe(4); // 2 commits + 1 adr + 1 decision
    expect(first.skipped).toBe(0);

    const second = await harvest(deps);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(4);
  });

  it("fails soft when git is unavailable (0 commit events, no throw)", async () => {
    const deps = {
      gitLog: async () => {
        throw new Error("not a git repo");
      },
      loadDecisionRows: async () => rows,
      writeOne: async () => "written" as const,
    };
    const s = await harvest(deps);
    expect(s.written).toBe(2); // only the 2 decision rows; commits contributed 0
  });
});

describe("makeWriteOne (real fs)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "boule-harvest-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("writes events once, skips on re-harvest, and the store is rebuilt identically", async () => {
    const deps = {
      gitLog: async () => gitOut,
      loadDecisionRows: async () => rows,
      writeOne: makeWriteOne(ws),
    };
    const first = await harvest(deps);
    expect(first.written).toBe(4);
    expect((await status(ws)).eventCount).toBe(4);

    const second = await harvest(deps);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(4);
    expect((await status(ws)).eventCount).toBe(4); // no duplicates
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/harvest/harvest.test.ts`
Expected: FAIL — module `src/harvest/harvest.ts` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/harvest/harvest.ts`:

```ts
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import type { DecisionRow } from "../index/types.ts";
import { parseGitLog } from "./gitLog.ts";
import { commitItem, adrItem, decisionItem, type HarvestItem } from "./sources.ts";

export type WriteOutcome = "written" | "skipped";

export interface HarvestDeps {
  /** Raw `git log` stdout (or throws when git is unavailable). */
  gitLog: () => Promise<string>;
  /** Decision/ADR rows (typically buildIndex(repoRoot, fs).decisions). */
  loadDecisionRows: () => Promise<readonly DecisionRow[]>;
  /** Idempotent writer: "written" on a fresh event, "skipped" if already present. */
  writeOne: (item: HarvestItem) => Promise<WriteOutcome>;
}

export interface HarvestSummary {
  written: number;
  skipped: number;
}

/** Gather all sources → content-addressed items → idempotent writes. Fail-soft per source. */
export async function harvest(deps: HarvestDeps): Promise<HarvestSummary> {
  const items: HarvestItem[] = [];

  try {
    items.push(...parseGitLog(await deps.gitLog()).map(commitItem));
  } catch {
    // git unavailable / not a repo → 0 commit events
  }

  let rows: readonly DecisionRow[] = [];
  try {
    rows = await deps.loadDecisionRows();
  } catch {
    rows = [];
  }
  for (const row of rows) {
    items.push(row.kind === "adr" ? adrItem(row) : decisionItem(row));
  }

  const summary: HarvestSummary = { written: 0, skipped: 0 };
  for (const item of items) {
    const outcome = await deps.writeOne(item);
    if (outcome === "written") summary.written++;
    else summary.skipped++;
  }
  return summary;
}

/** Real idempotent writer over a workspace dir. EEXIST (already harvested) → "skipped". */
export function makeWriteOne(workspaceDir: string): (item: HarvestItem) => Promise<WriteOutcome> {
  return async (item) => {
    const evt: GovEvent = {
      frontmatter: {
        id: item.id,
        type: item.type,
        source: item.source,
        actor: item.actor,
        tags: item.tags,
        ...(item.refs ? { related_to: item.refs } : {}),
      },
      body: item.body,
    };
    try {
      await writeEvent(workspaceDir, evt, item.stampAt, {
        disambiguator: item.disambiguator,
        dayBucket: item.dayBucket,
      });
      return "written";
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return "skipped";
      throw e;
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/harvest/harvest.test.ts`
Expected: PASS (both the fake-injected and real-fs idempotency cases).

- [ ] **Step 5: Commit**

```bash
git add src/harvest/harvest.ts test/harvest/harvest.test.ts
git commit -m "feat(governance): harvest orchestrator + idempotent makeWriteOne (P3 harvest)"
```

---

### Task 6: Wire the `harvest` MCP command (boundary glue)

**Files:**

- Modify: `src/mcp/server.ts`

**Note on testing:** `server.ts` connects a stdio transport at import time, so (as with the Slice-1 index commands) it is **not** imported in unit tests — the logic it calls (`harvest` + `makeWriteOne`) is fully covered by Task 5. This task is thin glue verified by `tsc` + the manual smoke in Step 3.

- [ ] **Step 1: Add the imports** — in `src/mcp/server.ts`, after the existing `buildIndex` import (line ~5), add:

```ts
import { harvest, makeWriteOne } from "../harvest/harvest.ts";
import { realGitLog } from "../harvest/gitLog.ts";
import type { DecisionRow } from "../index/types.ts";
```

- [ ] **Step 2: Register the command** — add a new `server.registerTool` block alongside the other index commands (e.g. right after the `decision` tool, before the `AUTHOR_MODEL` const):

```ts
server.registerTool(
  "harvest",
  {
    description: "레포 활동(git log / decisions.md / ADR)을 L0 이벤트로 멱등 수집",
    inputSchema: {},
  },
  async () => {
    const summary = await harvest({
      gitLog: () => realGitLog(REPO_ROOT),
      loadDecisionRows: async () =>
        (await buildIndex(REPO_ROOT, nodeIndexFs)).decisions as readonly DecisionRow[],
      writeOne: makeWriteOne(WORKSPACE),
    });
    return {
      content: [
        {
          type: "text",
          text: `harvested: ${summary.written} new, ${summary.skipped} already-seen`,
        },
      ],
    };
  },
);
```

- [ ] **Step 3: Typecheck + manual smoke**

Run: `pnpm exec tsc --noEmit`
Expected: clean (no errors).

Then a real one-shot smoke against this repo (writes to the gitignored event store, safe + idempotent):

```bash
node --experimental-strip-types -e "
import('./src/harvest/harvest.ts').then(async ({ harvest, makeWriteOne }) => {
  const { realGitLog } = await import('./src/harvest/gitLog.ts');
  const { buildIndex, nodeIndexFs } = await import('./src/index/build.ts');
  const root = process.cwd().replace(/\/governance$/, '');
  const ws = process.cwd() + '/workspace';
  const run = () => harvest({
    gitLog: () => realGitLog(root),
    loadDecisionRows: async () => (await buildIndex(root, nodeIndexFs)).decisions,
    writeOne: makeWriteOne(ws),
  });
  console.log('run1', await run());
  console.log('run2', await run()); // expect written:0, all skipped
});
"
```

Expected: run1 writes ~860+ events (534 commits + 7 ADR + ~327 decisions), run2 reports `written: 0` and all skipped. (The events land under the gitignored `workspace/events/` — confirm with `git status --short governance/` showing no new tracked files.)

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(governance): register harvest MCP command (P3 harvest)"
```

---

### Task 7: Full gates + breadcrumb

**Files:**

- Modify: `docs/decisions.md`

- [ ] **Step 1: Run the full governance gate**

Run (from `governance/`): `pnpm test && pnpm exec tsc --noEmit`
Expected: all tests pass (Slice-1's 120 + the new harvest/id/writeEvent cases), tsc clean.

- [ ] **Step 2: Confirm zero app/Rust/bindings drift**

Run (from repo root): `git status --short` and confirm only `governance/**` + `docs/` changed; `src/bindings.ts`, `src-tauri/**`, app `src/**` untouched. No new tracked files under `governance/workspace/events/` (gitignored).

- [ ] **Step 3: Add the decisions breadcrumb** — append one line to `docs/decisions.md`:

```markdown
- **P3 Slice 2a — Gateway L0 harvest(2026-06-01)**: 레포 활동(git log/decisions.md/ADR)을 멱등 수집하는 `harvest` MCP 커맨드. 콘텐츠 주소화(전체 소스 신원 id, sha7/hash7는 파일명만)·gitignored L0 스토어·DB/임베딩/네트워크 없음. Slice 1 파서 재사용. 패턴 탐지 prerequisite(빈 L0) 해소.
```

- [ ] **Step 4: Commit**

```bash
git add docs/decisions.md
git commit -m "docs(governance): record P3 slice 2a L0 harvest done-line"
```

- [ ] **Step 5: Independent critic pass (separate context — required before done)**

Dispatch an opus critic over the full slice diff (`3301f18..HEAD`) against the spec's §10 INVARIANT table and §9 testing claims. Must return ACCEPT with no blockers/MAJORs before the slice is considered done. Do **not** push (standing directive; Boule stays parked).

---

## Self-Review

**Spec coverage:**

- §3 module table → Tasks 1–6 (id, writeEvent, gitLog, sources, harvest, server). ✓
- §5 deterministic ids / full identity / sha7-only-in-filename → Task 1 + Task 4 disambiguators. ✓
- §5 idempotency (deterministic id + wx skip) → Task 2 (wx) + Task 5 (EEXIST→skipped, two-run test). ✓
- §6 stamp rules (commit date; ADR date-or-undated; decisions always undated/content-hash) → Task 4 mappers + tests. ✓
- §7 MCP `harvest` summary line, existing commands unchanged → Task 6. ✓
- §8 fail-soft (git unavailable, missing sources) → Task 5 fake test + orchestrator try/catch. ✓
- §9 testing (parseGitLog, deriveEventId, orchestrator incl. idempotency, writeEvent back-compat, round-trip) → Tasks 1–6. ✓
- §10 INVARIANTs → Task 7 critic pass. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `HarvestItem` (id/type/source/actor/body/tags/refs?/stampAt/dayBucket?/disambiguator) defined in Task 4, consumed unchanged in Task 5; `deriveEventId`/`sha256hex` signatures from Task 1 used identically in Task 4; `WriteEventOptions` from Task 2 matches `makeWriteOne`'s call in Task 5; `realGitLog`/`parseGitLog`/`RawCommit` from Task 3 used in Task 4/5/6. ✓

```

```
