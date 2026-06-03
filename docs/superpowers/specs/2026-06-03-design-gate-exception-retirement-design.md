# Design Gate-Exception Retirement (P3 Slice AB)

- Date: 2026-06-03
- Branch: `feat/typography-tokens`
- Phase: P3 design-system program, Slice AB (combined: overlay token + R1 RetroView emoji)
- Predecessors: P1 (design quality gate, `scripts/check-design-tokens.mjs`), P2 (DESIGN.md reconcile)

## Problem

The design quality gate carries three standing exceptions that exist only because the
codebase lacks a token / has a decorative emoji — not because the off-token usage is
genuinely desired:

1. **R2 (off-token color) — 2× `IGNORE`.** The modal/sheet scrim is hard-coded
   `bg-black/40` in `src/components/ui/dialog.tsx:16` and `src/components/ui/sheet.tsx:20`.
   There is no overlay/dim token, so the gate suppresses these via two permanent `IGNORE`
   entries. The IGNORE comment itself flags tokenization as the correct P3 move.
2. **R1 (status emoji) — 1× ratchet baseline.** `src/components/RetroView.tsx:189` has a
   decorative `⚠️` inside a `title="하지말걸 ⚠️"` tooltip string. The button already renders
   a lucide `ThumbsDown` icon and toggles an `.on` state class, so the emoji conveys
   nothing the UI doesn't already show. It squats `design-gate-baseline.json` and — unlike
   the R3 typography debt — will never self-clear.

These are "would-be-clean-if-the-primitive-existed" exceptions. This slice mints the one
missing token, removes the one stale emoji, and deletes the corresponding gate exceptions,
with **zero visual change**.

Out of scope: the R3 arbitrary-typography baseline (52 entries) — that is P3 Slice C and
gets its own brainstorm because of `typo-*` cascade-safety + orphan-token decisions.

## Goals / Non-goals

- **Goal:** retire 2× R2 IGNORE + 1× R1 baseline entry by fixing root causes, not by widening suppression.
- **Goal:** zero visual change in light and dark mode (verified by computed value, not eyeball alone).
- **Goal:** keep the gate green and the baseline minimal (52 R3-only entries afterward).
- **Non-goal:** any R3 typography adoption.
- **Non-goal:** restyling the scrim or RetroView; the swap must be value-identical.
- **Non-goal:** touching the sibling `⭐` in `RetroView.tsx:180` (not gate-flagged; minimal-change per AGENTS.md).

## Design

### Part 1 — Overlay scrim token

The scrim lives in shadcn primitives (`components/ui/dialog.tsx`, `sheet.tsx`), which
consume the unprefixed shadcn token layer (`--background`, `--border`, …). The overlay is a
shadcn-primitive surface concern, so it joins that layer (not the `--color-wr-*` `@theme`
namespace), exactly mirroring every other token those primitives use.

`src/styles/tokens.css`:

- `:root` block: add `--overlay: rgb(0 0 0 / 0.4);`
  - Alpha is baked into the token, so the value equals today's `bg-black/40` exactly.
  - **No `.dark` override.** Dark currently renders `bg-black/40` too, so omitting a dark
    value keeps the rendered scrim identical (zero visual change). The token merely _enables_
    a future dark-specific scrim by adding one `.dark { --overlay: … }` line later.
- `@theme inline` block: add `--color-overlay: var(--overlay);`
  - This is what registers the Tailwind v4 utility `bg-overlay` (same mechanism as
    `--color-background → bg-background`, already proven in this file).

`src/components/ui/dialog.tsx:16` and `src/components/ui/sheet.tsx:20`:

- `bg-black/40` → `bg-overlay`. No opacity modifier — alpha is in the token.
- Computed `background-color` is `rgb(0 0 0 / 0.4)` in both before and after.
- The adjacent `wr-dialog-overlay fixed inset-0 z-50` classes are unchanged.
  `.wr-dialog-overlay` (in `motion.css`) only carries open-state animation, no background,
  so the swap is a clean 1:1.

`scripts/check-design-tokens.mjs`:

- Delete both R2 `IGNORE` entries (dialog.tsx, sheet.tsx) and their explanatory comment.
- After tokenization there is no current R2 violation at those sites, so the gate stays green.
- **Testability refactor (required, not optional):** the existing unit test
  `"token-scoped IGNORE suppresses the scrim token…"` (test line ~122) depends on the
  production `IGNORE` containing the dialog.tsx scrim entry. Emptying `IGNORE` would break
  that test and leave the IGNORE _mechanism_ (still live, for future permanent exceptions)
  untested. Fix by dependency injection: thread the IGNORE list as a parameter through
  `isIgnored` / `pushMatches` / `collectViolations` (default = module `IGNORE`), so the test
  injects a _synthetic_ IGNORE entry to cover the suppression mechanism, decoupled from
  production contents. Production `IGNORE` becomes `[]` but the mechanism stays covered.
  This keeps the change behavior-preserving for the CLI (default param = today's behavior).

`DESIGN.md`:

- Add one row documenting `--overlay` / `bg-overlay` (semantic: modal/sheet scrim dim,
  `rgb(0 0 0 / 0.4)`). Keeps the gate's implicit "every token is documented" contract that
  P2 established. Placed alongside the existing overlay-adjacent shadow rows (`--wr-shadow-overlay`).

### Part 2 — RetroView emoji removal

`src/components/RetroView.tsx:189`:

- `title="하지말걸 ⚠️"` → `title="하지말걸"`. The lucide `ThumbsDown` icon + `.on` class
  already carry the meaning; the tooltip text is self-sufficient.

`scripts/design-gate-baseline.json`:

- Regenerate via `node scripts/check-design-tokens.mjs --update-baseline`.
- The `R1|src/components/RetroView.tsx|⚠` fingerprint becomes stale once the emoji is gone;
  `evaluate()` fails on stale baseline entries, so the regenerate is mandatory, not optional.
- Result: 53 → 52 entries (all R3). Diff is the single R1 line removed.

## Data flow / interfaces

No runtime data flow change. No Rust, no IPC, no `src/bindings.ts`. CSS-token + one JSX
attribute + two tool-layer files (gate script, baseline) + one doc.

## Error handling

N/A — no new control flow. The only failure surface is the gate itself, which is exercised
by verification below.

## Testing / verification

Must all be observed (checkbox = evidence):

1. `node scripts/check-design-tokens.mjs` → `design-tokens: ok` (exit 0).
2. `node --test scripts/check-design-tokens.test.mjs` → all pass. The line-~122 test is
   reworked to inject a synthetic IGNORE (covering the mechanism without the removed
   production entries); all other tests unchanged.
3. `grep -rn "bg-black/40" src` → no matches (scrim fully tokenized).
4. `grep -n "⚠" src/components/RetroView.tsx` → no matches.
5. `pnpm typecheck` → 0 errors.
6. `pnpm lint` → 0 errors (2 pre-existing react-hooks warnings are baseline, unrelated).
7. `pnpm vitest run` → all pass (no regressions; expect prior count).
8. `pnpm build` → succeeds.
9. Visual: dialog + sheet scrim renders `rgb(0 0 0 / 0.4)` in light and dark (computed-style
   check; native WKWebView eyeball deferred to user/cmux if needed, but computed value is the
   gating evidence since the swap is value-identical).

Cargo is NOT needed — Rust is untouched.

## Risks / rollback

- **Risk:** `bg-overlay` utility doesn't generate. _Mitigation:_ identical mechanism to the
  ~20 existing `--color-* → bg-*` mappings in the same file; verified by `pnpm build` + the
  rendered scrim. _Rollback:_ revert the 2 component lines to `bg-black/40` and re-add IGNORE.
- **Risk:** stale-baseline gate failure if `--update-baseline` is skipped. _Mitigation:_
  step 1 of verification catches it immediately.
- **Confirmed dependency (not a risk):** the line-~122 test depends on the removed R2 IGNORE
  entries. Handled by the testability refactor above (inject synthetic IGNORE). Expected
  work, not scope creep.
- Rollback is a single `git revert` — no migration, no data, no external effect.

## Sequencing within the branch

One commit (or two: token+component+gate as one, RetroView+baseline as one) on
`feat/typography-tokens`, after manual gate-pass. `--no-verify` acceptable once gates pass
manually (run `pnpm exec prettier --write` on touched FE files first). Push only on explicit
user request. Slice C (R3) follows as a separate brainstorm + spec + cycle.
