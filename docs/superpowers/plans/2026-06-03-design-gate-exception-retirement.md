# Design Gate-Exception Retirement (P3 Slice AB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire 3 design-gate exceptions (2× R2 scrim IGNORE + 1× R1 RetroView emoji) by minting the one missing token and stripping one decorative emoji, with zero visual change.

**Architecture:** Add an `--overlay` scrim token to the shadcn token layer in `tokens.css` and route `dialog.tsx`/`sheet.tsx` scrims through the generated `bg-overlay` utility; make the gate's `IGNORE` list injectable so its mechanism stays unit-tested after the production entries are deleted; strip the gate-flagged `⚠️` from the RetroView tooltip and regenerate the ratchet baseline.

**Tech Stack:** Tailwind v4 `@theme`/`@theme inline` tokens, React/TSX (shadcn primitives), Node `node:test` for the gate's pure-function tests.

**Spec:** `docs/superpowers/specs/2026-06-03-design-gate-exception-retirement-design.md`

**Branch:** `feat/typography-tokens` (worktree dir name is `skills-mgr-migration` — branch ≠ dir).

**Conventions for this branch (from prior sessions):**

- Commit with `export PATH="$HOME/.cargo/bin:$PATH"` available, OR `--no-verify` after manually passing gates (run `pnpm exec prettier --write <touched FE files>` first).
- Cargo is NOT needed here (Rust untouched).
- Do NOT push. Push only on explicit user request.
- All commands run from the worktree root.

---

### Task 1: Overlay scrim token + route scrims through it

**Files:**

- Modify: `src/styles/tokens.css` (`:root` block ~line 181, `@theme inline` block ~line 267)
- Modify: `src/components/ui/dialog.tsx:16`
- Modify: `src/components/ui/sheet.tsx:20`

This task is CSS + className config — there is no unit-test harness for compiled Tailwind output, so the evidence is `pnpm build` + the gate + grep + computed value.

- [ ] **Step 1: Add the raw token to `:root`**

In `src/styles/tokens.css`, inside the `:root { … }` block (the shadcn token layer that already defines `--background`, `--border`, …), add after the `--success: #003c33;` line:

```css
--overlay: rgb(0 0 0 / 0.4); /* 모달/시트 스크림 dim — 기존 bg-black/40과 값 동일 */
```

Do NOT add an `--overlay` override to the `.dark { … }` block. Dark currently renders `bg-black/40` too, so omitting it keeps the rendered scrim identical. (A future dark-specific scrim is one `.dark { --overlay: … }` line away.)

- [ ] **Step 2: Expose the utility via `@theme inline`**

In the `@theme inline { … }` block (where `--color-background: var(--background)` etc. live), add after `--color-success: var(--success);`:

```css
--color-overlay: var(--overlay);
```

This registers the `bg-overlay` utility (same mechanism as every other `--color-* → bg-*` mapping in this block).

- [ ] **Step 3: Route `dialog.tsx` scrim through the token**

In `src/components/ui/dialog.tsx`, line 16, change the className:

```tsx
      className={cn("wr-dialog-overlay fixed inset-0 z-50 bg-overlay", className)}
```

(Was `… z-50 bg-black/40`. No opacity modifier — the alpha is baked into the token.)

- [ ] **Step 4: Route `sheet.tsx` scrim through the token**

In `src/components/ui/sheet.tsx`, line 20, change the className the same way:

```tsx
      className={cn("wr-dialog-overlay fixed inset-0 z-50 bg-overlay", className)}
```

- [ ] **Step 5: Verify no raw scrim remains + build compiles the utility**

Run:

```bash
grep -rn "bg-black/40" src
```

Expected: no matches.

Run:

```bash
pnpm build
```

Expected: build succeeds (this proves `bg-overlay` is a real generated utility — an unknown utility would not break the build, so ALSO confirm the class resolves: the next step's gate + a computed-style check are the real proof).

- [ ] **Step 6: Verify the gate is still green**

Run:

```bash
node scripts/check-design-tokens.mjs
```

Expected: `design-tokens: ok` (exit 0). The two production IGNORE entries still exist but now match nothing — harmless; they are removed in Task 2.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write src/components/ui/dialog.tsx src/components/ui/sheet.tsx src/styles/tokens.css
git add src/styles/tokens.css src/components/ui/dialog.tsx src/components/ui/sheet.tsx
git commit --no-verify -m "$(cat <<'EOF'
feat(design): add --overlay scrim token, route dialog/sheet scrims through bg-overlay

rgb(0 0 0 / 0.4) baked into the token = value-identical to the prior bg-black/40
(zero visual change, light + dark). Enables a future dark-specific scrim via a
single .dark override. Removes the last raw scrim color in components/ui.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Make `IGNORE` injectable, delete the dead scrim exceptions

**Files:**

- Modify: `scripts/check-design-tokens.mjs` (`isIgnored` ~line 31, `pushMatches` ~line 55, `collectViolations` ~line 64, `IGNORE` array ~line 24)
- Modify: `scripts/check-design-tokens.test.mjs` (the line-~122 test)

TDD: the test rewrite drives the signature change.

- [ ] **Step 1: Rewrite the line-~122 test to inject a synthetic IGNORE**

In `scripts/check-design-tokens.test.mjs`, replace the entire `"token-scoped IGNORE suppresses the scrim token but not other colors in same file"` test (lines ~122–131) with:

```js
test("token-scoped IGNORE (injected) suppresses one token but not other colors in same file", async () => {
  // IGNORE 메커니즘은 합성 항목 주입으로 검증 — 프로덕션 IGNORE 내용과 분리.
  const root = await makeFixture({
    "src/components/ui/dialog.tsx":
      'export const D = () => <div className="bg-black/40 text-white">x</div>;\n',
  });
  const ignore = [{ rule: "R2", pathIncludes: "components/ui/dialog.tsx", token: "bg-black" }];
  assert.deepEqual(rules(collectViolations(root, ignore).filter((x) => x.rule === "R2")), [
    "R2:text-white",
  ]);
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run:

```bash
node --test scripts/check-design-tokens.test.mjs
```

Expected: FAIL on the injected-IGNORE test — `collectViolations` currently ignores the 2nd argument, so `bg-black` is NOT suppressed and the assertion sees `["R2:bg-black", "R2:text-white"]` instead of `["R2:text-white"]`.

- [ ] **Step 3: Thread the `ignore` parameter through the gate**

In `scripts/check-design-tokens.mjs`:

(a) `isIgnored` — add a defaulted `ignore` param:

```js
function isIgnored(rule, relFile, token, ignore = IGNORE) {
  return ignore.some(
    (e) =>
      e.rule === rule &&
      relFile.includes(e.pathIncludes) &&
      (e.token === undefined || e.token === token),
  );
}
```

(b) `pushMatches` — accept and forward `ignore`:

```js
function pushMatches(re, rule, line, relFile, ln, out, ignore) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line))) {
    if (isIgnored(rule, relFile, m[0], ignore)) continue;
    out.push({ rule, file: relFile, line: ln, token: m[0], snippet: line.trim() });
  }
}
```

(c) `collectViolations` — add a defaulted `ignore` param and pass it to the R1 check + all three `pushMatches` calls:

```js
export function collectViolations(root, ignore = IGNORE) {
  const out = [];
  for (const r of ROOTS) {
    let files;
    try {
      files = walk(join(root, r));
    } catch {
      continue;
    }
    for (const file of files) {
      const relFile = relative(root, file).split(sep).join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ln = i + 1;
        if (isCommentLine(line.trim())) continue;
        for (const e of STATUS_EMOJI) {
          if (line.includes(e) && !isIgnored("R1", relFile, e, ignore)) {
            out.push({ rule: "R1", file: relFile, line: ln, token: e, snippet: line.trim() });
          }
        }
        pushMatches(RAW_COLOR_RE, "R2", line, relFile, ln, out, ignore);
        pushMatches(HEX_CLASS_RE, "R2", line, relFile, ln, out, ignore);
        pushMatches(ARB_TYPO_RE, "R3", line, relFile, ln, out, ignore);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run:

```bash
node --test scripts/check-design-tokens.test.mjs
```

Expected: all tests pass (injected-IGNORE test now suppresses `bg-black`).

- [ ] **Step 5: Delete the dead production IGNORE entries**

In `scripts/check-design-tokens.mjs`, replace the populated `IGNORE` array (and its scrim comment) with an empty list plus a forward-looking note:

```js
// 영구 예외(전환 부채 아님 — ratchet baseline이 아니라 여기에 둔다). 사유 필수.
// token 지정 시 그 토큰만 정밀 매칭(같은 파일의 미래 위반은 계속 잡힘).
// 현재 영구 예외 없음 — 스크림은 P3에서 --overlay 토큰으로 전환됨.
const IGNORE = [];
```

- [ ] **Step 6: Verify the gate + full test suite are green**

Run:

```bash
node scripts/check-design-tokens.mjs && node --test scripts/check-design-tokens.test.mjs
```

Expected: `design-tokens: ok` then all tests pass. (No R2 violation exists at the scrim sites because Task 1 tokenized them; the empty IGNORE changes nothing for current code.)

- [ ] **Step 7: Commit**

```bash
git add scripts/check-design-tokens.mjs scripts/check-design-tokens.test.mjs
git commit --no-verify -m "$(cat <<'EOF'
refactor(design-gate): inject IGNORE list, remove tokenized scrim exceptions

Thread an `ignore` param (default = module IGNORE) through collectViolations so
the suppression mechanism stays unit-tested via a synthetic entry. Production
IGNORE is now empty — the dialog/sheet scrim exceptions are retired by the
--overlay token (Task 1). CLI behavior unchanged (default param).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Strip the RetroView tooltip emoji, regenerate baseline

**Files:**

- Modify: `src/components/RetroView.tsx:189`
- Modify: `scripts/design-gate-baseline.json` (regenerated)

- [ ] **Step 1: Remove the `⚠️` from the tooltip string**

In `src/components/RetroView.tsx`, line 189, change:

```tsx
title = "하지말걸";
```

(Was `title="하지말걸 ⚠️"` — strip the trailing space + emoji. Leave the sibling `title="고임팩트 ⭐"` on line 180 untouched; it is not gate-flagged and minimal-change applies.)

- [ ] **Step 2: Verify the emoji is gone**

Run:

```bash
grep -n "⚠" src/components/RetroView.tsx
```

Expected: no matches.

- [ ] **Step 3: Confirm the gate now reports a stale baseline entry**

Run:

```bash
node scripts/check-design-tokens.mjs
```

Expected: FAIL with `stale baseline (1): … R1|src/components/RetroView.tsx|⚠`. This is expected — the baseline still lists the now-removed violation.

- [ ] **Step 4: Regenerate the baseline**

Run:

```bash
node scripts/check-design-tokens.mjs --update-baseline
```

Expected: `design-gate: baseline 53 → 52`.

Confirm the only diff is the removed R1 line:

```bash
git diff scripts/design-gate-baseline.json
```

Expected: a single removed line `"R1|src/components/RetroView.tsx|⚠",` (all 52 R3 entries unchanged). If anything else changed, STOP and investigate (it would mean code drifted).

- [ ] **Step 5: Verify the gate is green**

Run:

```bash
node scripts/check-design-tokens.mjs
```

Expected: `design-tokens: ok`.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write src/components/RetroView.tsx
git add src/components/RetroView.tsx scripts/design-gate-baseline.json
git commit --no-verify -m "$(cat <<'EOF'
fix(design-gate): strip decorative ⚠️ from RetroView tooltip, ratchet baseline 53→52

The regret button already renders a lucide ThumbsDown + .on state class; the
tooltip emoji conveyed nothing extra and squatted the R1 baseline (would never
self-clear). Tooltip text "하지말걸" is self-sufficient.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Document the `--overlay` token in DESIGN.md

**Files:**

- Modify: `DESIGN.md` (near the shadow/overlay table, ~line 229)

- [ ] **Step 1: Add a one-line token entry**

Open `DESIGN.md` and locate the elevation/shadow table that contains the `--wr-shadow-overlay` row (~line 229). Immediately AFTER that table (or in the nearest semantic-color/token table if that reads more naturally in context), add a short documented entry for the new token. Use this row text:

```markdown
| `--overlay` / `bg-overlay` | `rgb(0 0 0 / 0.4)` | 모달/시트 스크림 dim (dialog/sheet overlay). 다크 별도 오버라이드 시 `.dark { --overlay }` 추가. |
```

Match the surrounding table's exact column count/headers — if the adjacent table has a different shape, adapt the row to its columns (token | value | usage). The requirement is: `--overlay`/`bg-overlay`, its value `rgb(0 0 0 / 0.4)`, and the scrim usage note are all present.

- [ ] **Step 2: Verify DESIGN.md still passes its own checks (if any) + renders**

Run:

```bash
node scripts/check-design-tokens.mjs
```

Expected: `design-tokens: ok` (DESIGN.md is markdown, not under `src/`, so the gate does not scan it — this just confirms nothing regressed).

Visually confirm the new row sits in a well-formed table (no broken pipes) by reading the edited region.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write DESIGN.md
git add DESIGN.md
git commit --no-verify -m "$(cat <<'EOF'
docs(design): document --overlay / bg-overlay scrim token

Keeps the gate's "every token is documented" contract (P2). rgb(0 0 0 / 0.4),
used by dialog/sheet overlays.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Final verification (all gates, after Task 4)

Run the full suite and record observed output (checkbox = evidence):

- [ ] `node scripts/check-design-tokens.mjs` → `design-tokens: ok`
- [ ] `node --test scripts/check-design-tokens.test.mjs` → all pass
- [ ] `grep -rn "bg-black/40" src` → no matches
- [ ] `grep -n "⚠" src/components/RetroView.tsx` → no matches
- [ ] `pnpm typecheck` → 0 errors
- [ ] `pnpm lint` → 0 errors (2 pre-existing react-hooks warnings are baseline)
- [ ] `pnpm vitest run` → all pass (expect the prior count, no regressions)
- [ ] `pnpm build` → succeeds
- [ ] `git diff --stat origin/dev..HEAD -- src-tauri/ src/bindings.ts` → empty (no Rust/IPC/bindings change)
- [ ] Computed-style check (optional eyeball via dev/cmux): dialog + sheet scrim renders `rgb(0 0 0 / 0.4)` in light and dark.

### Review gate

- [ ] Independent verify pass (separate context) confirms all gates observed.
- [ ] critic (opus, separate pass) ACCEPT, 0 blockers — per AGENTS.md no self-approve.
- [ ] Do NOT push. Report completion; push only on explicit user request.
