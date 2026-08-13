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

test("R2 catches hex embedded in var() fallback; token-only var() passes", async () => {
  const root = await makeFixture({
    "src/f.tsx": [
      'export const F = () => <span className="text-[color:var(--color-wr-accent,#2d6cdf)]">x</span>;',
      'export const G = () => <span className="text-[color:var(--color-wr-accent)]">ok</span>;',
    ].join("\n"),
  });
  const v = collectViolations(root);
  assert.deepEqual(rules(v.filter((x) => x.rule === "R2")), [
    "R2:text-[color:var(--color-wr-accent,#2d6cdf)]",
  ]);
});

test("R2 does not flag url(#fragment) ids that look like hex", async () => {
  const root = await makeFixture({
    "src/g.tsx": [
      'export const H = () => <svg className="fill-[url(#fade01)]" />;',
      "export const I = () => <div className=\"bg-[url('/sprite.svg" + "#abc123')]\">x</div>;",
    ].join("\n"),
  });
  assert.deepEqual(rules(collectViolations(root).filter((x) => x.rule === "R2")), []);
});

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

import { checkDesignTokens } from "./check-design-tokens.mjs";

test("checkDesignTokens returns human failures for new violations + stale", async () => {
  const root = await makeFixture({
    "src/a.tsx": 'export const A = () => <span className="text-[15px]">x</span>;\n',
  });
  const failures = checkDesignTokens(root, ["R3|src/gone.tsx|text-[9px]"]);
  const joined = failures.join("\n");
  assert.match(joined, /\[R3\] src\/a\.tsx:1.*text-\[15px\]/);
  assert.match(joined, /stale baseline/);
});

test("checkDesignTokens passes when all violations are baselined", async () => {
  const root = await makeFixture({
    "src/a.tsx": 'export const A = () => <span className="text-[15px]">x</span>;\n',
  });
  assert.deepEqual(checkDesignTokens(root, ["R3|src/a.tsx|text-[15px]"]), []);
});

test("R1 catches the warning emoji incl. the VS16 (⚠️) form", async () => {
  const root = await makeFixture({
    "src/w.tsx": 'export const W = () => <button title="하지말걸 ⚠️">x</button>;\n',
  });
  const v = collectViolations(root);
  assert.deepEqual(rules(v.filter((x) => x.rule === "R1")), ["R1:⚠"]);
});

test("comment lines are not scanned (generated doc-comment emoji/colors ignored)", async () => {
  const root = await makeFixture({
    "src/k.ts": [
      "/** 회고 태그 ⚠️ — text-black bg-[#fff] 라고 적힌 주석. */",
      "// also ⚠️ text-[15px] in a line comment",
      "export const K = 1;",
    ].join("\n"),
  });
  assert.deepEqual(collectViolations(root), []);
});

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
