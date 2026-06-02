# Typography Tokens (`typo-*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codify the DESIGN.md typography table as a two-layer code system — `@theme` tokens (`--text-*`/`--leading-*`/`--tracking-*`) referenced by `@utility typo-*` semantic classes — reconcile the documented-vs-code drift in DESIGN.md, and adopt it first on the project-card title. Existing arbitrary `text-[NNpx]` sites migrate incrementally later.

**Architecture:** `@theme` (tokens.css) holds the ingredient values; `@utility typo-*` (new typography.css) bundles size+weight+line+tracking into one named recipe class that references those tokens. New code uses `typo-*`; the title role is the first adopter (zero visual change). Optional `<Text>`/`<Heading>` wrappers are priority-3 and deferred.

**Tech Stack:** Tailwind CSS v4.3 (`@theme`, `@utility`), Vite, React 19, TypeScript, vitest (happy-dom available).

**Spec:** `docs/superpowers/specs/2026-06-02-typography-tokens-design.md` (read first — it holds the decisions, seed role table, and AI-rules block).

**Source-of-truth note:** DESIGN.md is the visual SSOT. This plan adds an "App Surface Type" sub-table to it FIRST (Task 2), then makes code reference that table. Do not invent type roles that aren't in the sub-table.

**Branch:** create `feat/typography-tokens` off `dev` (do NOT reuse the settings-fix history). Push only on explicit user request.

---

## File Structure

- `src/styles/tokens.css` — MODIFY: add `--text-*` / `--leading-*` / `--tracking-*` triples inside the existing `@theme` block (the ingredient layer). Tailwind v4 auto-generates `text-<name>` size utilities from `--text-*`; that is fine — the recipe layer is what we tell authors to use.
- `src/styles/typography.css` — CREATE: `@utility typo-*` recipe classes referencing the tokens. Imported once (see Task 4 for exact import site).
- `DESIGN.md` — MODIFY: add the "App Surface Type" sub-table under `## Typography`.
- `src/components/settings/ProjectCard.tsx` — MODIFY: title `<input>` + `<span>` → `typo-title-md`.
- `src/components/settings/AddProjectForm.tsx` — MODIFY: `<CardTitle>` → `typo-title-md`.
- `docs/areas/typography.md` — CREATE: the durable typography rule (routed from `area-map.md`).
- `docs/areas/area-map.md` — MODIFY: add a route row for typography.
- `docs/decisions.md` — MODIFY: append the breadcrumb.
- `src/components/ui/typography.tsx` — DEFERRED (Task 8, optional `<Text>`/`<Heading>`).

> **CSS-testing reality:** This repo has no CSS/utility unit tests (vitest env is mostly `node`; Tailwind isn't processed in tests). So `typo-*` correctness is verified by (a) the dev/build emitting the class, and (b) computed-value equivalence against the source classes — NOT by a vitest unit test. The only vitest-testable artifact here is the optional `<Text>`/`<Heading>` wrapper (Task 8), which asserts the rendered `className`. Tasks below use build/grep/computed-value checks instead of red-green unit tests where CSS is the unit; this is an honest adaptation of TDD to a CSS-only change, consistent with the repo's existing test surface.

---

## Task 1: Inventory the real type combos and finalize the role table

**Files:**

- Read-only across `src/**/*.tsx`; output edits land in the spec's seed table (Task 1 finalizes it) and feed Tasks 2-4.

- [ ] **Step 1: Histogram every arbitrary type fragment**

Run:

```bash
cd /Users/davidpark/private_project/work-radar/.claude/worktrees/skills-mgr-migration
grep -rhoE "text-\[[0-9]+px\]" src | sort | uniq -c | sort -rn
grep -rhoE "tracking-\[-?0?\.[0-9]+em\]" src | sort | uniq -c | sort -rn
grep -rhoE "leading-[a-z0-9]+" src | sort | uniq -c | sort -rn
grep -rhoE "font-(thin|light|normal|medium|semibold|bold)" src | sort | uniq -c | sort -rn
```

Expected: the size histogram (`13`×~32, `11`×~25, `12`×~24, `10`×~8, `15`×~4, `17`×~3, `9`×~2, `22`×1, `44`×1), tracking `-0.01em` / `0.12em` / `0.1em`, leadings `tight/none/relaxed/snug/5/6`, weights `medium`×~42 / `semibold`×~35 / `bold`×2.

- [ ] **Step 2: For each recurring size, capture its dominant (weight, line, tracking) co-occurrence**

Run (repeat per size 17/15/13/12/11/10):

```bash
for s in 17 15 13 12 11 10; do
  echo "== ${s}px =="
  grep -rhoE "text-\[${s}px\][^\"\\']*" src | sed -E "s/.*(text-\[${s}px\][^\"']*)/\1/" | sort | uniq -c | sort -rn | head
done
```

Expected: a ranked list of class strings per size. Use the dominant combo as the role's canonical values; treat rare one-offs as migration exceptions (keep their arbitrary classes for now).

- [ ] **Step 3: Finalize the role table in the spec**

Edit `docs/superpowers/specs/2026-06-02-typography-tokens-design.md` "Seed role set" table: replace the PROVISIONAL note with the confirmed values from Steps 1-2. Resolve the open questions there: drop any seed role with <2 real sites (YAGNI), and decide whether `typo-mono-label` includes `font-family: var(--font-mono)` (it should, since `SectionLabel` always pairs `font-mono` with the uppercase tracking). Keep `typo-title-md = 17 / 600 / 1.25 / -0.01em` fixed (it is the anchor and must match current computed values exactly).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-02-typography-tokens-design.md
git commit -m "docs(typography): finalize app-surface role table from usage inventory"
```

---

## Task 2: Add the "App Surface Type" sub-table to DESIGN.md (SSOT first)

**Files:**

- Modify: `DESIGN.md` (under `## Typography`, after the existing marketing-scale table at lines ~85-97 and its `### Principles`).

- [ ] **Step 1: Insert the sub-table**

Add a new subsection. Use the finalized values from Task 1 (the row set below is the seed — reconcile to Task 1's confirmed values before committing):

```markdown
### App Surface Type (work-radar shell)

The dense desktop shell runs **tighter and heavier** than the marketing scale above — this is intentional editorial density for an information-dense command surface, and it overrides the "avoid heavy bold" principle _for app-shell UI only_ (marketing/display type still follows the table above). These roles are codified as `typo-*` utilities in `src/styles/typography.css`.

| Utility            |  px | weight | line | tracking | Use                                           |
| ------------------ | --: | -----: | ---: | -------: | --------------------------------------------- |
| `typo-title-md`    |  17 |    600 | 1.25 |  -0.01em | Card/section titles (project cards).          |
| `typo-title-sm`    |  15 |    600 |  1.3 |  -0.01em | Secondary titles.                             |
| `typo-body-md`     |  13 |    400 |  1.4 |        0 | Default dense body.                           |
| `typo-body-strong` |  13 |    600 |  1.4 |        0 | Emphasized body / inline headers.             |
| `typo-label-sm`    |  12 |    500 |  1.4 |        0 | Form labels, compact UI.                      |
| `typo-caption-sm`  |  11 |    400 |  1.4 |        0 | Metadata, captions.                           |
| `typo-mono-label`  |  11 |    600 |  1.4 |   0.12em | Uppercase mono section markers (`font-mono`). |
| `typo-micro`       |  10 |    400 |  1.4 |        0 | Microcopy, footers.                           |

Rule: author with the `typo-*` utility, never re-combine raw `text-/font-/leading-/tracking-` for these roles. `typo-*` sets type only; pair with a color utility (`text-foreground`, `text-muted-foreground`, …).
```

- [ ] **Step 2: Verify DESIGN.md still reads coherently**

Run: `grep -n "App Surface Type" DESIGN.md` → Expected: one hit at the new subsection.

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): add App Surface Type sub-table (reconcile app-shell typography drift)"
```

---

## Task 3: Add the `@theme` token layer (ingredients) to tokens.css

**Files:**

- Modify: `src/styles/tokens.css` — inside the existing `@theme { … }` block (near the `--font-*` declarations around line 86-88).

- [ ] **Step 1: Add the token triples**

Inside `@theme`, add (px→rem at 16px base; values per Task 1):

```css
/* ── App Surface typography (DESIGN.md §App Surface Type). Ingredients for typo-* utilities. ── */
--text-title-md: 1.0625rem; /* 17px */
--text-title-sm: 0.9375rem; /* 15px */
--text-body-md: 0.8125rem; /* 13px */
--text-label-sm: 0.75rem; /* 12px */
--text-caption-sm: 0.6875rem; /* 11px */
--text-micro: 0.625rem; /* 10px */

--leading-title-md: 1.25;
--leading-title-sm: 1.3;
--leading-body-md: 1.4;
--leading-label-sm: 1.4;
--leading-caption-sm: 1.4;
--leading-micro: 1.4;

--tracking-title-md: -0.01em;
--tracking-title-sm: -0.01em;
--tracking-body-md: 0em;
--tracking-label-sm: 0em;
--tracking-caption-sm: 0em;
--tracking-mono-label: 0.12em;
--tracking-micro: 0em;
```

> Note: Tailwind v4 will auto-emit `text-title-md` etc. size utilities from `--text-*`. We do NOT instruct authors to use those bare size utilities — the recipe (`typo-*`) is the API. This is acceptable token-layer leakage.

- [ ] **Step 2: Verify the dev server / build still compiles**

Run: `pnpm typecheck` (CSS doesn't typecheck, but confirms no import break) → Expected: exit 0. Then `pnpm build 2>&1 | tail -5` → Expected: build succeeds (CSS parsed).

- [ ] **Step 3: Commit**

```bash
git add src/styles/tokens.css
git commit -m "feat(typography): add app-surface @theme type tokens (--text/--leading/--tracking)"
```

---

## Task 4: Create typography.css with `@utility typo-*` (recipes) and wire the import

**Files:**

- Create: `src/styles/typography.css`
- Modify: the CSS entry that imports `tokens.css` (find it — Step 1).

- [ ] **Step 1: Find where tokens.css is imported**

Run: `grep -rn "tokens.css\|@import\|styles/" src/main.tsx src/styles/*.css src/**/*.css 2>/dev/null | grep -i "tokens\|import"`
Expected: locate the import chain (e.g. an `index.css`/`base.css` that `@import`s `tokens.css`, or `main.tsx` importing CSS). Add `typography.css` to the SAME place, AFTER `tokens.css` (so the tokens exist when utilities reference them).

- [ ] **Step 2: Write typography.css**

```css
/*
 * App Surface typography recipes (DESIGN.md §App Surface Type).
 * One @utility per role = size+weight+line+tracking bundled, referencing tokens.css @theme vars.
 * Authoring rule: use these; never hand-combine raw text-/font-/leading-/tracking- for these roles.
 * typo-* sets type only — pair with a color utility (text-foreground, …).
 */

@utility typo-title-md {
  font-size: var(--text-title-md);
  line-height: var(--leading-title-md);
  font-weight: 600;
  letter-spacing: var(--tracking-title-md);
}

@utility typo-title-sm {
  font-size: var(--text-title-sm);
  line-height: var(--leading-title-sm);
  font-weight: 600;
  letter-spacing: var(--tracking-title-sm);
}

@utility typo-body-md {
  font-size: var(--text-body-md);
  line-height: var(--leading-body-md);
  font-weight: 400;
  letter-spacing: var(--tracking-body-md);
}

@utility typo-body-strong {
  font-size: var(--text-body-md);
  line-height: var(--leading-body-md);
  font-weight: 600;
  letter-spacing: var(--tracking-body-md);
}

@utility typo-label-sm {
  font-size: var(--text-label-sm);
  line-height: var(--leading-label-sm);
  font-weight: 500;
  letter-spacing: var(--tracking-label-sm);
}

@utility typo-caption-sm {
  font-size: var(--text-caption-sm);
  line-height: var(--leading-caption-sm);
  font-weight: 400;
  letter-spacing: var(--tracking-caption-sm);
}

@utility typo-mono-label {
  font-family: var(--font-mono);
  font-size: var(--text-caption-sm);
  line-height: var(--leading-caption-sm);
  font-weight: 600;
  letter-spacing: var(--tracking-mono-label);
  text-transform: uppercase;
}

@utility typo-micro {
  font-size: var(--text-micro);
  line-height: var(--leading-micro);
  font-weight: 400;
  letter-spacing: var(--tracking-micro);
}
```

- [ ] **Step 3: Add the import (exact line from Step 1)**

If `tokens.css` is imported via `@import "./tokens.css";` in some `*.css`, add directly below it:

```css
@import "./typography.css";
```

If CSS is imported in `main.tsx`, add `import "./styles/typography.css";` after the tokens import.

- [ ] **Step 4: Verify the utility is emitted**

Run: `pnpm build 2>&1 | tail -5 && grep -rl "typo-title-md" dist/assets/*.css 2>/dev/null && echo "EMITTED"`
Expected: build succeeds. (Note: Tailwind only emits a utility if it's referenced in markup OR safelisted. Since no markup uses `typo-title-md` yet at this point, it may NOT appear in dist until Task 5. If `EMITTED` is absent here, that's expected — re-run this check after Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/styles/typography.css src/styles/  # plus the modified import file
git commit -m "feat(typography): add typo-* @utility recipe classes"
```

---

## Task 5: First adoption — project card title → `typo-title-md` (zero visual change)

**Files:**

- Modify: `src/components/settings/ProjectCard.tsx` (the `ProjectIdentityEditor` input + span, ~lines 261 & 267)
- Modify: `src/components/settings/AddProjectForm.tsx:67` (the `<CardTitle>`)

- [ ] **Step 1: Confirm the current computed values match the token**

The three sites currently use `text-[17px] leading-tight font-semibold tracking-[-0.01em]`. Tailwind `leading-tight` = 1.25, `font-semibold` = 600. `typo-title-md` = 17px / 1.25 / 600 / -0.01em → identical. Confirm by reading the three sites:
Run: `grep -n "text-\[17px\]" src/components/settings/ProjectCard.tsx src/components/settings/AddProjectForm.tsx`
Expected: 3 hits (ProjectCard input, ProjectCard span, AddProjectForm CardTitle).

- [ ] **Step 2: Swap ProjectCard input (edit mode)**

In `src/components/settings/ProjectCard.tsx`, the input's `className` cn() currently includes:

```
"text-[17px] leading-tight font-semibold tracking-[-0.01em] disabled:opacity-50",
```

Replace the type fragment with the utility (keep `disabled:opacity-50` and the other layout/border lines unchanged):

```
"typo-title-md disabled:opacity-50",
```

- [ ] **Step 3: Swap ProjectCard span (view mode)**

The span currently:

```
className="cursor-text truncate text-[17px] leading-tight font-semibold tracking-[-0.01em]"
```

→

```
className="typo-title-md cursor-text truncate"
```

- [ ] **Step 4: Swap AddProjectForm CardTitle**

`src/components/settings/AddProjectForm.tsx:67`:

```
<CardTitle className="mt-1 text-[17px] leading-tight tracking-[-0.01em]">
```

Note: this one has NO `font-semibold` (CardTitle may set its own weight). Check CardTitle's default weight first:
Run: `grep -n "font-" src/components/ui/card.tsx`
If `CardTitle` already applies a weight, decide: either keep parity by using `typo-title-md` (which forces 600) or, if CardTitle's default differs and you must preserve it exactly, leave this site for the incremental pass and note it. Default action: use `typo-title-md` and drop the raw fragment:

```
<CardTitle className="typo-title-md mt-1">
```

Verify the rendered weight is unchanged (CardTitle titles are already bold-ish; if a visible change appears, revert this one site and migrate it later).

- [ ] **Step 5: Verify zero visual regression + gates**

Run:

```bash
pnpm exec prettier --write src/components/settings/ProjectCard.tsx src/components/settings/AddProjectForm.tsx
pnpm typecheck && pnpm lint && pnpm vitest run 2>&1 | tail -3
pnpm build 2>&1 | tail -3 && grep -rl "typo-title-md" dist/assets/*.css && echo "EMITTED"
```

Expected: typecheck 0, lint 0 errors (baseline warnings only), vitest unchanged count, build OK, `EMITTED` present (now that markup references it). Then a cmux/manual visual check of the settings project card: title looks identical.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/ProjectCard.tsx src/components/settings/AddProjectForm.tsx
git commit -m "feat(settings): adopt typo-title-md on project card titles (de-drift 17px)"
```

---

## Task 6: Durable typography rule + area routing

**Files:**

- Create: `docs/areas/typography.md`
- Modify: `docs/areas/area-map.md` (add a route row)

- [ ] **Step 1: Write `docs/areas/typography.md`**

```markdown
# 타이포그래피 규율 (App Surface Type)

정본: `DESIGN.md` §App Surface Type(역할 표) + `src/styles/typography.css`(`@utility typo-*`) + `src/styles/tokens.css`(`--text-*`/`--leading-*`/`--tracking-*`).

## 규칙

- 표준 텍스트 스타일은 `typo-*` 시맨틱 유틸리티(`src/styles/typography.css`)를 쓴다.
- raw `text-*` + `font-*` + `leading-*` + `tracking-*`를 손으로 조합하지 않는다.
- arbitrary 타이포 값(`text-[15px]`, `leading-[22px]`, `tracking-[-0.01em]`)을 쓰지 않는다.
- `<Text>`/`<Heading>` 래퍼는 시맨틱 마크업/반복 패턴에 이득이 있을 때만(선택).
- shadcn/ui 컴포넌트(`CardTitle`/`DialogTitle`/`FormDescription` 등)는 `className="typo-*"`로 타이포를 받는다 — 해당 컴포넌트가 이미 올바른 타이포를 정의한 경우 제외.
- `typo-*`는 타입(size/weight/line/tracking)만 — 색은 별도 토큰 유틸(`text-foreground` 등).

## 점진 채택

기존 arbitrary `text-[NNpx]` (~99곳)은 legacy. 닿는 김에 기회적으로 `typo-*`로 교체하되, 이 정합성만을 위한 광범위 리팩터 PR은 만들지 않는다(한 PR=한 관심사). 드문 1회성 크기(`44px`/`22px`/`9px`)는 역할이 없으면 arbitrary 유지.
```

- [ ] **Step 2: Add the area-map route**

In `docs/areas/area-map.md`, add a row routing typography-related globs (`src/styles/typography.css`, `src/styles/tokens.css` type tokens, any `typo-*` work) → `docs/areas/typography.md`. Match the table's existing format.

- [ ] **Step 3: Commit**

```bash
git add docs/areas/typography.md docs/areas/area-map.md
git commit -m "docs(areas): add typography rule + area-map route"
```

---

## Task 7: Decisions breadcrumb + final verification

**Files:**

- Modify: `docs/decisions.md` (append)

- [ ] **Step 1: Run the full gate sweep**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm typecheck && pnpm lint 2>&1 | tail -2 && pnpm vitest run 2>&1 | tail -3
pnpm build 2>&1 | tail -3
( cd src-tauri && cargo test --lib 2>&1 | grep "test result" | tail -1 )  # should be UNCHANGED (no Rust touched)
git diff --stat origin/dev..HEAD -- src/bindings.ts  # expect: no change (bindings drift 0)
```

Expected: typecheck 0, lint 0 errors, vitest unchanged, build OK, cargo unchanged, bindings unchanged.

- [ ] **Step 2: Append the decisions breadcrumb**

Append one dense entry to `docs/decisions.md` summarizing: the two-layer system (`@theme` ingredients + `@utility typo-*` recipes), the DESIGN.md App Surface sub-table reconcile, the title-first adoption (zero visual change), incremental policy, and the critic verdict.

- [ ] **Step 3: Separate critic pass (self-approve forbidden)**

Dispatch `oh-my-claudecode:critic` (separate context) to review the full diff for: zero-visual-change correctness on the three title sites, `@theme`/`@utility` referencing correctness (utilities resolve the right vars), no drift between DESIGN.md table and the CSS values, INVARIANTs intact, no unintended emission/regression. Require ACCEPT (0 blockers) before considering the branch done.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions.md
git commit -m "docs(decisions): typography token system breadcrumb"
```

---

## Task 8 (DEFERRED / OPTIONAL): `<Text>` / `<Heading>` wrappers

Priority 3 — implement ONLY if repeated patterns clearly benefit. If pursued:

**Files:** Create `src/components/ui/typography.tsx`; Test `src/components/ui/typography.test.tsx`.

- [ ] **Step 1: Failing test (this IS vitest-testable — it asserts className)**

```tsx
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Text } from "./typography";

describe("Text", () => {
  it("applies the typo-* utility for its variant", () => {
    const html = renderToStaticMarkup(<Text variant="body-md">hi</Text>);
    expect(html).toContain("typo-body-md");
  });
});
```

- [ ] **Step 2: Run → FAIL** (`Text` not defined). Run: `pnpm vitest run src/components/ui/typography.test.tsx`

- [ ] **Step 3: Minimal implementation**

```tsx
import type { ReactNode } from "react";
import { cn } from "./cn";

type Variant =
  | "title-md"
  | "title-sm"
  | "body-md"
  | "body-strong"
  | "label-sm"
  | "caption-sm"
  | "mono-label"
  | "micro";

export function Text({
  variant,
  className,
  children,
}: {
  variant: Variant;
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn(`typo-${variant}`, className)}>{children}</span>;
}
```

- [ ] **Step 4: Run → PASS.** Then `Heading` analogously (renders `<h2>`/configurable). Commit.

---

## Self-Review (completed by plan author)

- **Spec coverage:** two-layer `@theme`+`@utility` (Tasks 3-4) ✓; React wrappers optional/deferred (Task 8) ✓; DESIGN.md App Surface reconcile (Task 2) ✓; title-first adoption zero-visual-change (Task 5) ✓; AI rules block (Task 6) ✓; incremental-not-bigbang (Task 6 policy) ✓; non-goals respected (no Rust/bindings/migration) ✓.
- **Placeholder scan:** role values are concrete seeds; Task 1 confirms them against inventory (not a placeholder — it has exact commands + a concrete fallback table). No "TBD/handle edge cases".
- **Type consistency:** utility names (`typo-title-md`, …) and token names (`--text-title-md`/`--leading-title-md`/`--tracking-title-md`) are consistent across Tasks 2/3/4/5/8.
- **Known adaptation:** CSS-utility correctness is verified by build emission + computed-value equivalence + visual smoke, not vitest unit tests (repo has no CSS test surface). Only Task 8's component is vitest-unit-tested. This is called out in File Structure.
- **Risk on Task 5 Step 4:** `AddProjectForm` `CardTitle` lacked `font-semibold`; the step includes a check + revert-and-defer fallback if `typo-title-md`'s forced 600 changes its rendered weight.
