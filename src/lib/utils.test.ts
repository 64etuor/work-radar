import { describe, expect, it } from "vitest";

import { cn, trimOrNull } from "@/lib/utils";

describe("cn", () => {
  it("클래스 이름을 합친다", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("falsy 값은 버린다", () => {
    // `false && "b"`는 실사용 패턴(cond && "class")을 모사한 의도적 falsy 입력.
    // eslint-disable-next-line no-constant-binary-expression
    expect(cn("a", false && "b", undefined, null, "c")).toBe("a c");
  });

  it("충돌하는 tailwind 클래스는 twMerge로 뒤가 이긴다", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});

describe("trimOrNull", () => {
  it("앞뒤 공백을 제거한다", () => {
    expect(trimOrNull("  hi  ")).toBe("hi");
  });

  it("빈/공백 문자열은 null (선택 필드 → Option)", () => {
    expect(trimOrNull("   ")).toBeNull();
    expect(trimOrNull("")).toBeNull();
  });
});

describe("cn — typo-* resolution via shared twMergeTypo", () => {
  it("typo-* wins over built-in type classes", () => {
    expect(cn("text-base leading-none font-semibold", "typo-title-md")).toBe("typo-title-md");
  });

  it("color + typo coexist", () => {
    expect(cn("text-muted-foreground", "typo-caption-sm")).toBe(
      "text-muted-foreground typo-caption-sm",
    );
  });
});
