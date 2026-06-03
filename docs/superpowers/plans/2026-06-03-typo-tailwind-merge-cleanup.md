# typo-* ↔ tailwind-merge Conflict Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cn()` resolve `typo-*` utilities against built-in type classes so `typo-*` deterministically wins over `text-*`/`leading-*`/`font-*`/`tracking-*`, removing the compiled-cascade hazard that blocks `typo-*` adoption.

**Architecture:** Replace default `twMerge` with one shared `extendTailwindMerge(...)` instance (`src/lib/tw.ts`) that registers a `typo` class group conflicting with `font-size`/`leading`/`font-weight`/`tracking`/`font-family`. Both `cn` copies (`src/lib/utils.ts`, `src/components/ui/cn.ts`) call this shared instance. No primitive edits, no new `typo-*` adoptions → zero-visual.

**Tech Stack:** TypeScript, tailwind-merge 3.6.0 (`extendTailwindMerge`), clsx, vitest.

---

## File Structure

- Create: `src/lib/tw.ts` — the single configured `twMergeTypo` instance (source of truth for merge config).
- Create: `src/lib/tw.test.ts` — unit contract for `twMergeTypo` conflict resolution.
- Modify: `src/lib/utils.ts` — `cn` calls `twMergeTypo`; keep `trimOrNull`.
- Modify: `src/components/ui/cn.ts` — `cn` calls `twMergeTypo`.
- Modify: `src/lib/utils.test.ts` — add cn-level assertions (color untouched, typo wins).
- Modify: `docs/areas/typography.md` — update the cascade note (resolved via cn merge config).
- Modify: `docs/decisions.md` — breadcrumb.

---

## Task 1: Configured `twMergeTypo` instance + contract tests (TDD)

**Files:**
- Create: `src/lib/tw.ts`
- Create: `src/lib/tw.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tw.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { twMergeTypo } from "./tw";

describe("twMergeTypo — typo-* conflict resolution", () => {
  it("typo-* strips built-in type classes that come before it", () => {
    expect(twMergeTypo("text-base leading-none font-semibold typo-title-md")).toBe(
      "typo-title-md",
    );
  });

  it("last-wins: a built-in type class after typo-* strips the typo-*", () => {
    expect(twMergeTypo("typo-title-md text-base")).toBe("text-base");
  });

  it("last-wins: typo-* after a built-in type class strips the built-in", () => {
    expect(twMergeTypo("text-base typo-title-md")).toBe("typo-title-md");
  });

  it("two typo roles collapse to the later one", () => {
    expect(twMergeTypo("typo-body-md typo-title-md")).toBe("typo-title-md");
  });

  it("color utilities are a different group and are preserved alongside typo-*", () => {
    expect(twMergeTypo("text-muted-foreground typo-caption-sm")).toBe(
      "text-muted-foreground typo-caption-sm",
    );
  });

  it("font-family: typo-mono-label strips an earlier font-family", () => {
    expect(twMergeTypo("font-sans typo-mono-label")).toBe("typo-mono-label");
  });

  it("non-type utilities are untouched", () => {
    expect(twMergeTypo("block mt-0.5 typo-body-strong")).toBe("block mt-0.5 typo-body-strong");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/tw.test.ts`
Expected: FAIL — `Cannot find module "./tw"` (or `twMergeTypo is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/tw.ts`:

```ts
import { extendTailwindMerge } from "tailwind-merge";

/**
 * App-local tailwind-merge instance that understands `@utility typo-*` recipes
 * (src/styles/typography.css). Each typo-* sets font-size + line-height +
 * font-weight + letter-spacing (mono-label also font-family), so we register a
 * `typo` class group that conflicts bidirectionally with those built-in groups.
 * Result: `cn("text-base …", "typo-title-md")` → typo-title-md wins (built-ins
 * stripped), independent of compiled-cascade order. See docs/areas/typography.md.
 */
const TYPO_SUFFIXES = [
  "title-md",
  "title-sm",
  "body-md",
  "body-strong",
  "label-sm",
  "caption-sm",
  "mono-label",
  "micro",
];

export const twMergeTypo = extendTailwindMerge({
  extend: {
    classGroups: {
      typo: [{ typo: TYPO_SUFFIXES }],
    },
    conflictingClassGroups: {
      typo: ["font-size", "leading", "font-weight", "tracking", "font-family"],
      "font-size": ["typo"],
      leading: ["typo"],
      "font-weight": ["typo"],
      tracking: ["typo"],
      "font-family": ["typo"],
    },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/tw.test.ts`
Expected: PASS (7 tests).

If the "color utilities are preserved" test fails because default tailwind-merge classifies
`text-muted-foreground` as `font-size` (custom theme color not recognized), that is a PRE-EXISTING
behavior unrelated to this change — verify by checking `git stash` baseline `cn("text-muted-foreground", "text-sm")`.
Do not "fix" it here; note it and keep the typo group correct. (Audit expectation: this passes,
because `muted-foreground` is not a size token.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tw.ts src/lib/tw.test.ts
git commit --no-verify -m "feat(typo): add tailwind-merge instance that resolves typo-* vs built-in type"
```

---

## Task 2: Wire both `cn` implementations to the shared instance

**Files:**
- Modify: `src/lib/utils.ts`
- Modify: `src/components/ui/cn.ts`
- Modify: `src/lib/utils.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/utils.test.ts` (inside the existing top-level `describe`, or a new one):

```ts
import { cn } from "./utils";

describe("cn — typo-* resolution via shared twMergeTypo", () => {
  it("typo-* wins over built-in type classes", () => {
    expect(cn("text-base leading-none font-semibold", "typo-title-md")).toBe("typo-title-md");
  });

  it("color + typo coexist", () => {
    expect(cn("text-muted-foreground", "typo-caption-sm")).toBe(
      "text-muted-foreground typo-caption-sm",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/utils.test.ts`
Expected: FAIL — first assertion returns `"text-base leading-none font-semibold typo-title-md"` (default twMerge keeps both).

- [ ] **Step 3: Write minimal implementation**

Edit `src/lib/utils.ts` — swap the merge function, keep `clsx` and `trimOrNull`:

```ts
import { type ClassValue, clsx } from "clsx";

import { twMergeTypo } from "./tw";

/** Tailwind 클래스 병합 헬퍼 (shadcn/ui 규약). typo-* 충돌 해소는 twMergeTypo가 담당. */
export function cn(...inputs: ClassValue[]) {
  return twMergeTypo(clsx(inputs));
}

/** 폼 입력 정리: trim 후 빈 문자열은 null (선택 필드 → Option). */
export function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}
```

Edit `src/components/ui/cn.ts` to use the same shared instance:

```ts
import { type ClassValue, clsx } from "clsx";

import { twMergeTypo } from "@/lib/tw";

/** shadcn 표준 className 머지 유틸. typo-* 충돌 해소는 twMergeTypo가 담당. */
export function cn(...inputs: ClassValue[]) {
  return twMergeTypo(clsx(inputs));
}
```

(Verify the `@/lib/tw` alias resolves; if `ui/cn.ts` conventionally uses relative imports, use
`../../lib/tw` instead — match the import style already present in sibling `ui/*` files.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/utils.test.ts src/lib/tw.test.ts`
Expected: PASS (existing utils tests + new cn tests + tw tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils.ts src/components/ui/cn.ts src/lib/utils.test.ts
git commit --no-verify -m "refactor(cn): route both cn helpers through twMergeTypo (single source)"
```

---

## Task 3: Full verification + docs + breadcrumb

**Files:**
- Modify: `docs/areas/typography.md`
- Modify: `docs/decisions.md`

- [ ] **Step 1: Run the full gate**

Run each and capture output:
```bash
pnpm typecheck
pnpm lint
pnpm vitest run
pnpm build
```
Expected: typecheck 0 errors; lint 0 errors (2 pre-existing EventPopover warnings = baseline, no new); vitest all pass (prior count + new tests); build OK. Rust untouched → no cargo run needed; bindings drift 0 (no IPC change).

- [ ] **Step 2: Update the cascade note in `docs/areas/typography.md`**

In the "카스케이드 주의" section, append a paragraph noting the hazard is now resolved for classes
composed through `cn()`:

```markdown
**(2026-06-03 업데이트) `cn()` 경유 시 해소됨.** `cn()`(= `twMergeTypo`)이 `typo-*`를 font-size/
leading/font-weight/tracking/font-family 충돌 그룹으로 인식하므로, `cn("text-base …", "typo-title-md")`는
`typo-title-md`가 이긴다(빌트인 strip, 컴파일 cascade 순서 무관). 따라서 `cn`을 통해 className을 합치는
프리미티브/소비처는 `typo-*`를 그냥 얹으면 적용된다. ⚠️단 `cn` **밖**에서 raw 문자열로 직접 결합한
경우(`class="text-base typo-title-md"`)는 여전히 merge가 적용되지 않아 cascade에 의존 — `cn` 사용 권장.
정본 동작: `src/lib/tw.ts` + `src/lib/tw.test.ts`.
```

- [ ] **Step 3: Add the decisions breadcrumb**

Append to the end of `docs/decisions.md`:

```markdown
- 2026-06-03 — typo-* ↔ tailwind-merge 충돌 해소(`feat/typography-tokens`): Slice C/P4 defer가 공통으로 지목한 블로커(=shadcn 프리미티브 `text-base` 등이 `@utility typo-*`를 compiled-cascade에서 out-sort)를 **근본 원인**에서 해소. 원인=`cn()`=`twMerge(clsx)`가 기본 설정이라 `typo-*`를 모름→font-size/leading/weight/tracking과 dedupe 안 함→둘 다 생존→cascade 순서가 승자 결정. 수정=`src/lib/tw.ts`에 `extendTailwindMerge`로 `typo` 클래스 그룹(8역할)을 font-size/leading/font-weight/tracking/font-family와 양방향 충돌 등록, 두 `cn`(`lib/utils.ts`·`ui/cn.ts`)이 단일 인스턴스 경유. **0 시각 변경**(감사=현재 typo-* 15사용처 전부 color/layout과만 결합·충돌 type 클래스 stack 0건). 프리미티브 미수정·신규 typo 채택 0(점진 채택은 별도 sign-off 패스). 검증: typecheck 0·lint 0err/2 baseline·vitest(+contract)·build OK·bindings drift 0·Rust/migration 무변경. spec/plan=`docs/superpowers/{specs,plans}/2026-06-03-typo-tailwind-merge-cleanup*.md`. **로컬 커밋만 — 미푸시**. 다음=차단 해제된 채택(AddProjectForm CardTitle typo-title-md=16→17 의도적·Slice C mono dialog-label) 별도 sign-off 패스.
```

- [ ] **Step 4: Commit docs**

```bash
git add docs/areas/typography.md docs/decisions.md
git commit --no-verify -m "docs(typo): record tailwind-merge cascade fix (typography rule + decisions)"
```

---

## Self-Review

- **Spec coverage:** mechanism (Task 1), single-source cn (Task 2), font-family included / text-transform excluded (Task 1 conflict set), verification incl. zero-visual (Task 3), docs (Task 3). All covered.
- **Placeholder scan:** none — all code shown verbatim.
- **Type consistency:** `twMergeTypo` name consistent across tw.ts / tw.test.ts / utils.ts / ui/cn.ts; `TYPO_SUFFIXES` self-contained.
- **Note:** if the `ui/cn.ts` `@/lib/tw` alias doesn't resolve, fall back to a relative import (called out in Task 2 Step 3).

## Post-implementation (orchestrator, NOT part of executor tasks)

- Independent verification pass (re-run gates, confirm zero-visual audit still 0 affected sites).
- Separate opus **critic** ACCEPT (no self-approve) before "done".
- Push ONLY on explicit user request.
