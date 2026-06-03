# Spec — `typo-*` ↔ tailwind-merge conflict resolution (cascade hazard root-cause fix)

- Date: 2026-06-03
- Branch: `feat/typography-tokens`
- Status: design (awaiting review → writing-plans)
- Related: `docs/areas/typography.md` (cascade 주의), `docs/decisions.md` (2026-06-02 typo tokens, 2026-06-03 Slice C defer, 2026-06-03 P4 defer)

## Problem

`@utility typo-*` recipes (size+weight+line+tracking, `src/styles/typography.css`) cannot be
reliably layered on top of components that already carry built-in type classes
(`text-base`, `leading-none`, `font-semibold`, …). Adding `className="typo-title-md"` to such a
component leaves **both** classes in the DOM; in the compiled stylesheet `@utility typo-*` can
sort **before** the built-ins at equal specificity, so the built-in wins and the `typo-*` recipe
is silently ignored.

This blocked two pieces of design-system work, both deferred to a shared prerequisite:

- **Slice C** (R3 arbitrary-typo adoption): mono dialog-label adoption refused because
  `DialogTitle` base `text-base font-semibold` out-sorts `typo-*`.
- **P4** (raw `<button>` → Button variants): a contributing cascade hazard for control type.

The two defers both name the same root blocker: shadcn primitives hardcode competing type and
`typo-*` cannot override it.

## Root cause

`cn()` = `twMerge(clsx(...))` using the **default** tailwind-merge (v3) configuration. Default
tailwind-merge does not know the project-local `typo-*` utilities, so it classifies them as
unknown/arbitrary and **never dedupes** them against the built-in `font-size` / `leading` /
`font-weight` / `tracking` groups. Both the built-in and the `typo-*` class survive the merge,
and final precedence falls to compiled-cascade order — the fragile behavior above.

The hazard is therefore **not** specific to any primitive; it is a merge-configuration gap.

## Approach (chosen: A — root-cause, general)

Replace the default `twMerge` with an `extendTailwindMerge(...)` instance that registers a custom
class group for `typo-*` and marks it as conflicting with the built-in type groups. After this,
`cn("text-base leading-none font-semibold", "typo-title-md")` deterministically resolves to
`typo-title-md` (built-ins stripped) — **compiled-cascade order stops mattering**, and any
component can be overridden with a `typo-*` class without editing the component.

Rejected alternatives:

- **B — edit each primitive's base type to a `typo-*` utility.** No `typo-*` role equals the
  current 16px primitive default (`title-md`=17px, `title-sm`=15px), so it is **not** zero-visual,
  and it fixes only the edited primitives — the general stacking hazard remains.
- **A then B.** Unnecessary now; primitive adoption is a deliberate visual change that belongs to a
  later Slice-C-style pass with eyeball sign-off. Keep this change pure and zero-visual.

## Mechanism (tailwind-merge v3)

A single configured merge instance, shared by both `cn` implementations:

```ts
// shared module (e.g. src/lib/tw.ts)
import { extendTailwindMerge } from "tailwind-merge";

const TYPO = [
  "typo-title-md", "typo-title-sm",
  "typo-body-md", "typo-body-strong",
  "typo-label-sm", "typo-caption-sm",
  "typo-mono-label", "typo-micro",
];

export const twMergeTypo = extendTailwindMerge({
  extend: {
    classGroups: { typo: [{ typo: TYPO.map((c) => c.replace(/^typo-/, "")) }] },
    // bidirectional: a later typo-* strips earlier type built-ins, and a later
    // built-in strips an earlier typo-* (normal last-wins semantics).
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

Notes:

- Each `typo-*` sets font-size + line-height + font-weight + letter-spacing simultaneously, so any
  one of those built-in groups is correctly superseded when `typo-*` comes later.
- `font-family` is included in the conflict set so `typo-mono-label` (which sets `font-mono`)
  resolves against an earlier `font-sans`/`font-mono`. **`text-transform` is intentionally NOT
  included** (no role conflict; YAGNI).
- The exact group-registration form will be finalized against the installed tailwind-merge v3 API
  during implementation (the snippet is the intent, not a guaranteed-verbatim literal). The
  unit-test contract below is the source of truth for behavior.

## Single source of truth for `cn`

Two `cn` copies exist and **differ**:

- `src/components/ui/cn.ts` — `cn` only (shadcn-local, imported by `ui/*` primitives as `./cn`).
- `src/lib/utils.ts` — `cn` **and** `trimOrNull`.

Both currently call `twMerge(clsx(...))` independently. To prevent config drift, the configured
`twMergeTypo` instance lives in one shared module and **both** `cn` implementations use it. The
implementation plan decides the exact wiring (shared `tw.ts` imported by both, or `ui/cn.ts`
re-exporting `cn` from `lib`), preserving existing import paths (`./cn`, `@/lib/utils`) so no call
site changes. `trimOrNull` stays in `lib/utils.ts`.

## Scope

In scope:

- One shared configured-merge module + wiring both `cn` implementations to it.
- Unit tests for the conflict-resolution contract.

Explicitly OUT (keeps this change zero-visual):

- **No primitive edits.** `CardTitle`/`DialogTitle`/`SheetTitle`/`CardDescription`/`PopoverTitle`
  keep current defaults and render identically. The fix only makes them *overridable* by `typo-*`.
- **No new `typo-*` adoptions.** Adopting `typo-title-md` on `AddProjectForm`'s CardTitle
  (16px→17px) and other deferred sites are deliberate visual changes for a later pass with
  sign-off.
- No Rust / IPC / bindings / migration / CSS / design-gate changes.

## Zero-visual evidence (audit)

A repo-wide audit of current `typo-*` usages (15 sites) found **zero** sites that stack a `typo-*`
class with a conflicting `font-size`/`leading`/`font-weight`/`tracking` class. All pair `typo-*`
only with color (`text-foreground`/`text-muted-foreground`/`text-subtle`) and layout utilities,
which live in different merge groups and are untouched. (The single grep hit at
`AddProjectForm.tsx:67` is a comment, not stacked classes.)

Therefore extending the merge changes merge output at **no existing call site** → the rendered
output of the app today is unchanged. The new behavior only manifests when a `typo-*` is *newly*
stacked over a conflicting built-in (i.e., future adoptions), which is exactly the unblock.

## Verification

- **Unit tests** (extend `src/lib/utils.test.ts`, which already exercises twMerge):
  - `cn("text-base leading-none font-semibold", "typo-title-md")` === `"typo-title-md"`.
  - last-wins both directions: `cn("typo-title-md", "text-base")` keeps `text-base` (strips typo);
    `cn("text-base", "typo-title-md")` keeps `typo-title-md`.
  - color is untouched: `cn("text-muted-foreground", "typo-caption-sm")` keeps **both**.
  - `font-family`: `cn("font-sans", "typo-mono-label")` resolves to `typo-mono-label`.
  - two typo roles: `cn("typo-body-md", "typo-title-md")` keeps only the later.
- **Regression**: audit shows 0 affected current sites → no visual change. Run `pnpm typecheck`,
  `pnpm lint`, `pnpm vitest run`, and a production build.
- **Gate**: `scripts/check-design-tokens.mjs` baseline unchanged (no R-rule source edits).
- **bindings drift 0** (no IPC change); Rust/cargo untouched.

## Risks & rollback

- **Risk:** mis-registering the v3 class group could over- or under-strip. Mitigated by the unit
  contract above (covers strip, keep-color, last-wins, font-family, two-typo).
- **Risk:** a future built-in `text-*`/`leading-*` placed *after* a `typo-*` now strips it — this
  is correct last-wins behavior and matches author expectations; documented in
  `docs/areas/typography.md`.
- **Rollback:** revert the merge-config commit; `cn` returns to default twMerge. No data/schema
  impact.

## Non-goals

- App restyle; big-bang `typo-*` migration; primitive default-type changes; lint enforcement of
  `typo-*`; any Rust/bindings/migration work.

## Follow-ups (separate, sign-off required)

- Adopt `typo-*` on primitives/consumers that were blocked (AddProjectForm CardTitle, mono
  dialog-labels from Slice C) — deliberate visual changes, eyeball sign-off (native tauri = user).
- Re-evaluate P4 once primitive type is overridable (still gated by the strict-zero-visual finding
  in the P4 defer).
