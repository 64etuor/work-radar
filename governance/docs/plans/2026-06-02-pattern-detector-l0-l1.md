# Pattern Detector L0→L1 (commit scope hotspots) Implementation Plan

> **Status:** ✅ DONE — 아래 step 체크박스는 back-fill 안 함(이 트랙 관행). 완료 증거 정본: [INDEX](../INDEX.md) + `docs/decisions.md` breadcrumb.
>
> 체크박스 = 빌드 시점 기록(사람용). 런타임 task 상태는 이벤트 파생(오케스트레이터 정본) — `governance/workspace/HARNESS.md` §3.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic Pattern Detector that scans the L0 event corpus and emits **candidate** L1 patterns for one kind — _commit scope hotspots_ — into `governance/workspace/patterns/candidates/`, with a read-only MCP view and a human-commit activation gate.

**Architecture:** A structural twin of `governance/src/harvest/`: a pure detection core (`detectPatterns`) fed by injected I/O, plus an idempotent content-addressed writer that may write **only** under `patterns/candidates/`. Three MCP tools (`detect` write, `patterns`/`pattern` read). No pgvector, embeddings, cron, model calls, app/Rust/migration changes.

**Tech Stack:** TypeScript (ESM, `type: module`), Node 20 strip-types, `gray-matter` (frontmatter), `zod` (MCP schemas), `vitest` 2.0. Source imports use the `.ts` extension; **test imports use the `.js` extension** (repo strip-types convention — do not deviate). All commands run from `governance/`.

**Spec:** `governance/docs/design/2026-06-02-pattern-detector-l0-l1-design.md`

---

## File Structure

All paths under `governance/`.

- Create `src/patterns/types.ts` — `PatternKind`, `CandidatePattern`, `KIND` constant.
- Create `src/patterns/scope.ts` — `parseScope(subject) → string | null` (conventional-commit scope).
- Create `src/patterns/detect.ts` — `patternId`, `confidence`, `curatedKeyString`, `detectPatterns` (pure), `runDetect` (orchestrator + deps).
- Create `src/patterns/write.ts` — `serializePattern`, `makeWritePattern` (idempotent, candidates-only).
- Create `src/patterns/read.ts` — `loadCuratedKeys`, `listPatterns`, `getPattern`.
- Modify `src/mcp/config.ts` — add `parsePositiveInt` + `parsePatternConfig`.
- Modify `src/mcp/server.ts` — register `detect`, `patterns`, `pattern` tools.
- Create `workspace/patterns/candidates/.gitkeep`.
- Tests: `test/patterns/scope.test.ts`, `test/patterns/detect.test.ts`, `test/patterns/write.test.ts`, `test/patterns/read.test.ts`, `test/patterns/run.test.ts`, `test/mcp/patterns.test.ts`.

**Invariant enforced in code (spec §4):** `makeWritePattern` joins every path under a fixed `patterns/candidates/` base and never references `active/`/`archived/`. A test asserts `active/`/`archived/` are untouched by a write.

---

### Task 1: Types + scope parser

**Files:**

- Create: `src/patterns/types.ts`
- Create: `src/patterns/scope.ts`
- Test: `test/patterns/scope.test.ts`

- [ ] **Step 1: Write the failing test**

`test/patterns/scope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseScope } from "../../src/patterns/scope.js";

describe("parseScope", () => {
  it("extracts the scope from a conventional-commit subject", () => {
    expect(parseScope("feat(governance): add detector")).toBe("governance");
    expect(parseScope("docs(plan): cmd-knob 설계")).toBe("plan");
  });

  it("handles a breaking-change marker", () => {
    expect(parseScope("feat(api)!: drop v1")).toBe("api");
  });

  it("returns null when there is no scope", () => {
    expect(parseScope("fix: a bare fix")).toBeNull();
    expect(parseScope("chore: bump deps")).toBeNull();
  });

  it("returns null for an empty or whitespace scope", () => {
    expect(parseScope("feat(): empty")).toBeNull();
    expect(parseScope("feat(   ): blank")).toBeNull();
  });

  it("returns null for a non-conventional subject", () => {
    expect(parseScope("just a normal commit message")).toBeNull();
    expect(parseScope("")).toBeNull();
  });

  it("trims surrounding whitespace but preserves case (normalization is the caller's job)", () => {
    expect(parseScope("feat( Governance ): x")).toBe("Governance");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- scope`
Expected: FAIL — `Cannot find module '../../src/patterns/scope.js'`.

- [ ] **Step 3: Write the types + implementation**

`src/patterns/types.ts`:

```ts
/** L1 pattern kinds. Only one in this slice; the union is the extension point. */
export type PatternKind = "commit_scope_hotspot";

/** The single kind this slice detects. */
export const KIND: PatternKind = "commit_scope_hotspot";

/** A detected, not-yet-curated L1 pattern. `scope` is the normalized canonical key. */
export interface CandidatePattern {
  id: string; // pat_scope_<sha8>
  kind: PatternKind;
  scope: string; // normalized: scope.trim().toLowerCase()
  evidenceCount: number;
  confidence: number; // 0..1
  evidenceEventIds: string[]; // all contributing L0 event ids (sorted)
}
```

`src/patterns/scope.ts`:

```ts
/** Conventional-commit header: type, optional (scope), optional `!`, then `:`. */
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:/;

/** Parse the scope out of a commit subject's first token.
 *  Returns the trimmed scope (case preserved) or null when there is no usable scope.
 *  Normalization (lowercasing) is the caller's responsibility — see detect.ts. */
export function parseScope(subject: string): string | null {
  const m = HEADER.exec(subject.trimStart());
  if (!m) return null;
  const scope = m[2];
  if (scope === undefined) return null; // `fix: ...` — no parenthesized scope
  const trimmed = scope.trim();
  return trimmed.length > 0 ? trimmed : null; // `feat(): ...` — empty scope
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- scope`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add src/patterns/types.ts src/patterns/scope.ts test/patterns/scope.test.ts
git commit -m "feat(governance): pattern detector — types + conventional-commit scope parser"
```

(Husky pre-commit runs cargo fmt + frontend guards; the `PATH` export keeps cargo on path. Never push.)

---

### Task 2: Detection core (`detectPatterns`) + identity/confidence helpers

**Files:**

- Create: `src/patterns/detect.ts` (detection part only; `runDetect` added in Task 5)
- Test: `test/patterns/detect.test.ts`

- [ ] **Step 1: Write the failing test**

`test/patterns/detect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { patternId, confidence, detectPatterns } from "../../src/patterns/detect.js";
import type { GovEvent } from "../../src/event/event.js";

function commit(id: string, subject: string): GovEvent {
  return {
    frontmatter: { id, type: "commit_recorded", source: "git", actor: "alice", tags: [] },
    body: subject,
  };
}

const OPTS = { minEvidence: 3, confFull: 10, evidenceCap: 20 };

describe("patternId", () => {
  it("is namespace-scoped and stable (sha8 of `<kind>:<scope>`)", () => {
    const a = patternId("governance");
    expect(a).toMatch(/^pat_scope_[0-9a-f]{8}$/);
    expect(patternId("governance")).toBe(a); // deterministic
    expect(patternId("plan")).not.toBe(a); // scope-sensitive
  });
});

describe("confidence", () => {
  it("is count/confFull, clamped to 1, rounded to 2dp", () => {
    expect(confidence(5, 10)).toBe(0.5);
    expect(confidence(10, 10)).toBe(1);
    expect(confidence(99, 10)).toBe(1); // clamp
    expect(confidence(1, 3)).toBe(0.33); // round
  });
});

describe("detectPatterns", () => {
  it("emits a candidate for a scope at/over the threshold, dropping under-threshold scopes", () => {
    const events = [
      commit("evt_commit_1", "feat(governance): a"),
      commit("evt_commit_2", "fix(governance): b"),
      commit("evt_commit_3", "docs(governance): c"),
      commit("evt_commit_4", "feat(news): d"), // 1 < threshold 3
    ];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0]).toMatchObject({
      kind: "commit_scope_hotspot",
      scope: "governance",
      evidenceCount: 3,
      id: patternId("governance"),
    });
    expect(r.patterns[0].evidenceEventIds).toEqual([
      "evt_commit_1",
      "evt_commit_2",
      "evt_commit_3",
    ]);
    expect(r.scopesConsidered).toBe(2); // governance + news
  });

  it("merges case/whitespace variants of a scope onto one normalized key", () => {
    const events = [
      commit("evt_commit_1", "feat(Governance): a"),
      commit("evt_commit_2", "fix( governance ): b"),
      commit("evt_commit_3", "docs(GOVERNANCE): c"),
    ];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0].scope).toBe("governance");
    expect(r.patterns[0].evidenceCount).toBe(3);
  });

  it("counts commits with no scope as droppedNoScope and ignores non-commit events", () => {
    const events: GovEvent[] = [
      commit("evt_commit_1", "fix: bare"),
      commit("evt_commit_2", "not conventional at all"),
      {
        frontmatter: {
          id: "evt_decision_x",
          type: "decision_recorded",
          source: "decisions_doc",
          actor: "system",
          tags: [],
        },
        body: "feat(governance): looks like a scope but is a decision",
      },
    ];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns).toHaveLength(0);
    expect(r.droppedNoScope).toBe(2);
    expect(r.scopesConsidered).toBe(0);
  });

  it("skips a scope already curated by a human (active or archived)", () => {
    const events = [
      commit("evt_commit_1", "feat(governance): a"),
      commit("evt_commit_2", "fix(governance): b"),
      commit("evt_commit_3", "docs(governance): c"),
    ];
    const curated = new Set(["commit_scope_hotspot:governance"]);
    const r = detectPatterns(events, curated, OPTS);
    expect(r.patterns).toHaveLength(0);
    expect(r.scopesConsidered).toBe(1); // still considered, just not emitted
  });

  it("returns patterns sorted by scope (byte-stable)", () => {
    const mk = (scope: string, n: number) =>
      Array.from({ length: n }, (_, i) => commit(`evt_${scope}_${i}`, `feat(${scope}): x`));
    const events = [...mk("zeta", 3), ...mk("alpha", 3)];
    const r = detectPatterns(events, new Set(), OPTS);
    expect(r.patterns.map((p) => p.scope)).toEqual(["alpha", "zeta"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- detect`
Expected: FAIL — `Cannot find module '../../src/patterns/detect.js'`.

- [ ] **Step 3: Write the implementation**

`src/patterns/detect.ts`:

```ts
import { sha256hex } from "../event/id.ts";
import type { GovEvent } from "../event/event.ts";
import { KIND, type CandidatePattern } from "./types.ts";
import { parseScope } from "./scope.ts";

export interface DetectOptions {
  minEvidence: number; // emit only scopes with >= this many commits
  confFull: number; // count at which confidence saturates to 1.0
  evidenceCap: number; // body display cap (does not affect detection)
}

export interface DetectResult {
  patterns: CandidatePattern[];
  droppedNoScope: number; // commit events with no parseable scope
  scopesConsidered: number; // distinct normalized scopes seen (pre-threshold)
}

/** The curated-set membership key for a (kind, normalizedScope). Also the id hash input. */
export function curatedKeyString(kind: string, normalizedScope: string): string {
  return `${kind}:${normalizedScope}`;
}

/** Namespace-scoped content-addressed id: pat_scope_<sha8("<kind>:<normalizedScope>")>. */
export function patternId(normalizedScope: string): string {
  return `pat_scope_${sha256hex(curatedKeyString(KIND, normalizedScope)).slice(0, 8)}`;
}

/** Transparent confidence: count/confFull, clamped to 1, rounded to 2 decimals. */
export function confidence(count: number, confFull: number): number {
  return Math.min(1, Math.round((count / confFull) * 100) / 100);
}

/** Pure: L0 events → candidate commit-scope-hotspot patterns. Deterministic. */
export function detectPatterns(
  events: readonly GovEvent[],
  curated: ReadonlySet<string>,
  opts: DetectOptions,
): DetectResult {
  const groups = new Map<string, string[]>(); // normalizedScope → event ids
  let droppedNoScope = 0;
  for (const e of events) {
    if (e.frontmatter.type !== "commit_recorded") continue;
    const scope = parseScope(e.body);
    if (scope === null) {
      droppedNoScope++;
      continue;
    }
    const key = scope.toLowerCase(); // parseScope already trimmed
    const ids = groups.get(key) ?? [];
    ids.push(e.frontmatter.id);
    groups.set(key, ids);
  }

  const patterns: CandidatePattern[] = [];
  for (const [scope, ids] of groups) {
    if (ids.length < opts.minEvidence) continue;
    if (curated.has(curatedKeyString(KIND, scope))) continue;
    patterns.push({
      id: patternId(scope),
      kind: KIND,
      scope,
      evidenceCount: ids.length,
      confidence: confidence(ids.length, opts.confFull),
      evidenceEventIds: [...ids].sort(), // stable ordering
    });
  }
  patterns.sort((a, b) => a.scope.localeCompare(b.scope));
  return { patterns, droppedNoScope, scopesConsidered: groups.size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- detect`
Expected: PASS (all `describe` blocks).

- [ ] **Step 5: Commit**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add src/patterns/detect.ts test/patterns/detect.test.ts
git commit -m "feat(governance): pattern detector — pure detection core (scope hotspots)"
```

---

### Task 3: Idempotent candidate writer (`makeWritePattern`)

**Files:**

- Create: `src/patterns/write.ts`
- Test: `test/patterns/write.test.ts`

- [ ] **Step 1: Write the failing test**

`test/patterns/write.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializePattern, makeWritePattern } from "../../src/patterns/write.js";
import type { CandidatePattern } from "../../src/patterns/types.js";

const PAT: CandidatePattern = {
  id: "pat_scope_1a2b3c4d",
  kind: "commit_scope_hotspot",
  scope: "governance",
  evidenceCount: 3,
  confidence: 0.3,
  evidenceEventIds: ["evt_commit_a", "evt_commit_b", "evt_commit_c"],
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-pat-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("serializePattern", () => {
  it("emits frontmatter fields + a capped evidence list that states the true total", () => {
    const out = serializePattern(PAT, { evidenceCap: 2 });
    expect(out).toContain("kind: commit_scope_hotspot");
    expect(out).toContain("scope: governance");
    expect(out).toContain("status: candidate");
    expect(out).toContain("evidence_count: 3");
    expect(out).toContain("first 2 of 3");
    expect(out).toContain("- evt_commit_a");
    expect(out).not.toContain("- evt_commit_c"); // capped
  });
});

describe("makeWritePattern", () => {
  it("writes a candidate under patterns/candidates/<id>.md and is idempotent", async () => {
    const write = makeWritePattern(ws, { evidenceCap: 20 });
    expect(await write(PAT)).toBe("written");
    const file = join(ws, "patterns", "candidates", "pat_scope_1a2b3c4d.md");
    const first = await readFile(file, "utf8");
    expect(await write(PAT)).toBe("skipped"); // unchanged → skipped
    expect(await readFile(file, "utf8")).toBe(first); // byte-identical
  });

  it("rewrites when evidence changes", async () => {
    const write = makeWritePattern(ws, { evidenceCap: 20 });
    await write(PAT);
    expect(await write({ ...PAT, evidenceCount: 9, confidence: 0.9 })).toBe("written");
    const file = join(ws, "patterns", "candidates", "pat_scope_1a2b3c4d.md");
    expect(await readFile(file, "utf8")).toContain("evidence_count: 9");
  });

  it("never touches patterns/active or patterns/archived", async () => {
    // seed active/archived with sentinel files
    for (const sub of ["active", "archived"]) {
      await mkdir(join(ws, "patterns", sub), { recursive: true });
      await writeFile(join(ws, "patterns", sub, "sentinel.md"), "SENTINEL", "utf8");
    }
    await makeWritePattern(ws, { evidenceCap: 20 })(PAT);
    for (const sub of ["active", "archived"]) {
      expect(await readdir(join(ws, "patterns", sub))).toEqual(["sentinel.md"]);
      expect(await readFile(join(ws, "patterns", sub, "sentinel.md"), "utf8")).toBe("SENTINEL");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- patterns/write`
Expected: FAIL — `Cannot find module '../../src/patterns/write.js'`.

- [ ] **Step 3: Write the implementation**

`src/patterns/write.ts`:

```ts
import matter from "gray-matter";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidatePattern } from "./types.ts";

export type WriteOutcome = "written" | "skipped";

export interface WritePatternOptions {
  evidenceCap: number; // max evidence ids listed in the body
}

/** Deterministic markdown for a candidate pattern (frontmatter + capped evidence body). */
export function serializePattern(p: CandidatePattern, opts: WritePatternOptions): string {
  const shown = p.evidenceEventIds.slice(0, opts.evidenceCap);
  const body =
    `Commit scope \`${p.scope}\` recurred ${p.evidenceCount} times in the L0 corpus.\n\n` +
    `Evidence (first ${shown.length} of ${p.evidenceCount}):\n` +
    shown.map((id) => `- ${id}`).join("\n") +
    "\n";
  return matter.stringify(body, {
    id: p.id,
    kind: p.kind,
    scope: p.scope,
    evidence_count: p.evidenceCount,
    confidence: p.confidence,
    status: "candidate",
    generated_by: "pattern-detector",
  });
}

/** Idempotent writer. WRITE-PATH INVARIANT (spec §4): every path is joined under a fixed
 *  patterns/candidates/ base; this function never references active/ or archived/. */
export function makeWritePattern(
  workspaceDir: string,
  opts: WritePatternOptions,
): (p: CandidatePattern) => Promise<WriteOutcome> {
  const dir = join(workspaceDir, "patterns", "candidates");
  return async (p) => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${p.id}.md`); // id is pat_scope_<8hex> — no path separators
    const next = serializePattern(p, opts);
    try {
      if ((await readFile(file, "utf8")) === next) return "skipped";
    } catch {
      // missing → fall through to write
    }
    await writeFile(file, next, "utf8");
    return "written";
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- patterns/write`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add src/patterns/write.ts test/patterns/write.test.ts
git commit -m "feat(governance): pattern detector — idempotent candidates-only writer"
```

---

### Task 4: Read side (`loadCuratedKeys`, `listPatterns`, `getPattern`)

**Files:**

- Create: `src/patterns/read.ts`
- Test: `test/patterns/read.test.ts`

- [ ] **Step 1: Write the failing test**

`test/patterns/read.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCuratedKeys, listPatterns, getPattern } from "../../src/patterns/read.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-patread-"));
  for (const sub of ["candidates", "active", "archived"]) {
    await mkdir(join(ws, "patterns", sub), { recursive: true });
  }
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function seed(sub: string, id: string, fm: Record<string, unknown>, body = "x") {
  const front = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(join(ws, "patterns", sub, `${id}.md`), `---\n${front}\n---\n${body}\n`, "utf8");
}

describe("loadCuratedKeys", () => {
  it("returns normalized (kind:scope) keys from active and archived, tolerating junk", async () => {
    await seed("active", "p1", { kind: "commit_scope_hotspot", scope: "Governance" });
    await seed("archived", "p2", { kind: "commit_scope_hotspot", scope: "news" });
    await writeFile(join(ws, "patterns", "active", ".gitkeep"), "", "utf8");
    await writeFile(join(ws, "patterns", "active", "broken.md"), "not valid frontmatter", "utf8");
    const keys = await loadCuratedKeys(ws);
    expect(keys.has("commit_scope_hotspot:governance")).toBe(true); // lowercased
    expect(keys.has("commit_scope_hotspot:news")).toBe(true);
    expect(keys.size).toBe(2);
  });

  it("returns an empty set when no curated dirs exist", async () => {
    const bare = await mkdtemp(join(tmpdir(), "boule-bare-"));
    expect((await loadCuratedKeys(bare)).size).toBe(0);
    await rm(bare, { recursive: true, force: true });
  });
});

describe("listPatterns / getPattern", () => {
  it("lists candidates with their frontmatter fields", async () => {
    await seed("candidates", "pat_scope_aaaa1111", {
      kind: "commit_scope_hotspot",
      scope: "governance",
      evidence_count: 7,
      confidence: 0.7,
      status: "candidate",
    });
    const list = await listPatterns(ws);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "pat_scope_aaaa1111",
      scope: "governance",
      evidence_count: 7,
      status: "candidate",
    });
  });

  it("getPattern finds a pattern by id across candidates/active/archived, else null", async () => {
    await seed(
      "candidates",
      "pat_scope_aaaa1111",
      { kind: "commit_scope_hotspot", scope: "governance" },
      "BODY-TEXT",
    );
    const got = await getPattern(ws, "pat_scope_aaaa1111");
    expect(got?.frontmatter.scope).toBe("governance");
    expect(got?.body).toContain("BODY-TEXT");
    expect(await getPattern(ws, "pat_scope_missing0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- patterns/read`
Expected: FAIL — `Cannot find module '../../src/patterns/read.js'`.

- [ ] **Step 3: Write the implementation**

`src/patterns/read.ts`:

```ts
import matter from "gray-matter";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { curatedKeyString } from "./detect.ts";

const SUBDIRS = ["candidates", "active", "archived"] as const;

async function readDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/** Human-curated (active + archived) pattern keys as a normalized `<kind>:<scope>` set.
 *  Tolerant of `.gitkeep` and malformed files. Scope is normalized to match detect.ts. */
export async function loadCuratedKeys(workspaceDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const sub of ["active", "archived"]) {
    const dir = join(workspaceDir, "patterns", sub);
    for (const f of await readDir(dir)) {
      try {
        const { data } = matter(await readFile(join(dir, f), "utf8"));
        const kind = data.kind;
        const scope = data.scope;
        if (typeof kind === "string" && typeof scope === "string") {
          keys.add(curatedKeyString(kind, scope.trim().toLowerCase()));
        }
      } catch {
        // malformed → skip
      }
    }
  }
  return keys;
}

export interface PatternView {
  id: string;
  kind: string;
  scope: string;
  evidence_count: number;
  confidence: number;
  status: string;
}

/** List candidate patterns (frontmatter summary), sorted by id for stable output. */
export async function listPatterns(workspaceDir: string): Promise<PatternView[]> {
  const dir = join(workspaceDir, "patterns", "candidates");
  const out: PatternView[] = [];
  for (const f of (await readDir(dir)).sort()) {
    try {
      const { data } = matter(await readFile(join(dir, f), "utf8"));
      out.push({
        id: String(data.id ?? f.replace(/\.md$/, "")),
        kind: String(data.kind ?? ""),
        scope: String(data.scope ?? ""),
        evidence_count: Number(data.evidence_count ?? 0),
        confidence: Number(data.confidence ?? 0),
        status: String(data.status ?? ""),
      });
    } catch {
      // malformed → skip
    }
  }
  return out;
}

/** Find one pattern by id across candidates/active/archived; null if absent. */
export async function getPattern(
  workspaceDir: string,
  id: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
  for (const sub of SUBDIRS) {
    const file = join(workspaceDir, "patterns", sub, `${id}.md`);
    try {
      const { data, content } = matter(await readFile(file, "utf8"));
      return { frontmatter: data as Record<string, unknown>, body: content.trim() };
    } catch {
      // not here → try next
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- patterns/read`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add src/patterns/read.ts test/patterns/read.test.ts
git commit -m "feat(governance): pattern detector — read side (curated keys + list/get)"
```

---

### Task 5: Orchestrator (`runDetect`) + config knobs

**Files:**

- Modify: `src/patterns/detect.ts` (append `runDetect` + deps)
- Modify: `src/mcp/config.ts` (append `parsePositiveInt` + `parsePatternConfig`)
- Test: `test/patterns/run.test.ts`

- [ ] **Step 1: Write the failing test**

`test/patterns/run.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runDetect } from "../../src/patterns/detect.js";
import { parsePositiveInt, parsePatternConfig } from "../../src/mcp/config.js";
import type { GovEvent } from "../../src/event/event.js";
import type { CandidatePattern } from "../../src/patterns/types.js";

function commit(id: string, subject: string): GovEvent {
  return {
    frontmatter: { id, type: "commit_recorded", source: "git", actor: "a", tags: [] },
    body: subject,
  };
}

describe("parsePositiveInt", () => {
  it("clamps junk/<1/unset to the default", () => {
    expect(parsePositiveInt("7", 5)).toBe(7);
    expect(parsePositiveInt(undefined, 5)).toBe(5);
    expect(parsePositiveInt("0", 5)).toBe(5);
    expect(parsePositiveInt("-3", 5)).toBe(5);
    expect(parsePositiveInt("abc", 5)).toBe(5);
  });
});

describe("parsePatternConfig", () => {
  it("reads env knobs with safe defaults", () => {
    expect(parsePatternConfig({})).toEqual({ minEvidence: 5, confFull: 50, evidenceCap: 20 });
    expect(
      parsePatternConfig({ BOULE_PATTERN_MIN_EVIDENCE: "3", BOULE_PATTERN_CONF_FULL: "10" }),
    ).toEqual({ minEvidence: 3, confFull: 10, evidenceCap: 20 });
  });
});

describe("runDetect", () => {
  it("wires read → detect → write and returns a summary", async () => {
    const events = [
      commit("evt_commit_1", "feat(governance): a"),
      commit("evt_commit_2", "fix(governance): b"),
      commit("evt_commit_3", "docs(governance): c"),
      commit("evt_commit_4", "fix: bare"),
    ];
    const writes: CandidatePattern[] = [];
    const summary = await runDetect({
      readEvents: async () => events,
      loadCuratedKeys: async () => new Set<string>(),
      writePattern: async (p) => {
        writes.push(p);
        return "written";
      },
      options: { minEvidence: 3, confFull: 10, evidenceCap: 20 },
    });
    expect(summary).toMatchObject({
      written: 1,
      skipped: 0,
      candidates: 1,
      droppedNoScope: 1,
      scopesConsidered: 1,
    });
    expect(writes[0].scope).toBe("governance");
  });

  it("fails soft when readEvents throws (0 patterns, no throw)", async () => {
    const summary = await runDetect({
      readEvents: async () => {
        throw new Error("no events dir");
      },
      loadCuratedKeys: async () => new Set<string>(),
      writePattern: async () => "written",
      options: { minEvidence: 3, confFull: 10, evidenceCap: 20 },
    });
    expect(summary).toMatchObject({ written: 0, candidates: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- patterns/run`
Expected: FAIL — `runDetect`/`parsePatternConfig` not exported.

- [ ] **Step 3a: Append the orchestrator to `src/patterns/detect.ts`**

Append to `src/patterns/detect.ts` (keep existing exports; add the import for `GovEvent` is already present, add `WriteOutcome`):

```ts
import type { WriteOutcome } from "./write.ts";

export interface DetectDeps {
  readEvents: () => Promise<readonly GovEvent[]>;
  loadCuratedKeys: () => Promise<ReadonlySet<string>>;
  writePattern: (p: CandidatePattern) => Promise<WriteOutcome>;
  options: DetectOptions;
}

export interface DetectSummary {
  written: number;
  skipped: number;
  candidates: number;
  droppedNoScope: number;
  scopesConsidered: number;
}

/** Orchestrate read → detect → write. Fail-soft on read (mirrors harvest). */
export async function runDetect(deps: DetectDeps): Promise<DetectSummary> {
  let events: readonly GovEvent[] = [];
  try {
    events = await deps.readEvents();
  } catch {
    events = [];
  }
  let curated: ReadonlySet<string> = new Set<string>();
  try {
    curated = await deps.loadCuratedKeys();
  } catch {
    curated = new Set<string>();
  }
  const { patterns, droppedNoScope, scopesConsidered } = detectPatterns(
    events,
    curated,
    deps.options,
  );
  let written = 0;
  let skipped = 0;
  for (const p of patterns) {
    if ((await deps.writePattern(p)) === "written") written++;
    else skipped++;
  }
  return { written, skipped, candidates: patterns.length, droppedNoScope, scopesConsidered };
}
```

- [ ] **Step 3b: Append config helpers to `src/mcp/config.ts`**

Append to `src/mcp/config.ts`:

```ts
/** Parse a positive integer env value; junk / <1 / unset → dflt. (Fail-closed clamp.) */
export function parsePositiveInt(raw: string | undefined, dflt: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

export interface PatternConfig {
  minEvidence: number;
  confFull: number;
  evidenceCap: number;
}

/** Pattern detector knobs from env (safe defaults; evidenceCap is a fixed display cap). */
export function parsePatternConfig(env: Record<string, string | undefined>): PatternConfig {
  return {
    minEvidence: parsePositiveInt(env.BOULE_PATTERN_MIN_EVIDENCE, 5),
    confFull: parsePositiveInt(env.BOULE_PATTERN_CONF_FULL, 50),
    evidenceCap: 20,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- patterns/run`
Expected: PASS.

Then confirm no type regressions: `pnpm exec tsc --noEmit` → no output (clean).

- [ ] **Step 5: Commit**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add src/patterns/detect.ts src/mcp/config.ts test/patterns/run.test.ts
git commit -m "feat(governance): pattern detector — orchestrator + env config knobs"
```

---

### Task 6: MCP tools (`detect`, `patterns`, `pattern`) + `.gitkeep`

**Files:**

- Modify: `src/mcp/server.ts`
- Create: `workspace/patterns/candidates/.gitkeep`
- Test: `test/mcp/patterns.test.ts`

Note: governance is a standalone TS MCP package — these tools are **not** part of the Tauri app's `src/bindings.ts`, so no binding regeneration and no app/Rust/migration changes. The repo bindings-drift gate stays at 0 because `src-tauri/` is untouched.

- [ ] **Step 1: Write the failing test** (exercise the handler wiring directly, mirroring `test/harvest/harvest.test.ts`'s use of `runDetect` against a temp workspace)

`test/mcp/patterns.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDetect } from "../../src/patterns/detect.js";
import { makeWritePattern } from "../../src/patterns/write.js";
import { loadCuratedKeys, listPatterns, getPattern } from "../../src/patterns/read.js";
import { parsePatternConfig } from "../../src/mcp/config.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { deriveEventId } from "../../src/event/id.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-mcp-pat-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function seedCommit(sha: string, subject: string, day: string) {
  await writeEvent(
    ws,
    {
      frontmatter: {
        id: deriveEventId("commit", sha),
        type: "commit_recorded",
        source: "git",
        actor: "a",
        tags: [],
      },
      body: subject,
    },
    new Date(`${day}T00:00:00Z`),
    { disambiguator: sha.slice(0, 7) },
  );
}

describe("pattern MCP round-trip", () => {
  it("detect → patterns → pattern, idempotent on re-run", async () => {
    for (let i = 0; i < 5; i++)
      await seedCommit("a".repeat(39) + i, `feat(governance): c${i}`, "2026-06-02");

    const cfg = parsePatternConfig({});
    const deps = {
      readEvents: () => readAllEvents(ws),
      loadCuratedKeys: () => loadCuratedKeys(ws),
      writePattern: makeWritePattern(ws, { evidenceCap: cfg.evidenceCap }),
      options: cfg,
    };

    const run1 = await runDetect(deps);
    expect(run1.written).toBe(1);
    expect(run1.candidates).toBe(1);

    const list = await listPatterns(ws);
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe("governance");
    expect(list[0].evidence_count).toBe(5);

    const detail = await getPattern(ws, list[0].id);
    expect(detail?.body).toContain("Evidence (first 5 of 5)");

    const run2 = await runDetect(deps); // re-run on unchanged corpus
    expect(run2.written).toBe(0); // idempotent
    expect(run2.skipped).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- mcp/patterns`
Expected: FAIL — modules not yet importable from the new paths via `.js` until Tasks 1–5 are merged (they are). If Tasks 1–5 are done, this test should actually PASS already, since it imports library functions directly. Run it; if it passes, that confirms the library wiring. The remaining work in Steps 3–4 is the _MCP tool registration_ (no separate unit test — verified by the headless smoke in Task 7 and by `tsc`).

> Rationale: the MCP `registerTool` callbacks are thin adapters over already-tested functions (same pattern as the existing `harvest`/`pending_escalations` tools, which have no per-tool unit test). We test the library round-trip here and the live tool via the headless smoke in Task 7.

- [ ] **Step 3: Register the three tools in `src/mcp/server.ts`**

Add imports near the other `../harvest`/`../decision` imports:

```ts
import { runDetect } from "../patterns/detect.ts";
import { makeWritePattern } from "../patterns/write.ts";
import { loadCuratedKeys, listPatterns, getPattern } from "../patterns/read.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { parsePatternConfig } from "./config.ts";
```

Add near the other config constants (after `QUORUM`):

```ts
const PATTERN_CFG = parsePatternConfig(process.env);
```

Register the tools (place after the `harvest` tool registration):

```ts
server.registerTool(
  "detect",
  {
    description:
      "L0 코퍼스를 스캔해 commit scope hotspot 후보 패턴을 patterns/candidates/에 멱등 기록 (read→detect→write)",
    inputSchema: {},
  },
  async () => {
    const summary = await runDetect({
      readEvents: () => readAllEvents(WORKSPACE),
      loadCuratedKeys: () => loadCuratedKeys(WORKSPACE),
      writePattern: makeWritePattern(WORKSPACE, { evidenceCap: PATTERN_CFG.evidenceCap }),
      options: PATTERN_CFG,
    });
    return {
      content: [
        {
          type: "text",
          text:
            `detected: ${summary.written} new, ${summary.skipped} unchanged, ` +
            `${summary.candidates} candidate(s) | dropped(no-scope): ${summary.droppedNoScope} | ` +
            `scopes considered: ${summary.scopesConsidered}`,
        },
      ],
    };
  },
);

server.registerTool(
  "patterns",
  { description: "후보 패턴 목록 (read-only)", inputSchema: {} },
  async () => {
    const list = await listPatterns(WORKSPACE);
    const text = list.length
      ? list
          .map(
            (p) =>
              `- ${p.id} ${p.kind} scope=${p.scope} evidence=${p.evidence_count} conf=${p.confidence} [${p.status}]`,
          )
          .join("\n")
      : "no candidate patterns";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "pattern",
  { description: "단일 패턴 상세 + 근거 이벤트 (read-only)", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const p = await getPattern(WORKSPACE, id);
    const text = p ? `${matterStringifyless(p.frontmatter)}\n\n${p.body}` : `not found: ${id}`;
    return { content: [{ type: "text", text }] };
  },
);
```

For the `pattern` detail rendering, add this small local helper near the top of the file (after imports) — it renders frontmatter as plain lines without re-serializing YAML:

```ts
function matterStringifyless(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}
```

- [ ] **Step 4: Create the candidates dir keeper + verify types**

```bash
cd "$HOME/private_project/work-radar/governance"
mkdir -p workspace/patterns/candidates
: > workspace/patterns/candidates/.gitkeep
pnpm exec tsc --noEmit
pnpm test
```

Expected: `tsc` clean; all tests pass (existing suite + the new `test/patterns/*` + `test/mcp/patterns.test.ts`).

- [ ] **Step 5: Commit**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add src/mcp/server.ts workspace/patterns/candidates/.gitkeep test/mcp/patterns.test.ts
git commit -m "feat(governance): pattern detector — MCP detect/patterns/pattern tools"
```

---

### Task 7: Real-corpus smoke + full gate + critic

**Files:** none (verification only).

- [ ] **Step 1: Headless MCP smoke against the real workspace (read→detect→read)**

```bash
cd "$HOME/private_project/work-radar/governance"
export BOULE_WORKSPACE="$PWD/workspace"
# 1st detect over the populated L0 corpus
node bridge/boule-mcp.mjs detect '{}'
# list candidates
node bridge/boule-mcp.mjs patterns '{}'
# 2nd detect — must be idempotent (0 new)
node bridge/boule-mcp.mjs detect '{}'
```

Expected: run 1 writes N candidates (N ≥ 1, e.g. `governance`, `plan`, …); `patterns` lists them with evidence counts; **run 2 = `0 new`** (idempotent). Pick one id from the list and confirm detail:

```bash
node bridge/boule-mcp.mjs pattern '{"id":"<pat_scope_id_from_list>"}'
```

Expected: frontmatter + an evidence list. Record actual numbers (this is the done-criteria evidence, not prose).

- [ ] **Step 2: Confirm the write-path invariant held on the real run**

```bash
cd "$HOME/private_project/work-radar/governance"
git status --porcelain workspace/patterns/
```

Expected: only `workspace/patterns/candidates/*.md` appear as new/modified — **nothing under `active/` or `archived/`**. (These candidate files are tracked SSOT per the spec; they will be committed.)

- [ ] **Step 3: Full gate**

```bash
cd "$HOME/private_project/work-radar/governance"
pnpm test            # vitest run — all green, note the count
pnpm exec tsc --noEmit   # clean
```

Also confirm the repo-level bindings drift gate is unaffected (no `src-tauri/` change in this slice): from repo root the generated `src/bindings.ts` is unchanged.

- [ ] **Step 4: Commit the generated candidate files**

```bash
cd "$HOME/private_project/work-radar/governance"
export PATH="$HOME/.cargo/bin:$PATH"
git add workspace/patterns/candidates/
git commit -m "chore(governance): seed initial commit-scope-hotspot candidate patterns (detect run)"
```

- [ ] **Step 5: Separate critic pass (NOT self-approve)**

Dispatch an opus `critic` (or `oh-my-claudecode:critic`) over the full slice diff with the spec attached. The critic must independently re-run `pnpm test` + `pnpm exec tsc --noEmit` and verify: the write-path invariant (detector never writes `active/`/`archived/`), idempotency (run2 = 0), curated-dedup correctness, INVARIANT #1/#2 (no automation in decision rails — activation stays a human commit), and no PII/secrets in pattern bodies/logs. Only an explicit critic **ACCEPT (0 blocker / 0 major)** completes the slice. Boule stays PARKED — **commit only, never push** without an explicit request.

---

## Self-Review

**1. Spec coverage:**

- §1.1 decisions (persist candidates / deterministic / manual-activation / one kind / no cron) → Tasks 1–6 + §7 deferrals. ✓
- §2 module boundary (`scope`/`detect`/`write`/`read` + orchestrator) → Tasks 1–5. ✓
- §3 detection (filter commit, parseScope, canonical key, threshold, curated-dedup, confidence, sorted) → Task 2; config knobs → Task 5. ✓
- §4 schema/layout/idempotency/curation + **write-path invariant** → Task 3 (writer + invariant test) + Task 6 (`.gitkeep`) + Task 7 Step 2 (real-run check). ✓
- §5 MCP surface (`detect`/`patterns`/`pattern`) → Task 6. ✓
- §6 invariants/errors/testing → fail-soft (Task 5), no app/Rust change (Task 6 note), tests (Tasks 1–6), critic (Task 7 Step 5). ✓
- §7 deferred → explicitly not implemented. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**3. Type consistency:** `CandidatePattern` (types.ts) used identically in detect/write/read; `WriteOutcome` defined in write.ts and imported by detect.ts orchestrator; `curatedKeyString` defined in detect.ts and reused by read.ts; `DetectOptions`/`PatternConfig` field names (`minEvidence`/`confFull`/`evidenceCap`) consistent across detect.ts, config.ts, server.ts, and tests; `patternId` signature stable. ✓

```

```
