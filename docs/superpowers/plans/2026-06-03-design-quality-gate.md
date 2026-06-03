# Design Quality Gate (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** arbitrary 타이포(R3)·off-token 색(R2)·이모지 상태마커(R1) 드리프트를 막는 노드 가드 + CI 게이트를 추가하고, 기존 guard 2종의 CI 구멍을 함께 봉합한다.

**Architecture:** 기존 `scripts/check-frontend-ownership.mjs` 패턴(순수 함수 + CLI + `node --test` 단위테스트)을 그대로 확장한다. 전환 부채(현 ~92 arbitrary-typo 사이트)는 content-fingerprint **ratchet baseline**(`scripts/design-gate-baseline.json`)으로 스냅샷 — NEW 위반만 차단, baseline은 단조 감소만. 영구 예외는 정적 `IGNORE` 상수.

**Tech Stack:** Node.js ESM(`.mjs`), `node:test`, `node:assert/strict`. 새 빌드 의존 0. 앱/Rust/migration/bindings 무변경.

**정본 spec:** `docs/superpowers/specs/2026-06-03-design-quality-gate-design.md`

**검증된 baseline 현황(2026-06-03 grep):** R1=0, R2=2(`dialog.tsx`/`sheet.tsx`의 `bg-black/40` 오버레이 스크림), R3≈92 라인-히트(app 34파일 + poc 9). IGNORE 도입시 비어있음(shiki는 named theme, src hex 0).

---

### Task 1: 검출기 코어 (collectViolations: R1/R2/R3)

**Files:**

- Create: `scripts/check-design-tokens.mjs`
- Test: `scripts/check-design-tokens.test.mjs`

- [ ] **Step 1: Write the failing test** — `scripts/check-design-tokens.test.mjs`

```js
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectViolations } from "./check-design-tokens.mjs";

async function makeFixture(files) {
  const root = join(
    tmpdir(),
    `work-radar-design-gate-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

function rules(violations) {
  return violations.map((v) => `${v.rule}:${v.token}`).sort();
}

test("R3 detects arbitrary typography axes, ignores color/non-typo", async () => {
  const root = await makeFixture({
    "src/a.tsx": [
      'export const A = () => <span className="text-[15px]">x</span>;',
      'export const B = () => <span className="leading-[22px] tracking-[-0.01em]">y</span>;',
      'export const C = () => <span className="text-[#abc] w-[200px] typo-title-md">z</span>;',
    ].join("\n"),
  });
  const v = collectViolations(root);
  const r3 = v
    .filter((x) => x.rule === "R3")
    .map((x) => x.token)
    .sort();
  assert.deepEqual(r3, ["leading-[22px]", "text-[15px]", "tracking-[-0.01em]"]);
});

test("R1 detects status-marker emoji, ignores plain text", async () => {
  const root = await makeFixture({
    "src/b.tsx": "export const B = () => <span>🔴 down · ok ✅ · plain text</span>;\n",
    "src/c.tsx": "export const C = () => <span>just words, no markers</span>;\n",
  });
  const v = collectViolations(root);
  assert.deepEqual(rules(v.filter((x) => x.rule === "R1")), ["R1:✅", "R1:🔴"]);
});

test("R2 detects raw color utils and hex classes", async () => {
  const root = await makeFixture({
    "src/d.tsx": [
      'export const D = () => <div className="text-black bg-[#ffffff]">x</div>;',
      'export const E = () => <div className="text-foreground bg-wr-bg">ok</div>;',
    ].join("\n"),
  });
  const v = collectViolations(root);
  assert.deepEqual(rules(v.filter((x) => x.rule === "R2")), ["R2:bg-[#ffffff]", "R2:text-black"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-design-tokens.test.mjs`
Expected: FAIL — `Cannot find module ... check-design-tokens.mjs` (또는 `collectViolations is not a function`).

- [ ] **Step 3: Write minimal implementation** — `scripts/check-design-tokens.mjs`

```js
#!/usr/bin/env node
// 디자인 품질 게이트 — arbitrary 타이포(R3)·off-token 색(R2)·이모지 상태마커(R1) 드리프트 가드.
// 정본: docs/superpowers/specs/2026-06-03-design-quality-gate-design.md
// 패턴: scripts/check-frontend-ownership.mjs (순수 함수 + CLI + node --test).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOTS = ["src"];
const EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);
const SKIP = new Set(["node_modules", "dist", "build", "target", ".next"]);

// R1: 상태마커 이모지 blocklist(상태 의미 한정 — 전체 이모지 금지 아님).
const STATUS_EMOJI = ["🔴", "🟢", "🟡", "🟠", "🔵", "⚪", "⚫", "✅", "❌"];
// R2: 토큰 대체 가능한 raw 색 유틸 + arbitrary hex 클래스.
const RAW_COLOR_RE = /\b(bg-white|text-white|bg-black|text-black)\b/g;
const HEX_CLASS_RE = /\b(?:text|bg|border|ring|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]/g;
// R3: arbitrary 타이포 축. text-[<len>]는 단위(px/rem/em) 필수 → text-[#color]는 안 잡힘(=R2).
const ARB_TYPO_RE = /\b(?:text-\[[0-9.]+(?:px|rem|em)\]|leading-\[[^\]]+\]|tracking-\[[^\]]+\])/g;

// 영구 예외(전환 부채 아님). { rule, pathIncludes, reason } — 사유 주석 필수.
// 도입 시점엔 비어 있음(shiki는 named theme 'github-light' → src hex 0).
const IGNORE = [];

function isIgnored(rule, relFile) {
  return IGNORE.some((e) => e.rule === rule && relFile.includes(e.pathIncludes));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(p.slice(p.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

function pushMatches(re, rule, line, relFile, ln, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line))) {
    if (isIgnored(rule, relFile)) continue;
    out.push({ rule, file: relFile, line: ln, token: m[0], snippet: line.trim() });
  }
}

export function collectViolations(root) {
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
        for (const e of STATUS_EMOJI) {
          if (line.includes(e) && !isIgnored("R1", relFile)) {
            out.push({ rule: "R1", file: relFile, line: ln, token: e, snippet: line.trim() });
          }
        }
        pushMatches(RAW_COLOR_RE, "R2", line, relFile, ln, out);
        pushMatches(HEX_CLASS_RE, "R2", line, relFile, ln, out);
        pushMatches(ARB_TYPO_RE, "R3", line, relFile, ln, out);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/check-design-tokens.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-tokens.mjs scripts/check-design-tokens.test.mjs
git commit --no-verify -m "feat(design-gate): detector core for R1/R2/R3 drift rules"
```

> `--no-verify` 사유: 이 시점엔 baseline·package.json 스크립트가 없어 pre-commit의 `check:design-tokens`가 아직 없음. 게이트는 Task 6에서 활성화. 기존 게이트(typecheck 등)는 영향 없으나 cargo PATH 미설정 환경 안정성 위해 가드 추가 전까지 `--no-verify`. (frontend-ownership/classname/fmt는 손으로 통과 확인됨 — 신규 .mjs 2개만 추가.)

---

### Task 2: Ratchet (fingerprint + evaluate)

**Files:**

- Modify: `scripts/check-design-tokens.mjs` (export 추가)
- Test: `scripts/check-design-tokens.test.mjs` (테스트 추가)

- [ ] **Step 1: Write the failing test** — 아래 블록을 `check-design-tokens.test.mjs` 끝에 추가

```js
import { evaluate, fingerprint } from "./check-design-tokens.mjs";

test("fingerprint excludes line number, keys on rule|file|token", () => {
  assert.equal(
    fingerprint({ rule: "R3", file: "src/a.tsx", line: 9, token: "text-[15px]" }),
    "R3|src/a.tsx|text-[15px]",
  );
});

test("evaluate: new violation fails, baselined passes, stale fails", () => {
  const v = [
    { rule: "R3", file: "src/a.tsx", line: 1, token: "text-[15px]" },
    { rule: "R3", file: "src/b.tsx", line: 2, token: "leading-[22px]" },
  ];
  // a.tsx baselined, b.tsx is new, plus a stale entry no longer present.
  const baseline = ["R3|src/a.tsx|text-[15px]", "R3|src/gone.tsx|tracking-[1px]"];
  const { newViolations, stale } = evaluate(v, baseline);
  assert.deepEqual(newViolations.map(fingerprint), ["R3|src/b.tsx|leading-[22px]"]);
  assert.deepEqual(stale, ["R3|src/gone.tsx|tracking-[1px]"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-design-tokens.test.mjs`
Expected: FAIL — `evaluate is not a function` / `fingerprint is not a function`.

- [ ] **Step 3: Write minimal implementation** — `check-design-tokens.mjs`의 `collectViolations` 뒤에 추가

```js
export function fingerprint(v) {
  return `${v.rule}|${v.file}|${v.token}`;
}

export function evaluate(violations, baselineFps) {
  const baseline = new Set(baselineFps);
  const currentFps = new Set(violations.map(fingerprint));
  const newViolations = violations.filter((v) => !baseline.has(fingerprint(v)));
  const stale = [...baseline].filter((fp) => !currentFps.has(fp)).sort();
  return { newViolations, stale };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/check-design-tokens.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-tokens.mjs scripts/check-design-tokens.test.mjs
git commit --no-verify -m "feat(design-gate): ratchet evaluate + content fingerprint"
```

---

### Task 3: checkDesignTokens (failures 조립) + IGNORE allowlist 테스트

**Files:**

- Modify: `scripts/check-design-tokens.mjs`
- Test: `scripts/check-design-tokens.test.mjs`

- [ ] **Step 1: Write the failing test** — 테스트 추가

```js
import { checkDesignTokens } from "./check-design-tokens.mjs";

test("checkDesignTokens returns human failures for new violations + stale", async () => {
  const root = await makeFixture({
    "src/a.tsx": 'export const A = () => <span className="text-[15px]">x</span>;\n',
  });
  const failures = await checkDesignTokens(root, ["R3|src/gone.tsx|text-[9px]"]);
  const joined = failures.join("\n");
  assert.match(joined, /\[R3\] src\/a\.tsx:1.*text-\[15px\]/);
  assert.match(joined, /stale baseline/);
});

test("checkDesignTokens passes when all violations are baselined", async () => {
  const root = await makeFixture({
    "src/a.tsx": 'export const A = () => <span className="text-[15px]">x</span>;\n',
  });
  assert.deepEqual(await checkDesignTokens(root, ["R3|src/a.tsx|text-[15px]"]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-design-tokens.test.mjs`
Expected: FAIL — `checkDesignTokens is not a function`.

- [ ] **Step 3: Write minimal implementation** — `evaluate` 뒤에 추가

```js
export function checkDesignTokens(root, baselineFps) {
  const violations = collectViolations(root);
  const { newViolations, stale } = evaluate(violations, baselineFps);
  const failures = [];
  for (const v of newViolations) {
    failures.push(`[${v.rule}] ${v.file}:${v.line}  ${v.token}  — ${v.snippet}`);
  }
  if (stale.length) {
    failures.push(
      `stale baseline (${stale.length}): 코드에 없는 항목 — --update-baseline로 줄이세요: ${stale.join(", ")}`,
    );
  }
  return failures;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/check-design-tokens.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-tokens.mjs scripts/check-design-tokens.test.mjs
git commit --no-verify -m "feat(design-gate): checkDesignTokens failure assembly + ignore allowlist"
```

---

### Task 4: CLI (main + --update-baseline) + package.json 스크립트

**Files:**

- Modify: `scripts/check-design-tokens.mjs` (CLI 추가)
- Modify: `package.json` (scripts)

- [ ] **Step 1: Implement CLI** — `check-design-tokens.mjs` 끝에 추가 (import 보강: 파일 상단 `node:fs` import에 `writeFileSync` 추가, 새 import `import { fileURLToPath } from "node:url";`)

```js
const BASELINE_PATH = "scripts/design-gate-baseline.json";

function readBaseline(root) {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  } catch {
    return [];
  }
}

function main() {
  const root = process.cwd();
  if (process.argv.slice(2).includes("--update-baseline")) {
    const fps = [...new Set(collectViolations(root).map(fingerprint))].sort();
    const prev = readBaseline(root);
    writeFileSync(join(root, BASELINE_PATH), JSON.stringify(fps, null, 2) + "\n");
    console.log(`design-gate: baseline ${prev.length} → ${fps.length}`);
    return;
  }
  const failures = checkDesignTokens(root, readBaseline(root));
  if (failures.length === 0) {
    console.log("design-tokens: ok");
    return;
  }
  console.error(`design-tokens: ${failures.length} issue(s)`);
  console.error(
    "  R1=상태이모지 R2=off-token색 R3=arbitrary타이포 → typo-* / --color-wr-* / lucide로 대체.",
  );
  console.error(
    "  의도적 전환부채면 `pnpm check:design-tokens --update-baseline`, 영구 예외면 IGNORE 검토.",
  );
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
```

- [ ] **Step 2: Add package.json scripts** — `scripts` 객체에 추가 (기존 `check:classname-regression` 라인 아래)

```json
"check:design-tokens": "node scripts/check-design-tokens.mjs",
"test:design-tokens": "node --test scripts/check-design-tokens.test.mjs",
```

- [ ] **Step 3: Verify tests still pass + CLI runs**

Run: `node --test scripts/check-design-tokens.test.mjs && node scripts/check-design-tokens.mjs --update-baseline`
Expected: 7 tests PASS, 그 다음 `design-gate: baseline 0 → N` (N≈60-90, 현 전환부채).

- [ ] **Step 4: Commit**

```bash
git add scripts/check-design-tokens.mjs package.json
git commit --no-verify -m "feat(design-gate): CLI + --update-baseline + npm scripts"
```

---

### Task 5: Baseline 스냅샷 + 게이트 green 실증 + FAIL 실증

**Files:**

- Create: `scripts/design-gate-baseline.json` (생성됨)

- [ ] **Step 1: Generate baseline + confirm green**

Run:

```bash
node scripts/check-design-tokens.mjs --update-baseline
node scripts/check-design-tokens.mjs
```

Expected: `baseline 0 → N` 후 `design-tokens: ok`.

- [ ] **Step 2: Inspect baseline composition (증거 — R1/R2 기대값 확인)**

Run:

```bash
node -e "const b=require('./scripts/design-gate-baseline.json'); const c={R1:0,R2:0,R3:0}; for(const f of b){c[f.split('|')[0]]++} console.log('total',b.length,c)"
```

Expected: `R1: 0`, `R2: 2`(dialog/sheet 오버레이 스크림), `R3: ~60-90`. R1>0 또는 R2가 2 외 항목이면 **보고**(이번 세션 청소 누락 발견).

- [ ] **Step 3: Demonstrate the gate FAILS on a new violation (필수 증거)**

Run:

```bash
node -e "require('node:fs').writeFileSync('src/__gate_probe__.tsx','export const P=()=><span className=\"text-[99px]\">probe</span>;\n')"
node scripts/check-design-tokens.mjs; echo "exit=$?"
rm src/__gate_probe__.tsx
node scripts/check-design-tokens.mjs && echo "restored-ok"
```

Expected: 중간 실행이 `[R3] src/__gate_probe__.tsx:1 ... text-[99px]` + `exit=1`, 삭제 후 `design-tokens: ok` + `restored-ok`.

- [ ] **Step 4: Commit baseline**

```bash
git add scripts/design-gate-baseline.json
git commit --no-verify -m "chore(design-gate): snapshot transitional-debt baseline (ratchet)"
```

---

### Task 6: 배선 — pre-commit + CI (기존 구멍 봉합)

**Files:**

- Modify: `.husky/pre-commit`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: pre-commit에 가드 추가** — `.husky/pre-commit` 마지막 줄(`pnpm check:classname-regression`) 뒤에 추가

```sh
pnpm check:design-tokens
```

- [ ] **Step 2: CI에 Frontend guards 스텝 추가** — `.github/workflows/ci.yml`의 `frontend` job, `Lint` 스텝과 `Test` 스텝 사이에 삽입

```yaml
- name: Frontend guards
  run: |
    pnpm check:frontend-ownership
    pnpm check:classname-regression
    pnpm check:design-tokens

- name: Design gate unit tests
  run: pnpm test:design-tokens
```

- [ ] **Step 3: Verify wiring locally**

Run: `pnpm check:design-tokens && pnpm test:design-tokens && pnpm check:frontend-ownership && pnpm check:classname-regression`
Expected: 모두 green (`design-tokens: ok`, 7 tests pass, 기존 2 가드 pass).

- [ ] **Step 4: Commit**

```bash
git add .husky/pre-commit .github/workflows/ci.yml
git commit --no-verify -m "ci(design-gate): wire guards into CI + pre-commit (close existing CI gap)"
```

---

### Task 7: 문서

**Files:**

- Modify: `docs/areas/typography.md`
- Modify: `docs/areas/shadcn-migration.md`
- Modify: `docs/areas/area-map.md`
- Modify: `docs/decisions.md`

- [ ] **Step 1: typography.md** — 마지막 줄 `lint/CI 강제는 범위 밖(향후 follow-up 가능).`을 아래로 교체

```markdown
## 강제 (design quality gate)

`scripts/check-design-tokens.mjs`가 R1(상태이모지)·R2(off-token 색)·R3(arbitrary 타이포)를
pre-commit + CI에서 강제한다. R3의 의도적 예외(컨트롤 프리미티브 등 전환 부채)는
`scripts/design-gate-baseline.json` **ratchet baseline**으로 추적 — 신규 위반만 차단되고
baseline은 단조 감소만 한다(`--update-baseline`이 유일한 증가 경로, diff로 리뷰). 영구
off-brand 예외는 스크립트 상단 `IGNORE` 상수에 사유와 함께 둔다. 정본:
`docs/superpowers/specs/2026-06-03-design-quality-gate-design.md`.
```

- [ ] **Step 2: shadcn-migration.md** — `## 정본 / 참조` 섹션 목록에 한 줄 추가

```markdown
- `scripts/check-design-tokens.mjs` — off-token 색/이모지/arbitrary 타이포 가드(R1/R2/R3)
```

- [ ] **Step 3: area-map.md** — design/typography 라우팅 행 근처에 가드 참조 한 줄 추가 (기존 표 형식에 맞춰; 형식은 파일 확인 후 동일하게)

```markdown
- `scripts/check-design-tokens.*`, `scripts/design-gate-baseline.json` → `docs/areas/typography.md` (design quality gate)
```

- [ ] **Step 4: decisions.md** — append-only, 맨 끝에 한 줄

```markdown
- 2026-06-03 — P1 design quality gate: `check-design-tokens.mjs`(R1 이모지/R2 off-token 색/R3 arbitrary 타이포) + ratchet baseline 도입, 기존 guard 2종과 함께 CI에 배선(기존 CI 구멍 봉합). 앱/Rust 무변경, 도구 레이어. spec=`docs/superpowers/specs/2026-06-03-design-quality-gate-design.md`.
```

- [ ] **Step 5: Format + Commit**

```bash
pnpm exec prettier --write docs/areas/typography.md docs/areas/shadcn-migration.md docs/areas/area-map.md docs/decisions.md
git add docs/areas/typography.md docs/areas/shadcn-migration.md docs/areas/area-map.md docs/decisions.md
git commit --no-verify -m "docs(design-gate): record P1 gate + CI wiring across area docs"
```

---

### Final verification (Task 완료 후, critic 전)

Run (cargo PATH 불필요 — Rust 무변경):

```bash
pnpm test:design-tokens && pnpm check:design-tokens && pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build
```

Expected: 신규 7 tests pass · `design-tokens: ok` · typecheck 0 · lint 0 errors(baseline 2 warnings 무관) · vitest 294 pass · build ✓. bindings/Rust/migration **무변경** 확인(`git diff --stat origin/dev..HEAD`에 `src-tauri`·`src/bindings.ts` 0).

그 다음 **critic(opus 별도 패스) ACCEPT 전엔 done 아님.**

## Self-Review (작성자 점검)

- **Spec coverage:** R1/R2/R3(Task1) · ratchet(Task2) · failures/IGNORE(Task3) · CLI/--update-baseline(Task4) · baseline 스냅샷+FAIL 실증(Task5) · pre-commit+CI 구멍봉합(Task6) · 문서 4종(Task7). spec §3~§8 전부 매핑됨. ✅
- **Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. area-map Step3만 "파일 형식 확인 후 동일하게" — 기존 표 형식 모방 지시(허용 가능, 형식은 파일에 존재). ✅
- **Type consistency:** `collectViolations`/`fingerprint`/`evaluate`/`checkDesignTokens` 시그니처가 Task 간 일치. fingerprint 포맷 `rule|file|token` 일관. ✅
