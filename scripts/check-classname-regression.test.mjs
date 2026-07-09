import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectOffenders, suspiciousTokens } from "./check-classname-regression.mjs";

/** 템플릿 리터럴을 소스 "문자열"로 만든다(여기서 보간되면 안 되므로 조립한다). */
const src = (literalPrefix, expr) => `className={\`${literalPrefix}\${${expr}}\`}`;
/** `${…}` 하나를 표현식만으로 조립(연속 보간 케이스용). */
const interp = (expr) => `\${${expr}}`;

test("잡는다: true 분기가 공백 없이 시작", () => {
  // 스크립트 헤더의 예제 ①
  assert.deepEqual(suspiciousTokens(src("area-radial-core", 'active ? "active" : ""')), ["active"]);
});

test("잡는다: 양쪽 분기가 공백 없이 시작", () => {
  // 스크립트 헤더의 예제 ②
  assert.deepEqual(
    suspiciousTokens(src("wt-rebase-msg", 'ok ? "wt-rebase-ok" : "wt-rebase-err"')),
    ["wt-rebase-ok", "wt-rebase-err"],
  );
});

test("잡는다: true 분기가 빈 문자열이고 false 분기가 공백 없이 시작", () => {
  // 종전 정규식이 놓치던 구멍 — CleanupPanel의 `.wt-cleanup-locked` 소실 버그.
  // 결과 className이 `wt-cleanup-rowwt-cleanup-locked` 단일 토큰이 되어 두 클래스 모두 죽는다.
  assert.deepEqual(suspiciousTokens(src("wt-cleanup-row", 'can ? "" : "wt-cleanup-locked"')), [
    "wt-cleanup-locked",
  ]);
});

// 권장 수정안 ①: 공백을 템플릿 리터럴(quasi) 쪽에 둔다 → `${` 앞이 공백이라 이어붙지 않는다.
// (분기 문자열 안의 leading space는 prettier-plugin-tailwindcss가 지우므로 수정안이 못 된다.)
test("통과: 공백이 리터럴 쪽에 있으면 이어붙지 않는다", () => {
  assert.deepEqual(suspiciousTokens(src("wt-cleanup-row ", 'can ? "" : "wt-cleanup-locked"')), []);
  assert.deepEqual(
    suspiciousTokens(src("jobs-codex ", 'ready ? "jobs-codex-ok" : "jobs-codex-off"')),
    [],
  );
});

// 분기 안 leading space도 (지워지기 전까지는) 안전하므로 오탐하지 않는다.
test("통과: 분기 안 leading space는 오탐하지 않는다", () => {
  assert.deepEqual(suspiciousTokens(src("area-radial-core", 'active ? " active" : ""')), []);
});

test("통과: 비문자열 분기는 무시", () => {
  assert.deepEqual(suspiciousTokens(src("card", 'x ? undefined : " on"')), []);
});

test("통과: `${…}`가 클래스 시작 위치면 이어붙지 않는다", () => {
  // 선행 문자가 없으므로(백틱 직후) 앞 클래스에 붙을 수 없다.
  assert.deepEqual(suspiciousTokens(src("", 'ok ? "bg-x" : "bg-y"')), []);
});

test("통과: className이 없는 줄은 보지 않는다", () => {
  assert.deepEqual(suspiciousTokens('const s = `row${can ? "" : "locked"}`;'), []);
});

test("잡는다: 인접 보간의 둘째도 놓치지 않는다", () => {
  // 선행 문자를 소비하는 정규식이면 첫 보간이 `}`를 먹어 둘째가 매칭되지 않는다(lookbehind로 해결).
  const line = `className={\`a${interp('x ? "" : "b"')}${interp('y ? "" : "c"')}\`}`;
  assert.deepEqual(suspiciousTokens(line), ["b", "c"]);
});

test("통과: 주석 줄은 검사하지 않는다", () => {
  // 이 안티패턴을 주석으로 문서화하는 것만으로 커밋이 막히면 안 된다(형제 가드와 동일 규칙).
  assert.deepEqual(suspiciousTokens(`// ${src("bad", 'c ? "" : "x"')} 이렇게 쓰지 마세요`), []);
  assert.deepEqual(suspiciousTokens(` * ${src("bad", 'c ? "" : "x"')}`), []);
});

test("알려진 한계: 분기 안에 중괄호가 있으면 검출하지 못한다", () => {
  // `[^}]+`가 안쪽 `}`에서 끊긴다. 그런 표현식은 `cn()`을 쓰는 게 하우스 스타일이라 방치한다.
  // 동작이 바뀌면(=넓히면) 이 테스트가 실패하며 알려준다.
  assert.deepEqual(suspiciousTokens(src("row", 'c ? f({ a: 1 }) : "locked"')), []);
});

test("collectOffenders: fixture root를 훑어 위치/토큰을 보고한다", async () => {
  const root = join(tmpdir(), `wr-classname-guard-${process.pid}-${Date.now().toString(16)}`);
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(
    join(root, "nested", "Bad.tsx"),
    ["export const a = 1;", `const el = <b ${src("wt-row", 'can ? "" : "wt-locked"')} />;`].join(
      "\n",
    ),
  );
  await writeFile(
    join(root, "Good.tsx"),
    `const el = <b ${src("wt-row ", 'can ? "" : "wt-locked"')} />;`,
  );
  await writeFile(join(root, "ignored.css"), src("wt-row", 'can ? "" : "wt-locked"'));

  try {
    const offenders = collectOffenders([root]);
    assert.equal(offenders.length, 1);
    assert.equal(offenders[0].token, "wt-locked");
    assert.equal(offenders[0].line, 2);
    assert.match(offenders[0].file, /nested[/\\]Bad\.tsx$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
