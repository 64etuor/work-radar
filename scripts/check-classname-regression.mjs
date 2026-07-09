#!/usr/bin/env node
// className 회귀 가드 — Prettier(tailwindcss plugin)가 템플릿 리터럴 안 조건부 클래스의
// leading space를 삭제하는 회귀(3393e6d 사고)를 다시 감지하면 실패한다.
//
// 깨진 패턴 예:
//   `area-radial-core${active ? "active" : ""}`            // "active"가 앞 클래스에 붙는다
//   `wt-rebase-msg${ok ? "wt-rebase-ok" : "wt-rebase-err"}` // 양쪽 다 붙는다
//   `wt-cleanup-row${can ? "" : "wt-cleanup-locked"}`       // false 분기가 붙는다
//
// ⚠️ 분기 문자열 앞에 공백을 넣는 수정(`${active ? " active" : ""}`)은 **되돌려진다** —
// prettier-plugin-tailwindcss가 이 레포 설정에서 quasi 안 분기 문자열의 leading space를
// 지운다(실측). 3393e6d 사고의 실제 정체가 이것이다. 지속 가능한 수정은 둘 중 하나:
//   ① 공백을 템플릿 리터럴 쪽에 둔다: `wt-cleanup-row ${can ? "" : "wt-cleanup-locked"}`
//   ② `cn()`을 쓴다(권장): cn("wt-cleanup-row", !can && "wt-cleanup-locked")
//
// 패턴은 의도적으로 좁다 — 앞 문자가 `}`/영숫자/하이픈일 때만 의심한다. 즉 위 ①처럼
// `${` 앞에 공백이 있으면 잡지 않는다(레포의 나머지 사이트는 전부 이 형태).
//
// 2026-07-09: 종전 정규식은 삼항의 **true 분기만** 검사해서, true가 빈 문자열이면
// false 분기를 통과시켰다(`wt-cleanup-row${can ? "" : "wt-cleanup-locked"}` →
// `wt-cleanup-rowwt-cleanup-locked` 단일 토큰 = 두 클래스 모두 소실). 이제 양쪽을 검사한다.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = ["src"];
const EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);
const SKIP = new Set(["node_modules", "dist", "build", "target", ".next"]);

// 직전이 닫는 `}` 또는 영숫자/하이픈인 `${…}` — 그 자리에 들어오는 문자열은 앞 클래스에 붙는다.
// lookbehind를 쓴다(선행 문자를 소비하면 `}${a}${b}` 같은 인접 보간의 둘째를 놓친다).
const INTERP = /(?<=[}\w-])\$\{([^}]+)\}/g;
// 그 안의 삼항 — 양쪽 분기 문자열을 모두 캡처한다(비문자열 분기는 undefined).
const TERNARY = /\?\s*(?:"([^"]*)")?\s*:\s*(?:"([^"]*)")?/g;

/** check-design-tokens.mjs와 동일 — 주석에 적어둔 안티패턴 예시로 커밋이 막히지 않도록. */
function isCommentLine(trimmed) {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/**
 * 한 줄에서 "앞 클래스에 이어붙는" 조건부 토큰들을 찾는다.
 * 공백 없이 영문자로 시작하는 분기 문자열만 의심한다(빈 문자열·` x` 형태는 안전).
 *
 * 알려진 한계: 분기 안에 중괄호가 있으면(`${c ? f({a:1}) : "z"}`) `[^}]+`가 먼저 끊겨 검출하지
 * 못한다. 그런 복잡한 표현식은 `cn()`을 쓰는 게 하우스 스타일이라 의도적으로 넓히지 않았다.
 */
export function suspiciousTokens(line) {
  if (!line.includes("className=")) return [];
  if (isCommentLine(line.trim())) return [];
  const found = [];
  INTERP.lastIndex = 0;
  let interp;
  while ((interp = INTERP.exec(line))) {
    TERNARY.lastIndex = 0;
    let ternary;
    while ((ternary = TERNARY.exec(interp[1]))) {
      for (const branch of [ternary[1], ternary[2]]) {
        if (branch !== undefined && /^[A-Za-z]/.test(branch)) found.push(branch);
      }
    }
  }
  return found;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(p.slice(p.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

/** 레포를 훑어 의심 사이트를 모은다(테스트에서 fixture root로 호출 가능). */
export function collectOffenders(roots = ROOTS) {
  const offenders = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const token of suspiciousTokens(lines[i])) {
          offenders.push({ file, line: i + 1, snippet: lines[i].trim(), token });
        }
      }
    }
  }
  return offenders;
}

function main() {
  const offenders = collectOffenders();
  if (offenders.length === 0) {
    console.log("classname-regression: ok");
    return;
  }

  console.error(`classname-regression: ${offenders.length} suspicious site(s)`);
  console.error(
    '  template literal `…${cond ? "X" : "Y"}` — 분기 토큰이 앞 클래스에 그대로 이어붙는다(양쪽 분기 모두 대상).',
  );
  console.error(
    "  분기 문자열 앞에 공백을 넣지 마세요 — prettier-plugin-tailwindcss가 지웁니다(3393e6d 회귀의 정체).",
  );
  console.error(
    '  고치는 법: cn("x", cond && "y")  또는  `x ${cond ? "" : "y"}` (공백을 리터럴 쪽에).',
  );
  console.error("");
  for (const { file, line, token, snippet } of offenders) {
    console.error(`  ${file}:${line}  token="${token}"`);
    console.error(`    ${snippet}`);
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
