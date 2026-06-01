# Decision/Principle Ingress (P3 Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse work-radar's canonical L3/L4 markdown (`docs/adr/*.md`, `docs/decisions.md`, `docs/areas/decision-rails.md`) into an in-memory governance index and expose it through three new read-only MCP commands (`principles`, `decisions`, `decision <id>`).

**Architecture:** Pure parsers (one per source, string-in) + a thin fs-boundary assembler (`buildIndex`, injected fs) + pure text formatters, wired into the existing `governance/src/mcp/server.ts`. No DB, no network, strictly read-only. Markdown stays SSOT; "rebuild" = re-run `buildIndex`.

**Tech Stack:** TypeScript (Node 24 `--experimental-strip-types`), `gray-matter` (already a dependency, used by `event.ts`), `zod` 4.4.3 (MCP input schemas), `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-01-ssot-governance-harness-decision-ingress-design.md`

---

## Conventions (read before starting)

- **Runtime `src/**`imports use the`.ts`extension** (Node strip-types); **test imports use`.js`** (vitest resolver). This is enforced by `tsconfig.json` (`allowImportingTsExtensions`) and is the single most common trap here.
- Run all governance commands from `governance/`. Tests: `pnpm test`. Typecheck: `pnpm exec tsc --noEmit`.
- Do **not** push. Boule is parked; commit only.
- This slice touches `governance/**` only. Do not modify app code, Rust, migrations, or `src/bindings.ts`.

## File Structure

| File                                          | Responsibility                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Create: `governance/src/index/types.ts`       | Shared interfaces: `DecisionRow`, `PrincipleRow`, `DecisionEntry`, `GovernanceIndex`                    |
| Create: `governance/src/index/text.ts`        | Pure string helpers: `dedupe`, `extractRefs`, `truncate`, `firstParagraph`, `adrTitle`, `toStringArray` |
| Create: `governance/src/index/adr.ts`         | `parseAdr(content, sourcePath) → DecisionRow \| null`                                                   |
| Create: `governance/src/index/decisionLog.ts` | `parseDecisionLog(content, sourcePath) → DecisionRow[]`                                                 |
| Create: `governance/src/index/rails.ts`       | `parseRails(content, sourcePath) → PrincipleRow[]`                                                      |
| Create: `governance/src/index/build.ts`       | `buildIndex(repoRoot, fs) → GovernanceIndex`, `IndexFs`, `nodeIndexFs`                                  |
| Create: `governance/src/index/format.ts`      | `formatPrinciples`, `formatDecisions`, `formatDecision` (pure command text)                             |
| Modify: `governance/src/mcp/server.ts`        | Register `principles`, `decisions`, `decision` tools; resolve `REPO_ROOT`                               |
| Create: `governance/test/index/*.test.ts`     | Unit + one integration test                                                                             |

---

## Task 1: Shared types + text helpers

**Files:**

- Create: `governance/src/index/types.ts`
- Create: `governance/src/index/text.ts`
- Test: `governance/test/index/text.test.ts`

- [ ] **Step 1: Write the failing test**

`governance/test/index/text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  dedupe,
  extractRefs,
  truncate,
  firstParagraph,
  adrTitle,
  toStringArray,
} from "../../src/index/text.js";

describe("dedupe", () => {
  it("removes duplicates preserving order", () => {
    expect(dedupe(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});

describe("extractRefs", () => {
  it("finds ADR-NNNN tokens", () => {
    expect(extractRefs("see ADR-0003 and ADR-0006, also ADR-0003")).toEqual([
      "ADR-0003",
      "ADR-0006",
      "ADR-0003",
    ]);
  });
  it("returns [] when none", () => {
    expect(extractRefs("no refs here")).toEqual([]);
  });
});

describe("truncate", () => {
  it("leaves short strings, trims long ones with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcde…");
  });
});

describe("firstParagraph", () => {
  it("returns the first non-heading paragraph, joined and truncated", () => {
    const body =
      "# 0007. Title\n\n## Context\n\n**Scope**: the sidecar.\nMore detail.\n\nNext para.";
    expect(firstParagraph(body)).toBe("**Scope**: the sidecar. More detail.");
  });
  it("returns empty string when there is no body text", () => {
    expect(firstParagraph("# Only\n## Headings")).toBe("");
  });
});

describe("adrTitle", () => {
  it("takes the first H1 and strips a leading 'N. ' prefix", () => {
    expect(adrTitle("# 0007. Governance Surface\n\nbody")).toBe("Governance Surface");
  });
  it("returns null when there is no H1", () => {
    expect(adrTitle("## only h2")).toBeNull();
  });
});

describe("toStringArray", () => {
  it("normalizes arrays, scalars, and null/undefined", () => {
    expect(toStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(toStringArray("a")).toEqual(["a"]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test text`
Expected: FAIL — cannot resolve `../../src/index/text.js` (module does not exist yet).

- [ ] **Step 3: Write the types**

`governance/src/index/types.ts`:

```ts
export interface DecisionRow {
  id: string; // "ADR-0007" | decision-log ordinal id "DL-001"
  kind: "adr" | "decision-log";
  title: string;
  status?: string; // ADR frontmatter status; undefined for decision-log
  date?: string;
  tags: string[];
  supersedes: string[]; // ADR-NNNN ids
  refs: string[]; // ADR-NNNN ids mentioned in the body
  excerpt: string;
  sourcePath: string;
}

export interface PrincipleRow {
  id: string; // "INVARIANT-1"
  number: number;
  title: string;
  body: string;
  sourcePath: string;
}

export interface DecisionEntry {
  row: DecisionRow;
  supersededBy: string[];
  referencedBy: string[];
}

export interface GovernanceIndex {
  decisions: DecisionRow[];
  principles: PrincipleRow[];
  getDecision(id: string): DecisionEntry | null;
  listDecisions(): DecisionRow[];
  listPrinciples(): PrincipleRow[];
}
```

- [ ] **Step 4: Write the text helpers**

`governance/src/index/text.ts`:

```ts
const ADR_REF = /ADR-\d{4}/g;

export function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function extractRefs(s: string): string[] {
  return s.match(ADR_REF) ?? [];
}

export function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/** First block of consecutive non-blank, non-heading lines, joined with spaces and truncated. */
export function firstParagraph(body: string): string {
  const buf: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      if (buf.length) break;
      continue;
    }
    buf.push(t);
  }
  return truncate(buf.join(" "), 200);
}

/** First H1 line, with a leading "N. " ordinal prefix stripped. */
export function adrTitle(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^\d+\.\s*/, "").trim();
  }
  return null;
}

export function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v == null) return [];
  return [String(v)];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd governance && pnpm test text`
Expected: PASS (all `text.test.ts` cases green).

- [ ] **Step 6: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/index/types.ts governance/src/index/text.ts governance/test/index/text.test.ts
git commit -m "feat(governance): index types + pure text helpers (P3 ingress)"
```

---

## Task 2: ADR parser

**Files:**

- Create: `governance/src/index/adr.ts`
- Test: `governance/test/index/adr.test.ts`

- [ ] **Step 1: Write the failing test**

`governance/test/index/adr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAdr } from "../../src/index/adr.js";

const ADR = `---
adr-id: ADR-0007
status: accepted
date: 2026-06-01
tags: [governance, acp]
supersedes: [ADR-0003]
---

# 0007. Governance Surface

## Context

**Scope**: the sidecar. Relates to ADR-0006 and ADR-0007 (self).
`;

describe("parseAdr", () => {
  it("parses frontmatter, title, refs, supersedes (self-ref excluded)", () => {
    const row = parseAdr(ADR, "docs/adr/0007-x.md");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("ADR-0007");
    expect(row!.kind).toBe("adr");
    expect(row!.title).toBe("Governance Surface");
    expect(row!.status).toBe("accepted");
    expect(row!.date).toBe("2026-06-01");
    expect(row!.tags).toEqual(["governance", "acp"]);
    expect(row!.supersedes).toEqual(["ADR-0003"]);
    expect(row!.refs).toEqual(["ADR-0006"]); // self ADR-0007 excluded, deduped
    expect(row!.excerpt).toContain("**Scope**: the sidecar.");
    expect(row!.sourcePath).toBe("docs/adr/0007-x.md");
  });

  it("returns null when frontmatter has no adr-id", () => {
    expect(parseAdr("# no frontmatter here", "docs/adr/README.md")).toBeNull();
    expect(parseAdr("---\nstatus: draft\n---\n# body", "x.md")).toBeNull();
  });

  it("treats an empty supersedes as []", () => {
    const row = parseAdr("---\nadr-id: ADR-0001\nsupersedes:\n---\n# 1. T\n\nbody", "a.md");
    expect(row!.supersedes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test adr`
Expected: FAIL — cannot resolve `../../src/index/adr.js`.

- [ ] **Step 3: Write the implementation**

`governance/src/index/adr.ts`:

```ts
import matter from "gray-matter";
import type { DecisionRow } from "./types.ts";
import { adrTitle, dedupe, extractRefs, firstParagraph, toStringArray } from "./text.ts";

/** Parse one ADR markdown file. Returns null for files without a usable `adr-id`
 *  frontmatter field (template, README, or a stray doc) — the caller skips them. */
export function parseAdr(content: string, sourcePath: string): DecisionRow | null {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }
  const id = typeof data["adr-id"] === "string" ? (data["adr-id"] as string) : null;
  if (!id) return null;

  const supersedes = dedupe(toStringArray(data.supersedes).flatMap(extractRefs));
  const refs = dedupe(extractRefs(body)).filter((r) => r !== id);
  return {
    id,
    kind: "adr",
    title: adrTitle(body) ?? id,
    status: typeof data.status === "string" ? data.status : undefined,
    date: data.date != null ? String(data.date) : undefined,
    tags: toStringArray(data.tags),
    supersedes,
    refs,
    excerpt: firstParagraph(body),
    sourcePath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd governance && pnpm test adr`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/index/adr.ts governance/test/index/adr.test.ts
git commit -m "feat(governance): ADR markdown parser (P3 ingress)"
```

---

## Task 3: Decision-log parser

**Files:**

- Create: `governance/src/index/decisionLog.ts`
- Test: `governance/test/index/decisionLog.test.ts`

- [ ] **Step 1: Write the failing test**

`governance/test/index/decisionLog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDecisionLog } from "../../src/index/decisionLog.js";

const DOC = `# Decisions

- **First decision(2026-05-23)**: did a thing referencing ADR-0002.
- not an entry bullet
- **Second decision(2026-06-01)**: did another thing.
`;

describe("parseDecisionLog", () => {
  it("parses '- **title(date)**: rest' bullets into ordinal rows", () => {
    const rows = parseDecisionLog(DOC, "docs/decisions.md");
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      id: "DL-001",
      kind: "decision-log",
      title: "First decision",
      date: "2026-05-23",
      tags: [],
      supersedes: [],
      refs: ["ADR-0002"],
      sourcePath: "docs/decisions.md",
    });
    expect(rows[0].excerpt).toContain("did a thing");
    expect(rows[0].status).toBeUndefined();
    expect(rows[1].id).toBe("DL-002");
    expect(rows[1].title).toBe("Second decision");
    expect(rows[1].date).toBe("2026-06-01");
  });

  it("returns [] for content with no matching bullets", () => {
    expect(parseDecisionLog("# Decisions\n\nnothing here", "d.md")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test decisionLog`
Expected: FAIL — cannot resolve `../../src/index/decisionLog.js`.

- [ ] **Step 3: Write the implementation**

`governance/src/index/decisionLog.ts`:

```ts
import type { DecisionRow } from "./types.ts";
import { dedupe, extractRefs, truncate } from "./text.ts";

const BULLET = /^- \*\*(.+?)\*\*:\s*(.*)$/;
const DATE_SUFFIX = /\((\d{4}-\d{2}-\d{2})\)\s*$/;

/** Parse `docs/decisions.md` top-level `- **<title>(<date>)**: <rest>` bullets.
 *  Each match is one row; ids are file-order ordinals (DL-NNN) since the log has
 *  no formal ids and is append-only. Non-matching lines are ignored. */
export function parseDecisionLog(content: string, sourcePath: string): DecisionRow[] {
  const rows: DecisionRow[] = [];
  let ordinal = 0;
  for (const line of content.split("\n")) {
    const m = BULLET.exec(line);
    if (!m) continue;
    ordinal++;
    const bold = m[1].trim();
    const rest = m[2];
    const dm = DATE_SUFFIX.exec(bold);
    rows.push({
      id: `DL-${String(ordinal).padStart(3, "0")}`,
      kind: "decision-log",
      title: dm ? bold.slice(0, dm.index).trim() : bold,
      status: undefined,
      date: dm ? dm[1] : undefined,
      tags: [],
      supersedes: [],
      refs: dedupe(extractRefs(line)),
      excerpt: truncate(rest, 200),
      sourcePath,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd governance && pnpm test decisionLog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/index/decisionLog.ts governance/test/index/decisionLog.test.ts
git commit -m "feat(governance): decisions.md log parser (P3 ingress)"
```

---

## Task 4: Decision-rails (principles) parser

**Files:**

- Create: `governance/src/index/rails.ts`
- Test: `governance/test/index/rails.test.ts`

- [ ] **Step 1: Write the failing test**

`governance/test/index/rails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRails } from "../../src/index/rails.js";

const RAILS = `# Decision Rails — INVARIANTS

intro text before the first section, ignored.

## 1. 결정 레일은 사람만

people only. line two.

## 2. 모든 외부 변경은 Acceptance 게이트

acceptance gate.
`;

describe("parseRails", () => {
  it("splits '## N. title' sections into INVARIANT-N rows", () => {
    const rows = parseRails(RAILS, "docs/areas/decision-rails.md");
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      id: "INVARIANT-1",
      number: 1,
      title: "결정 레일은 사람만",
      sourcePath: "docs/areas/decision-rails.md",
    });
    expect(rows[0].body).toBe("people only. line two.");
    expect(rows[1].id).toBe("INVARIANT-2");
    expect(rows[1].title).toBe("모든 외부 변경은 Acceptance 게이트");
  });

  it("returns [] when there are no numbered sections", () => {
    expect(parseRails("# Title\n\njust prose", "r.md")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test rails`
Expected: FAIL — cannot resolve `../../src/index/rails.js`.

- [ ] **Step 3: Write the implementation**

`governance/src/index/rails.ts`:

```ts
import type { PrincipleRow } from "./types.ts";

const HEADING = /^##\s+(\d+)\.\s+(.+?)\s*$/;

/** Parse `decision-rails.md` `## N. <title>` sections into INVARIANT-N principles.
 *  Body = lines until the next `## ` heading. Content before the first section
 *  (the `#` title + intro) is ignored. */
export function parseRails(content: string, sourcePath: string): PrincipleRow[] {
  const rows: PrincipleRow[] = [];
  let cur: { number: number; title: string; bodyLines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    rows.push({
      id: `INVARIANT-${cur.number}`,
      number: cur.number,
      title: cur.title,
      body: cur.bodyLines.join("\n").trim(),
      sourcePath,
    });
  };
  for (const line of content.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      cur = { number: Number(m[1]), title: m[2].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  flush();
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd governance && pnpm test rails`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/index/rails.ts governance/test/index/rails.test.ts
git commit -m "feat(governance): decision-rails principles parser (P3 ingress)"
```

---

## Task 5: Index assembler (buildIndex + reference graph)

**Files:**

- Create: `governance/src/index/build.ts`
- Test: `governance/test/index/build.test.ts`

- [ ] **Step 1: Write the failing test**

`governance/test/index/build.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildIndex, type IndexFs } from "../../src/index/build.js";
import { join } from "node:path";

/** In-memory fs over a path→content map. */
function memFs(files: Record<string, string>): IndexFs {
  return {
    async readFile(path) {
      return path in files ? files[path] : null;
    },
    async readDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
    },
  };
}

const ROOT = "/repo";
const adr = (id: string, body: string, supersedes = "") =>
  `---\nadr-id: ${id}\nstatus: accepted\nsupersedes:${supersedes}\n---\n\n# ${id}\n\n${body}`;

describe("buildIndex", () => {
  it("assembles decisions + principles and inverts the reference graph", async () => {
    const fs = memFs({
      [join(ROOT, "docs/adr/0001-a.md")]: adr("ADR-0001", "first"),
      [join(ROOT, "docs/adr/0002-b.md")]: adr("ADR-0002", "supersedes the first", " [ADR-0001]"),
      [join(ROOT, "docs/adr/0003-c.md")]: adr("ADR-0003", "see ADR-0001 for context"),
      [join(ROOT, "docs/adr/ADR-0000-template.md")]: adr("ADR-0000", "TEMPLATE — must be skipped"),
      [join(ROOT, "docs/adr/README.md")]: "# index, skipped",
      [join(ROOT, "docs/decisions.md")]: "- **A thing(2026-06-01)**: did it.",
      [join(ROOT, "docs/areas/decision-rails.md")]: "## 1. people only\n\nbody",
    });

    const index = await buildIndex(ROOT, fs);

    const ids = index.listDecisions().map((d) => d.id);
    expect(ids).toContain("ADR-0001");
    expect(ids).toContain("ADR-0002");
    expect(ids).toContain("DL-001");
    expect(ids).not.toContain("ADR-0000"); // template skipped
    expect(index.listPrinciples().map((p) => p.id)).toEqual(["INVARIANT-1"]);

    const a1 = index.getDecision("ADR-0001")!;
    expect(a1.supersededBy).toEqual(["ADR-0002"]); // inverse of ADR-0002.supersedes
    expect(a1.referencedBy).toEqual(["ADR-0003"]); // inverse of ADR-0003.refs
    expect(index.getDecision("ADR-9999")).toBeNull();
  });

  it("degrades gracefully when sources are missing", async () => {
    const index = await buildIndex(ROOT, memFs({}));
    expect(index.listDecisions()).toEqual([]);
    expect(index.listPrinciples()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test build`
Expected: FAIL — cannot resolve `../../src/index/build.js`.

- [ ] **Step 3: Write the implementation**

`governance/src/index/build.ts`:

```ts
import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionRow, GovernanceIndex, PrincipleRow } from "./types.ts";
import { parseAdr } from "./adr.ts";
import { parseDecisionLog } from "./decisionLog.ts";
import { parseRails } from "./rails.ts";

export interface IndexFs {
  /** Returns file contents, or null if missing/unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Returns entry names in a directory, or [] if missing/unreadable. */
  readDir(path: string): Promise<string[]>;
}

/** Real filesystem adapter — fail-soft (missing path → null / []). */
export const nodeIndexFs: IndexFs = {
  async readFile(path) {
    try {
      return await nodeReadFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async readDir(path) {
    try {
      return await nodeReaddir(path);
    } catch {
      return [];
    }
  },
};

const SKIP_ADR = new Set(["ADR-0000-template.md", "README.md"]);

function pushEdge(m: Map<string, string[]>, key: string, value: string): void {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
}

/** Build the in-memory governance index from the repo's L3/L4 markdown.
 *  markdown is SSOT; this derived structure is rebuilt by calling buildIndex again. */
export async function buildIndex(repoRoot: string, fs: IndexFs): Promise<GovernanceIndex> {
  const decisions: DecisionRow[] = [];

  const adrDir = join(repoRoot, "docs", "adr");
  const names = (await fs.readDir(adrDir)).filter((n) => n.endsWith(".md") && !SKIP_ADR.has(n));
  names.sort();
  for (const name of names) {
    const content = await fs.readFile(join(adrDir, name));
    if (content == null) continue;
    const row = parseAdr(content, `docs/adr/${name}`);
    if (row) decisions.push(row);
  }

  const decisionsDoc = await fs.readFile(join(repoRoot, "docs", "decisions.md"));
  if (decisionsDoc != null) decisions.push(...parseDecisionLog(decisionsDoc, "docs/decisions.md"));

  const railsDoc = await fs.readFile(join(repoRoot, "docs", "areas", "decision-rails.md"));
  const principles: PrincipleRow[] =
    railsDoc != null ? parseRails(railsDoc, "docs/areas/decision-rails.md") : [];

  const supersededBy = new Map<string, string[]>();
  const referencedBy = new Map<string, string[]>();
  for (const d of decisions) {
    for (const s of d.supersedes) pushEdge(supersededBy, s, d.id);
    for (const r of d.refs) pushEdge(referencedBy, r, d.id);
  }
  const byId = new Map(decisions.map((d) => [d.id, d]));

  return {
    decisions,
    principles,
    listDecisions: () => decisions,
    listPrinciples: () => principles,
    getDecision: (id) => {
      const row = byId.get(id);
      if (!row) return null;
      return {
        row,
        supersededBy: supersededBy.get(id) ?? [],
        referencedBy: referencedBy.get(id) ?? [],
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd governance && pnpm test build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/index/build.ts governance/test/index/build.test.ts
git commit -m "feat(governance): buildIndex assembler + reference graph (P3 ingress)"
```

---

## Task 6: Pure command formatters

**Files:**

- Create: `governance/src/index/format.ts`
- Test: `governance/test/index/format.test.ts`

- [ ] **Step 1: Write the failing test**

`governance/test/index/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatDecision, formatDecisions, formatPrinciples } from "../../src/index/format.js";
import type { DecisionEntry, GovernanceIndex } from "../../src/index/types.js";

function fakeIndex(over: Partial<GovernanceIndex>): GovernanceIndex {
  return {
    decisions: [],
    principles: [],
    listDecisions: () => over.decisions ?? [],
    listPrinciples: () => over.principles ?? [],
    getDecision: () => null,
    ...over,
  };
}

describe("formatPrinciples", () => {
  it("lists 'id — title' per line", () => {
    const idx = fakeIndex({
      principles: [
        { id: "INVARIANT-1", number: 1, title: "people only", body: "", sourcePath: "r.md" },
      ],
    });
    expect(formatPrinciples(idx)).toBe("INVARIANT-1 — people only");
  });
  it("handles empty", () => {
    expect(formatPrinciples(fakeIndex({}))).toBe("no principles found");
  });
});

describe("formatDecisions", () => {
  it("lists 'id [status] — title', omitting status when absent", () => {
    const idx = fakeIndex({
      decisions: [
        {
          id: "ADR-0007",
          kind: "adr",
          title: "Surface",
          status: "accepted",
          tags: [],
          supersedes: [],
          refs: [],
          excerpt: "",
          sourcePath: "a.md",
        },
        {
          id: "DL-001",
          kind: "decision-log",
          title: "A thing",
          tags: [],
          supersedes: [],
          refs: [],
          excerpt: "",
          sourcePath: "d.md",
        },
      ],
    });
    expect(formatDecisions(idx)).toBe("ADR-0007 [accepted] — Surface\nDL-001 — A thing");
  });
});

describe("formatDecision", () => {
  it("renders detail + reference graph", () => {
    const entry: DecisionEntry = {
      row: {
        id: "ADR-0002",
        kind: "adr",
        title: "B",
        status: "accepted",
        date: "2026-01-01",
        tags: [],
        supersedes: ["ADR-0001"],
        refs: ["ADR-0003"],
        excerpt: "why B",
        sourcePath: "b.md",
      },
      supersededBy: ["ADR-0005"],
      referencedBy: ["ADR-0004"],
    };
    const text = formatDecision(entry, "ADR-0002");
    expect(text).toContain("ADR-0002 [accepted] — B");
    expect(text).toContain("date: 2026-01-01");
    expect(text).toContain("why B");
    expect(text).toContain("supersedes: ADR-0001");
    expect(text).toContain("superseded-by: ADR-0005");
    expect(text).toContain("refs: ADR-0003");
    expect(text).toContain("referenced-by: ADR-0004");
  });
  it("returns a friendly not-found for a null entry", () => {
    expect(formatDecision(null, "ADR-9999")).toBe("not found: ADR-9999");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test format`
Expected: FAIL — cannot resolve `../../src/index/format.js`.

- [ ] **Step 3: Write the implementation**

`governance/src/index/format.ts`:

```ts
import type { DecisionEntry, GovernanceIndex } from "./types.ts";

export function formatPrinciples(index: GovernanceIndex): string {
  const ps = index.listPrinciples();
  if (!ps.length) return "no principles found";
  return ps.map((p) => `${p.id} — ${p.title}`).join("\n");
}

export function formatDecisions(index: GovernanceIndex): string {
  const ds = index.listDecisions();
  if (!ds.length) return "no decisions found";
  return ds.map((d) => `${d.id}${d.status ? ` [${d.status}]` : ""} — ${d.title}`).join("\n");
}

export function formatDecision(entry: DecisionEntry | null, id: string): string {
  if (!entry) return `not found: ${id}`;
  const { row, supersededBy, referencedBy } = entry;
  const lines: string[] = [`${row.id}${row.status ? ` [${row.status}]` : ""} — ${row.title}`];
  if (row.date) lines.push(`date: ${row.date}`);
  if (row.excerpt) lines.push("", row.excerpt);
  const graph: string[] = [];
  if (row.supersedes.length) graph.push(`supersedes: ${row.supersedes.join(", ")}`);
  if (supersededBy.length) graph.push(`superseded-by: ${supersededBy.join(", ")}`);
  if (row.refs.length) graph.push(`refs: ${row.refs.join(", ")}`);
  if (referencedBy.length) graph.push(`referenced-by: ${referencedBy.join(", ")}`);
  if (graph.length) lines.push("", ...graph);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd governance && pnpm test format`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/index/format.ts governance/test/index/format.test.ts
git commit -m "feat(governance): pure command formatters (P3 ingress)"
```

---

## Task 7: Wire the three MCP tools + integration test

**Files:**

- Modify: `governance/src/mcp/server.ts`
- Test: `governance/test/index/build.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

`governance/test/index/build.integration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildIndex, nodeIndexFs } from "../../src/index/build.js";
import { formatDecisions, formatPrinciples } from "../../src/index/format.js";

// governance/test/index → governance/test → governance → <repo root>
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("buildIndex against the real repo L3/L4 corpus", () => {
  it("ingests the real ADRs and INVARIANTs", async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    const ids = index.listDecisions().map((d) => d.id);
    expect(ids).toContain("ADR-0001");
    expect(ids).toContain("ADR-0007");
    expect(index.listPrinciples().some((p) => p.id === "INVARIANT-1")).toBe(true);
    expect(index.getDecision("ADR-9999")).toBeNull();
    // formatters produce non-empty text over the real corpus
    expect(formatDecisions(index)).toContain("ADR-0001");
    expect(formatPrinciples(index)).toContain("INVARIANT-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm test integration`
Expected: FAIL — `import.meta.dirname` resolves but the test asserts ingestion via modules that exist; it should PASS already if Tasks 1–6 are done. If it fails, it indicates a real parsing gap against the live files (fix the parser, not the test). Confirm the failure mode before proceeding; if it passes immediately, that is acceptable (the modules already work) — continue to wiring.

> Note: this is an integration check over real files, not a red-first unit test. Its purpose is to catch drift between the parsers and the actual markdown formats.

- [ ] **Step 3: Wire the tools into the server**

In `governance/src/mcp/server.ts`, add these imports near the other `../` imports:

```ts
import { resolve } from "node:path";
import { buildIndex, nodeIndexFs } from "../index/build.ts";
import { formatPrinciples, formatDecisions, formatDecision } from "../index/format.ts";
```

After the `const WORKSPACE = …` line, add:

```ts
// Repo root holds the canonical L3/L4 markdown (docs/adr, docs/decisions.md,
// docs/areas/decision-rails.md). Default: two levels up from the workspace
// (<repo>/governance/workspace → <repo>). Overridable for tests/relocation.
const REPO_ROOT = process.env.BOULE_REPO_ROOT ?? resolve(WORKSPACE, "..", "..");
```

Then register the three read-only tools (place them after the `observations` tool registration, before the decision tools):

```ts
server.registerTool(
  "principles",
  { description: "결정 원칙(decision-rails INVARIANTs) 목록", inputSchema: {} },
  async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    return { content: [{ type: "text", text: formatPrinciples(index) }] };
  },
);

server.registerTool(
  "decisions",
  { description: "ADR + decisions.md 결정 목록", inputSchema: {} },
  async () => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    return { content: [{ type: "text", text: formatDecisions(index) }] };
  },
);

server.registerTool(
  "decision",
  { description: "단일 결정 상세 + 참조 그래프(supersedes/refs)", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const index = await buildIndex(REPO_ROOT, nodeIndexFs);
    return { content: [{ type: "text", text: formatDecision(index.getDecision(id), id) }] };
  },
);
```

- [ ] **Step 4: Run typecheck + full test suite**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm test`
Expected: tsc clean; all tests PASS (including the new integration test). Note the total count for the commit message.

- [ ] **Step 5: (Optional) Manual stub-MCP smoke**

Drive the server over stdio to confirm the three tools list and return text. This mirrors the prior slices' ad-hoc round-trip and is optional (the unit + integration tests are the committed evidence). If run, use a throwaway driver and delete it after; do not commit it.

Run (from `governance/`):

```bash
BOULE_REPO_ROOT="$(cd ../ && pwd)" node --experimental-strip-types src/mcp/server.ts <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"principles","arguments":{}}}
EOF
```

Expected: the response for id 2 contains `INVARIANT-1 — …`. (Ctrl-C to exit; the server holds the stdio connection open.)

- [ ] **Step 6: Commit**

```bash
cd /Users/davidpark/private_project/work-radar
git add governance/src/mcp/server.ts governance/test/index/build.integration.test.ts
git commit -m "feat(governance): wire principles/decisions/decision MCP tools (P3 ingress)"
```

---

## Task 8: Final verification + decisions breadcrumb

**Files:**

- Modify: `docs/decisions.md` (one done-line)

- [ ] **Step 1: Confirm governance gates**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm test`
Expected: tsc clean; all tests PASS.

- [ ] **Step 2: Confirm nothing else drifted**

Run:

```bash
cd /Users/davidpark/private_project/work-radar
git status --short
git diff --stat HEAD~6
```

Expected: only `governance/**` files (and this plan/spec) changed. No app, Rust, migration, or `src/bindings.ts` changes. If `src/bindings.ts` appears, STOP — this slice must not touch IPC.

- [ ] **Step 3: Independent reviewer pass (no self-approve)**

Dispatch the `oh-my-claudecode:critic` agent (opus) on the full diff for an ACCEPT/findings verdict. Do not commit the breadcrumb until ACCEPT with 0 blockers. Address any blocker/major before proceeding.

- [ ] **Step 4: Add the decisions breadcrumb**

Append one bullet to the tail of `docs/decisions.md` summarizing: P3 Slice 1 (L3/L4 decision/principle ingress), in-memory (no DB), three read-only MCP commands, reference graph, INVARIANT #1 read-only posture, test counts, critic ACCEPT, Boule parked/unpushed.

- [ ] **Step 5: Commit the breadcrumb**

```bash
cd /Users/davidpark/private_project/work-radar
git add docs/decisions.md
git commit -m "docs(governance): record P3 slice 1 decision/principle ingress done-line"
```

- [ ] **Step 6: Stop — do not push**

Boule stays parked and unpushed. Report the final HEAD and test counts to the user.

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 modules → Tasks 1–6 (one file per unit; `types.ts`/`text.ts` split out for DRY). §4 data model → Task 1 types. §5 MCP surface (`principles`/`decisions`/`decision <id>`) → Task 7. §6 parsing specifics (frontmatter, empty supersedes, decision-log bullets, rails sections, cross-refs) → Tasks 2–4 tests. §7 error handling (missing → [], malformed → skip) → Task 2 null test, Task 5 graceful-degrade test, `nodeIndexFs` try/catch. §8 testing → unit tests per task + integration test (Task 7). §9 INVARIANTs → read-only throughout; Task 8 Step 2 guards `bindings.ts`. §10 verification → Task 8 (gates + critic). §11 deferred → out of scope, untouched.

**Placeholder scan:** No TBD/TODO; every code step has complete code; every run step has an exact command + expected outcome.

**Type consistency:** `DecisionRow`/`PrincipleRow`/`DecisionEntry`/`GovernanceIndex` defined in Task 1 and used identically in Tasks 2–7. `IndexFs.readFile → string | null`, `readDir → string[]` consistent between `build.ts` and both its tests. `parseAdr → DecisionRow | null`, `parseDecisionLog`/`parseRails → […]`, formatters take `(GovernanceIndex)` / `(DecisionEntry | null, id)` consistently. `buildIndex(repoRoot, fs)` arg order matches all call sites. `nodeIndexFs` exported from `build.ts`, imported by server + integration test.

**Note on Task 7 Step 2:** the integration test may pass immediately rather than failing red — that is expected and documented (it is a drift/integration guard over real files, not a unit red-first step).
