#!/usr/bin/env node
// className 회귀 가드 — Prettier(tailwindcss plugin)가 템플릿 리터럴 안 조건부 클래스의
// leading space를 삭제하는 회귀(3393e6d 사고)를 다시 감지하면 실패한다.
//
// 깨진 패턴 예:
//   `area-radial-core${active ? "active" : ""}`            // "active" 앞 공백 누락
//   `wt-rebase-msg${ok ? "wt-rebase-ok" : "wt-rebase-err"}` // 양쪽 공백 누락
// 올바른 모양:
//   `area-radial-core${active ? " active" : ""}`
//   `wt-rebase-msg${ok ? " wt-rebase-ok" : " wt-rebase-err"}`
//
// 패턴은 의도적으로 좁다 — `bg-…`/`text-…` 같은 Tailwind 단일 토큰 분기는
// 보통 `${cond ? "bg-x" : "bg-y"}` 형태로 앞에 공백을 두고 사용하므로
// 그 경우는 잡지 않는다(앞 문자가 `}` 또는 영숫자일 때만 의심).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src"];
const EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);
const SKIP = new Set(["node_modules", "dist", "build", "target", ".next"]);

// `}${cond ? "Word..."` — 직전이 닫는 `}` 또는 영숫자/하이픈이면 클래스가 붙어버린다.
// 첫 인용부호 뒤 첫 글자가 [A-Za-z]면 의심(=공백 없이 시작).
const SUSPICIOUS = /[}\w-]\$\{[^}]+\?\s*"([A-Za-z][^"]*)"\s*:/g;

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

const offenders = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("className=")) continue;
      SUSPICIOUS.lastIndex = 0;
      let m;
      while ((m = SUSPICIOUS.exec(line))) {
        offenders.push({ file, line: i + 1, snippet: line.trim(), token: m[1] });
      }
    }
  }
}

if (offenders.length === 0) {
  console.log("classname-regression: ok");
  process.exit(0);
}

console.error(`classname-regression: ${offenders.length} suspicious site(s)`);
console.error(
  '  template literal `…${cond ? "X"…}` is missing a leading space before X — class will concatenate (e.g. `…active` 대신 `… active`).',
);
console.error(
  "  배경: 3393e6d Prettier 일괄 포맷 회귀(LifeWheelPalette 등). 조건부 토큰 앞에 공백을 두세요.",
);
console.error("");
for (const { file, line, token, snippet } of offenders) {
  console.error(`  ${file}:${line}  token="${token}"`);
  console.error(`    ${snippet}`);
}
process.exit(1);
