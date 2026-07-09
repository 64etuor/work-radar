import { describe, expect, it } from "vitest";

import { WR_EASE, WR_MOTION } from "./motion";

// motion.ts는 tokens.css 값의 JS 미러(SSOT = tokens.css) — 드리프트를 이 테스트가 잡는다.
// design-token 게이트는 className만 스캔하므로 TS 상수 드리프트는 여기서만 검출된다.
// fs 접근은 src 테스트 관례(appMotion.test.ts 패턴)를 따른다 — 렌더러 tsconfig에 node 타입 없음.
declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};

const { readFileSync } = require("fs");
const { resolve } = require("path");
const css = readFileSync?.(resolve?.(__dirname, "../styles/tokens.css") ?? "", "utf8") ?? "";

function cssVar(name: string): string {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`tokens.css에 토큰 없음: ${name}`);
  return m[1].trim();
}

describe("WR_MOTION/WR_EASE ↔ tokens.css 패리티", () => {
  it("duration 토큰 일치", () => {
    for (const [key, seconds] of Object.entries(WR_MOTION)) {
      expect(cssVar(`--wr-motion-${key}`)).toBe(`${seconds}s`);
    }
  });

  it("easing cubic-bezier 좌표 일치", () => {
    for (const [key, pts] of Object.entries(WR_EASE)) {
      expect(cssVar(`--wr-ease-${key}`).replace(/\s+/g, "")).toBe(`cubic-bezier(${pts.join(",")})`);
    }
  });
});
