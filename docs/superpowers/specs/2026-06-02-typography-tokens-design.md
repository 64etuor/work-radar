# Typography Tokens — Semantic `typo-*` Utilities (Design Spec)

- **Date:** 2026-06-02
- **Status:** Approved design — implementation in progress on `feat/typography-tokens` (2026-06-02). Role table finalized from inventory (below).
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

### Role set (CONFIRMED by Task-1 inventory, 2026-06-02)

Inventory of `src/**`: size histogram `text-[13px]`×32, `[11px]`×25, `[12px]`×24, `[10px]`×8, `[15px]`×4, `[17px]`×3, `[9px]`×2, `[22px]`×1, `[44px]`×1; tracking `0.12em`×4 / `-0.01em`×3 / `0.1em`×2 / `-0.02em`×1; leading `relaxed`×7 / `none`×7 / `tight`×4 / `6`×3 / `snug`×2 / `5`×1; weights `medium`×42 / `semibold`×35 / `bold`×2.

**Decisions from inventory:**

- **`typo-title-md` (anchor) is exact-confirmed.** All 3 `text-[17px]` sites resolve to `text-[17px] leading-tight font-semibold tracking-[-0.01em]` (Tailwind `leading-tight`=1.25, `font-semibold`=600). The token is pinned to **17 / 600 / 1.25 / -0.01em** so the first adoption is a zero-visual-change swap.
- **`typo-mono-label` is exact-confirmed** against `SectionLabel` (`SettingsKit.tsx:10` = `font-mono text-[11px] font-semibold tracking-[0.12em] uppercase`). The utility **bundles `font-family: var(--font-mono)` + `text-transform: uppercase`** (open question resolved: include them — `SectionLabel` always pairs them).
- **The other six roles are the codified forward vocabulary** mapped by size to the dominant bare-usage buckets (13px body, 12px/11px small text, 10px micro). They are applied incrementally; nothing besides the title role migrates in this PR, so their canonical weights are forward design choices (no current-site regression). No seed role was dropped — the set is small (8), coherent, and 1:1 with the DESIGN.md §App Surface Type table.

| Utility            |  px | weight | line | tracking | Maps to (current)                                                  |
| ------------------ | --: | -----: | ---: | -------: | ------------------------------------------------------------------ |
| `typo-title-md`    |  17 |    600 | 1.25 |  -0.01em | project card titles (anchor; **0 visual change**, 3 sites)         |
| `typo-title-sm`    |  15 |    600 |  1.3 |  -0.01em | secondary titles (forward)                                         |
| `typo-body-md`     |  13 |    400 |  1.4 |        0 | dominant body (13px bare, ~12 sites)                               |
| `typo-body-strong` |  13 |    600 |  1.4 |        0 | emphasized 13px (semibold, ~5 sites)                               |
| `typo-label-sm`    |  12 |    500 |  1.4 |        0 | form labels / compact UI (forward)                                 |
| `typo-caption-sm`  |  11 |    400 |  1.4 |        0 | metadata / captions (11px bare, ~17 sites)                         |
| `typo-mono-label`  |  11 |    600 |  1.4 |   0.12em | uppercase mono `SectionLabel` (`font-mono` + `uppercase` bundled)  |
| `typo-micro`       |  10 |    400 |  1.4 |        0 | microcopy (10px, ~8 sites)                                         |

**Open questions resolved:** (1) role set above; (2) `typo-mono-label` bundles `font-family: var(--font-mono)`; (3) defer `<Text>`/`<Heading>` wrappers (Task 8, priority 3); (4) AI rules live in a new `docs/areas/typography.md` routed by `area-map.md` (not AGENTS.md).

## First adoption (proof, in the typography PR)

Replace the triplicated title style with `typo-title-md`:

- `src/components/settings/ProjectCard.tsx` — the inline `<input>` (edit mode) and the `<span>` (view mode). **ADOPTED** — neither site carries a conflicting base type utility, so the recipe applies fully (17px / 600 / 1.25 / -0.01em).
- `src/components/settings/AddProjectForm.tsx` — the `<CardTitle>`. **DEFERRED** (incremental): shadcn `CardTitle`'s base `text-base leading-none` is emitted *after* our `@utility typo-title-md` in the compiled cascade (verified via dist byte offsets: `typo-title-md`≈31835 < `text-base`≈32111 < `leading-none`≈33113), so the base would override the recipe to 16px/lh-1 — a regression. Left on its original arbitrary classes with a code comment; migrate when CardTitle's base type is reconciled.

`typo-title-md` is defined to equal the **current computed values** (17px / 600 / line-height 1.25 / -0.01em), so the two adopted swaps are **zero-visual-change** — verified by computing the resolved CSS cascade (dist offsets above), not by eyeballing.

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

## Open questions — RESOLVED (Task 1, 2026-06-02)

1. **Role set + exact values** — finalized in "Role set (CONFIRMED)" above; `typo-title-md` and `typo-mono-label` are exact-confirmed against current sites, the other six are the forward vocabulary mapped by size.
2. **`typo-mono-label`** — bundles `font-family: var(--font-mono)` + `text-transform: uppercase` (`SectionLabel` always pairs them).
3. **`<Text>`/`<Heading>` wrappers** — deferred (Task 8, priority 3).
4. **AI rules location** — new `docs/areas/typography.md` routed by `area-map.md`.
