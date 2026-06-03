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
