import { describe, expect, it } from "vitest";

import { twMergeTypo, TYPO_SUFFIXES } from "./tw";

// fs 접근은 src 테스트 관례(motion.test.ts / appMotion.test.ts 패턴)를 따른다.
declare const __dirname: string;
declare const require: (moduleName: string) => {
  readFileSync?: (path: string, encoding: string) => string;
  resolve?: (...paths: string[]) => string;
};
const { readFileSync } = require("fs");
const { resolve } = require("path");
const typographyCss =
  readFileSync?.(resolve?.(__dirname, "../styles/typography.css") ?? "", "utf8") ?? "";

describe("twMergeTypo — typo-* conflict resolution", () => {
  it("typo-* strips built-in type classes that come before it", () => {
    expect(twMergeTypo("text-base leading-none font-semibold typo-title-md")).toBe("typo-title-md");
  });

  it("last-wins: a built-in type class after typo-* strips the typo-*", () => {
    expect(twMergeTypo("typo-title-md text-base")).toBe("text-base");
  });

  it("last-wins: typo-* after a built-in type class strips the built-in", () => {
    expect(twMergeTypo("text-base typo-title-md")).toBe("typo-title-md");
  });

  it("two typo roles collapse to the later one", () => {
    expect(twMergeTypo("typo-body-md typo-title-md")).toBe("typo-title-md");
  });

  it("color utilities are a different group and are preserved alongside typo-*", () => {
    expect(twMergeTypo("text-muted-foreground typo-caption-sm")).toBe(
      "text-muted-foreground typo-caption-sm",
    );
  });

  it("font-family: typo-mono-label strips an earlier font-family", () => {
    expect(twMergeTypo("font-sans typo-mono-label")).toBe("typo-mono-label");
  });

  it("non-type utilities are untouched", () => {
    expect(twMergeTypo("block mt-0.5 typo-body-strong")).toBe("block mt-0.5 typo-body-strong");
  });
});

// typography.css에 @utility를 추가하고 tw.ts를 잊으면 실패가 조용하다: cn()이 그 typo-*를
// 충돌 그룹으로 못 알아봐 병합하지 않고, 함께 온 빌트인(text-sm 등)이 cascade로 이긴다.
// 컴파일된 CSS를 눈으로 보기 전엔 안 보이므로 여기서 잠근다(tokens.css↔motion.ts 패리티와 동류).
describe("TYPO_SUFFIXES ↔ typography.css 패리티", () => {
  const declared = [...typographyCss.matchAll(/@utility typo-([a-z0-9-]+)\s*\{/g)].map((m) => m[1]);

  it("typography.css에서 실제로 롤을 읽어온다(가드가 vacuous하지 않도록)", () => {
    expect(declared.length).toBeGreaterThan(5);
  });

  it("선언된 모든 typo-* 롤이 TYPO_SUFFIXES에 등록돼 있다", () => {
    expect([...declared].sort()).toEqual([...TYPO_SUFFIXES].sort());
  });

  it("등록된 모든 롤이 cn() 병합에서 빌트인을 이긴다", () => {
    for (const suffix of TYPO_SUFFIXES) {
      expect(twMergeTypo(`text-base font-bold typo-${suffix}`)).toBe(`typo-${suffix}`);
    }
  });
});
