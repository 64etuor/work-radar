# Typography Tokens — Semantic `typo-*` Utilities (Design Spec)

- **Date:** 2026-06-02
- **Status:** Approved design — implementation deferred to next session (plan-only push).
- **Scope:** Codify the DESIGN.md typography table as code (token layer + semantic utilities), reconcile the documented-vs-code drift, adopt incrementally. **Separate concern** from the just-shipped settings fix (`88294cc`/`88bd918`).
- **Trigger:** User noticed the project-card title style (`text-[17px] leading-tight font-semibold tracking-[-0.01em]`) is an arbitrary value triplicated across `ProjectCard` (input+span) and `AddProjectForm` (`CardTitle`), and asked whether to introduce design tokens.

## Problem

The repo has a **mature color/border/elevation/shape/font-family token layer** (`src/styles/tokens.css` `@theme`) and DESIGN.md documents a **typography scale table** (Hero 96 → … → Feature Heading 24 → Body 16 → Caption 14 → Micro 12, each with weight/line/tracking). But:

1. **Typography is not codified in code.** Every text style is expressed as arbitrary Tailwind utilities — `text-[NNpx]` appears **~99 times** (`text-[13px]`×32, `[11px]`×25, `[12px]`×24, `[10px]`×8, `[15px]`×4, `[17px]`×3, `[9px]`×2, `[22px]`×1, `[44px]`×1) plus ad-hoc `font-*` / `leading-*` / `tracking-[…]`.
2. **Code drifts from the DESIGN.md SSOT.** `17px` is not a documented size; the app uses `font-semibold` (35 sites) widely while DESIGN.md principle says "avoid heavy bold"; the same role is rendered as `<CardTitle>` in one place and a raw `<span>` in another. The same logical style (e.g. 13px) appears bare, `font-medium`, and `font-semibold` — no single source.
3. **AI-authoring hazard.** With only raw utilities, the model recombines `size + weight + line + tracking` freely, eroding the system. A semantic unit ("a recipe") removes that degree of freedom.

The dense app shell legitimately runs **tighter and heavier** (medium/semibold) than the marketing scale — this is intentional editorial density, not a bug. So reconciliation = **document the app-surface roles in DESIGN.md**, not restyle the app.

## Decisions (locked with user)

- **Form:** `@utility typo-*` semantic classes (bundle all 4 of size+weight+line+tracking) as the primary unit — **plus** a `@theme` token layer (`--text-*` / `--leading-*` / `--tracking-*`) that the utilities reference. `@theme` = ingredients, `@utility` = finished recipe.
- **React components (`<Text>`/`<Heading>`):** **optional, priority 3** — provided only for frequently-repeated patterns; not the main surface (shadcn components like `CardTitle`/`DialogTitle` receive typography via `className="typo-*"`).
- **Drift reconcile:** add an **"App Surface Type" sub-table to DESIGN.md** documenting the actual editorial app-shell roles (intentionally tighter/heavier than the marketing scale). DESIGN.md stays the visual SSOT.
- **Adoption:** define tokens + utilities, apply to **new code**, migrate the **title role as the first adopter** (de-drift the 17px), leave the remaining ~99 sites for **incremental** opportunistic migration. No big-bang migration; no lint enforcement in this effort.

## Target architecture

```txt
src/styles/tokens.css        # @theme: --text-*, --leading-*, --tracking-*  (the ingredient layer)
src/styles/typography.css    # @utility typo-*  (the recipe layer; references the @theme tokens) — NEW, imported alongside tokens.css
src/components/ui/typography.tsx  # OPTIONAL <Text>/<Heading> wrappers (priority 3, may be deferred)
```

`@theme` (ingredients) — example shape:

```css
@theme {
  --text-title-md: 1.0625rem; /* 17px */
  --leading-title-md: 1.25; /* == Tailwind leading-tight, matches current computed value */
  --tracking-title-md: -0.01em;
  /* …one triple per role… */
}
```

`@utility` (recipe) — example:

```css
@utility typo-title-md {
  font-size: var(--text-title-md);
  line-height: var(--leading-title-md);
  font-weight: 600;
  letter-spacing: var(--tracking-title-md);
}
```

Usage: `<span className="typo-title-md">{project.name}</span>` (color stays a separate token util, e.g. `text-foreground` — typography utilities set type only, never color).

### Seed role set (PROVISIONAL — finalized by inventory in Task 1)

Derived from the usage histogram + sampled combos. Exact (weight/line/tracking) per role pinned by the Task-1 inventory; names follow the user's `<role>-<size>` convention.

| Utility            |  px |  weight |   line | tracking | Maps to (current)                                     |
| ------------------ | --: | ------: | -----: | -------: | ----------------------------------------------------- |
| `typo-title-md`    |  17 |     600 |   1.25 |  -0.01em | project card titles (anchor; **0 visual change**)     |
| `typo-title-sm`    |  15 |     600 |  tight |  -0.01em | smaller titles (TBD by inventory)                     |
| `typo-body-md`     |  13 |     400 | normal |        0 | dominant body (13px bare)                             |
| `typo-body-strong` |  13 | 500/600 | normal |        0 | 13px medium/semibold variants                         |
| `typo-label-sm`    |  12 |     500 | normal |        0 | form labels / compact UI                              |
| `typo-caption-sm`  |  11 |     400 |   snug |        0 | metadata / captions                                   |
| `typo-mono-label`  |  11 |     600 | normal |   0.12em | uppercase mono `SectionLabel` (`font-mono uppercase`) |
| `typo-micro`       |  10 |     400 | normal |        0 | microcopy                                             |

> The `font-mono` family stays an explicit class alongside `typo-mono-label` (or the utility includes `font-family: var(--font-mono)`). Decided in Task 1.

## First adoption (proof, in the typography PR)

Replace the triplicated title style with `typo-title-md`:

- `src/components/settings/ProjectCard.tsx` — the inline `<input>` (edit mode) and the `<span>` (view mode).
- `src/components/settings/AddProjectForm.tsx:67` — the `<CardTitle>`.

`typo-title-md` is defined to equal the **current computed values** (17px / 600 / line-height 1.25 / -0.01em), so this is a **zero-visual-change** swap — verified by computing the resolved CSS, not by eyeballing.

## AI authoring rules (added to AGENTS.md or a `docs/areas/` doc)

```md
## Typography rules

- Use `typo-*` semantic typography utilities from `src/styles/typography.css`.
- Do NOT hand-combine raw `text-*` + `font-*` + `leading-*` + `tracking-*` for standard text.
- Do NOT use arbitrary typography values (`text-[15px]`, `leading-[22px]`, `tracking-[-0.01em]`).
- Use `<Text>`/`<Heading>` only when semantic markup or a repeated pattern benefits from a wrapper.
- shadcn/ui components receive typography via `className="typo-*"` unless they already define the correct typography.
- `typo-*` sets type only (size/weight/line/tracking) — color stays a separate token utility (`text-foreground`, …).
```

## Non-goals

- No app visual restyle; no change to the marketing/display scale.
- No big-bang migration of the ~99 arbitrary sites (incremental only).
- No lint/CI enforcement of `typo-*` in this effort (possible later follow-up).
- No Rust/IPC/bindings changes; no migrations.

## Verification strategy

- **Zero visual regression** on migrated sites: resolved `font-size`/`font-weight`/`line-height`/`letter-spacing` identical before/after (compute from the class, or cmux visual smoke on the settings card).
- Gates unaffected: `pnpm typecheck` / `pnpm lint` (0 err) / `pnpm vitest run` / `cargo` untouched / bindings drift 0.
- Tailwind v4.3 `@utility` compiles and the classes are emitted (grep the built CSS or a focused build).
- Separate critic pass (self-approve forbidden).

## Open questions for the plan

1. Final role set + exact (weight/line/tracking) per role — from the Task-1 inventory.
2. Whether `typo-mono-label` bundles `font-family: var(--font-mono)` or leaves `font-mono` explicit.
3. Whether to ship the optional `<Text>`/`<Heading>` wrappers now or defer (lean: defer — priority 3).
4. Where the AI rules live (AGENTS.md "Implementation Rules" vs a new `docs/areas/typography.md` routed by `area-map.md`).
