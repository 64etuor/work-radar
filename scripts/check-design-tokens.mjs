#!/usr/bin/env node
// 디자인 품질 게이트 — arbitrary 타이포(R3)·off-token 색(R2)·이모지 상태마커(R1) 드리프트 가드.
// 정본: docs/superpowers/specs/2026-06-03-design-quality-gate-design.md
// 패턴: scripts/check-frontend-ownership.mjs (순수 함수 + CLI + node --test).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = ["src"];
const EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);
const SKIP = new Set(["node_modules", "dist", "build", "target", ".next"]);

// R1: 상태마커 이모지 blocklist(상태 의미 한정 — 전체 이모지 금지 아님).
// "⚠"는 base codepoint(U+26A0)만 넣어도 VS16 형태(⚠️ = U+26A0 U+FE0F)를 substring으로 함께 잡는다.
const STATUS_EMOJI = ["🔴", "🟢", "🟡", "🟠", "🔵", "⚪", "⚫", "✅", "❌", "⚠"];
// R2: 토큰 대체 가능한 raw 색 유틸 + arbitrary hex 클래스.
const RAW_COLOR_RE = /\b(bg-white|text-white|bg-black|text-black)\b/g;
// arbitrary 값 내부 어디든 hex literal이 있으면 잡는다 — text-[#fff]뿐 아니라
// text-[color:var(--token,#hex)] 같은 폴백 임베딩도 대상(폴백이 토큰 실값과 어긋나는 사고 방지).
const HEX_CLASS_RE = /\b(?:text|bg|border|ring|fill|stroke)-\[[^\]]*#[0-9a-fA-F]{3,8}[^\]]*\]/g;
// R3: arbitrary 타이포 축. text-[<len>]는 단위(px/rem/em) 필수 → text-[#color]는 안 잡힘(=R2).
const ARB_TYPO_RE = /\b(?:text-\[[0-9.]+(?:px|rem|em)\]|leading-\[[^\]]+\]|tracking-\[[^\]]+\])/g;

// 영구 예외(전환 부채 아님 — ratchet baseline이 아니라 여기에 둔다). 사유 필수.
// token 지정 시 그 토큰만 정밀 매칭(같은 파일의 미래 위반은 계속 잡힘).
// 현재 영구 예외 없음 — 스크림은 P3에서 --overlay 토큰으로 전환됨.
const IGNORE = [];

function isIgnored(rule, relFile, token, ignore = IGNORE) {
  return ignore.some(
    (e) =>
      e.rule === rule &&
      relFile.includes(e.pathIncludes) &&
      (e.token === undefined || e.token === token),
  );
}

// 주석 줄은 렌더되는 UI가 아니므로 스캔 제외(생성된 bindings.ts 등의 doc-comment 이모지/색 false-positive 회피).
function isCommentLine(trimmed) {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
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

function pushMatches(re, rule, line, relFile, ln, out, ignore) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line))) {
    // url(#fragment) / url('…#id')의 # + hex-알파벳 fragment id는 색이 아니다 — R2 오탐 방지.
    if (rule === "R2" && m[0].includes("url(")) continue;
    if (isIgnored(rule, relFile, m[0], ignore)) continue;
    out.push({ rule, file: relFile, line: ln, token: m[0], snippet: line.trim() });
  }
}

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
