import { describe, expect, it } from "vitest";

import {
  adjacentView,
  defaultKeymap,
  EXTRA_ACTIONS,
  KNOB_DIRECTIONS,
  KNOB_TRIGGER_DEFAULT,
  KNOB_TRIGGER_KEY,
  NAV_BY_VIEW,
  NAV_ITEMS,
  navItemsByGroup,
} from "@/lib/nav";

describe("navItemsByGroup", () => {
  it("4개 그룹을 정해진 순서로 반환한다", () => {
    expect(navItemsByGroup().map((g) => g.group)).toEqual(["operate", "review", "code", "connect"]);
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
  it("defaultShortcut이 있는 view와 extra action만 매핑한다", () => {
    const km = defaultKeymap();
    const withShortcut = NAV_ITEMS.filter((n) => n.defaultShortcut);
    const extraWithShortcut = EXTRA_ACTIONS.filter((a) => a.defaultShortcut);
    // knob 엔트리 5개(knob_left/right/up/down + knob_trigger)가 추가됨.
    const knobCount = KNOB_DIRECTIONS.length + 1; // 4방향 + 트리거
    expect(Object.keys(km)).toHaveLength(
      withShortcut.length + extraWithShortcut.length + knobCount,
    );
    for (const n of withShortcut) expect(km[n.view]).toBe(n.defaultShortcut);
    for (const a of extraWithShortcut) expect(km[a.key]).toBe(a.defaultShortcut);
    // defaultShortcut 없는 extra action(예: inbox 트레이)은 keymap 미할당 — 설정에서 바인딩.
    for (const a of EXTRA_ACTIONS.filter((a) => !a.defaultShortcut)) {
      expect(km[a.key]).toBeUndefined();
    }
  });

  it("조합 단축키 기본값을 보존한다 (board = 'Cmd+1')", () => {
    expect(defaultKeymap().board).toBe("Cmd+1");
  });
});

describe("adjacentView", () => {
  const first = NAV_ITEMS[0].view;
  const last = NAV_ITEMS[NAV_ITEMS.length - 1].view;

  it("다음(+1) 뷰는 NAV_ITEMS 순서를 따른다", () => {
    for (let i = 0; i < NAV_ITEMS.length - 1; i++) {
      expect(adjacentView(NAV_ITEMS[i].view, 1)).toBe(NAV_ITEMS[i + 1].view);
    }
  });

  it("이전(-1) 뷰는 NAV_ITEMS 역순을 따른다", () => {
    for (let i = NAV_ITEMS.length - 1; i > 0; i--) {
      expect(adjacentView(NAV_ITEMS[i].view, -1)).toBe(NAV_ITEMS[i - 1].view);
    }
  });

  it("마지막에서 다음(+1)은 첫으로 wrap 한다", () => {
    expect(adjacentView(last, 1)).toBe(first);
  });

  it("첫에서 이전(-1)은 마지막으로 wrap 한다", () => {
    expect(adjacentView(first, -1)).toBe(last);
  });

  it("dir +1/-1은 서로 역연산이다(왕복하면 제자리)", () => {
    for (const item of NAV_ITEMS) {
      expect(adjacentView(adjacentView(item.view, 1), -1)).toBe(item.view);
      expect(adjacentView(adjacentView(item.view, -1), 1)).toBe(item.view);
    }
  });
});

describe("defaultKeymap knob 엔트리", () => {
  it("좌우 기본 = Cmd+Left/Right, 상하 = 빈값", () => {
    const m = defaultKeymap();
    expect(m.knob_left).toBe("Cmd+Left");
    expect(m.knob_right).toBe("Cmd+Right");
    expect(m.knob_up).toBe("");
    expect(m.knob_down).toBe("");
  });
  it("트리거 기본 = Cmd", () => {
    expect(defaultKeymap()[KNOB_TRIGGER_KEY]).toBe(KNOB_TRIGGER_DEFAULT);
  });
  it("KNOB_DIRECTIONS는 4방향", () => {
    expect(KNOB_DIRECTIONS.map((d) => d.dir)).toEqual(["up", "down", "left", "right"]);
  });
});
