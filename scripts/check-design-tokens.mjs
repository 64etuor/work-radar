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
