import { describe, expect, it } from "vitest";

import { defaultKeymap, NAV_BY_VIEW, NAV_ITEMS, navItemsByGroup } from "@/lib/nav";

describe("navItemsByGroup", () => {
  it("4개 그룹을 정해진 순서로 반환한다", () => {
    expect(navItemsByGroup().map((g) => g.group)).toEqual([
      "operate",
      "review",
      "code",
      "connect",
    ]);
  });

  it("모든 NAV_ITEMS를 누락·중복 없이 분배한다", () => {
    const flat = navItemsByGroup().flatMap((g) => g.items);
    expect(flat).toHaveLength(NAV_ITEMS.length);
    expect(new Set(flat.map((i) => i.view)).size).toBe(NAV_ITEMS.length);
  });
});

describe("NAV_BY_VIEW", () => {
  it("모든 view를 조회할 수 있다", () => {
    for (const item of NAV_ITEMS) {
      expect(NAV_BY_VIEW[item.view]?.view).toBe(item.view);
    }
  });
});

describe("defaultKeymap", () => {
  it("defaultShortcut이 있는 항목만 매핑한다", () => {
    const km = defaultKeymap();
    const withShortcut = NAV_ITEMS.filter((n) => n.defaultShortcut);
    expect(Object.keys(km)).toHaveLength(withShortcut.length);
    for (const n of withShortcut) expect(km[n.view]).toBe(n.defaultShortcut);
  });

  it("chord 단축키 형식을 보존한다 (board = 'g b')", () => {
    expect(defaultKeymap().board).toBe("g b");
  });
});
