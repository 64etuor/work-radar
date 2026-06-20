#!/usr/bin/env node
// timeline-axis SSOT 가드 — HOUR_PX / DAY_PX / MIN_BLOCK_PX 상수가
// src/lib/timelineAxis.ts 외부에 재정의되는 것을 금지한다.
// 정본: docs/superpowers/specs/2026-06-20-today-timeline-coordinate-time-ssot-design.md §3.5 (H1).
// 패턴: scripts/check-design-tokens.mjs (walk + readFileSync).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SSOT = "src/lib/timelineAxis.ts";
const ROOTS = ["src"];
const EXTS = new Set([".ts", ".tsx"]);
const SKIP = new Set(["node_modules", "dist", "build", "target", ".next"]);
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

const BANNED = [/\bconst\s+HOUR_PX\s*=/, /\bconst\s+DAY_PX\s*=/, /\bconst\s+MIN_BLOCK_PX\s*=/];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(p.slice(p.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

function main() {
  const root = process.cwd();
  const offenders = [];

  for (const r of ROOTS) {
    let files;
    try {
      files = walk(join(root, r));
    } catch {
      continue;
    }
    for (const file of files) {
      const relFile = relative(root, file).split(sep).join("/");
      // Skip the SSOT itself and test files.
      if (relFile === SSOT) continue;
      if (TEST_SUFFIXES.some((s) => relFile.endsWith(s))) continue;

      const src = readFileSync(file, "utf8");
      for (const re of BANNED) {
        if (re.test(src)) {
          offenders.push(`${relFile}: violates ${re}`);
        }
      }
    }
  }

  if (offenders.length) {
    console.error("timeline-axis-ssot: pixel constants must live only in src/lib/timelineAxis.ts");
    for (const o of offenders) console.error("  " + o);
    process.exit(1);
  }
  console.log("timeline-axis-ssot: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
