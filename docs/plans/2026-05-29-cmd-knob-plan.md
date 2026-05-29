# Cmd-Knob 구현 계획 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 스텝은 `- [ ]` 체크박스로 추적.
> 설계 정본: `docs/plans/2026-05-29-cmd-knob-design.md`. 도메인 규율: `docs/areas/frontend-shell.md`.

**Goal:** 설정된 모디파이어를 hold하면 커서 위치에 오락실 조이스틱이 떠서, 방향으로 밀면 그 방향에
설정된 단축키를 합성 `KeyboardEvent`로 발사하는 전역 마우스 네비게이션을 추가한다.

**Architecture:** 순수 유틸(`parseHotkeySpec`/`dispatchHotkey`, knob geometry) → 트리거·드래그 상태
머신 훅(`useCmdKnob`) → 렌더 컴포넌트(`CmdKnob`)를 App에 전역 1회 마운트. 방향→단축키·호출 키는
기존 keymap(`Record<string,string>`)에 `knob_*` 키로 저장(IPC 무변경). 발사는 기존 전역 keydown
핸들러(`useViewShortcuts`/App)가 처리 → `Cmd+Left/Right`는 기존 워크스페이스 슬라이드 재사용.

**Tech Stack:** React 19, TypeScript, Tailwind v4 `@theme`, vitest(jsdom), 기존 `src/lib/hotkey.ts`.

---

## 파일 구조

| 파일                                             | 책임                                                                 | 신규/수정    |
| ------------------------------------------------ | -------------------------------------------------------------------- | ------------ |
| `src/lib/hotkey.ts`                              | `parseHotkeySpec`(spec→키 이벤트 필드) 추가 — SPECIALS 역매핑        | 수정         |
| `src/lib/hotkey.test.ts`                         | `parseHotkeySpec` 라운드트립 테스트                                  | 신규         |
| `src/lib/dispatchHotkey.ts`                      | combo spec → 합성 keydown을 window에 dispatch                        | 신규         |
| `src/lib/dispatchHotkey.test.ts`                 | dispatch가 올바른 필드의 keydown을 쏘는지                            | 신규         |
| `src/lib/knobGeometry.ts`                        | `clampToThrow`/`armedDirection` 순수 함수 + `KnobDir` 타입           | 신규         |
| `src/lib/knobGeometry.test.ts`                   | 클램프·방향 판정 테스트                                              | 신규         |
| `src/lib/nav.ts`                                 | `KNOB_DIRECTIONS`/`KNOB_TRIGGER_*` + `defaultKeymap()`에 knob 엔트리 | 수정         |
| `src/lib/nav.test.ts`                            | `defaultKeymap`이 knob 기본값 포함하는지                             | 신규(없으면) |
| `src/lib/useCmdKnob.ts`                          | 트리거 dwell · 좌표 · 드래그 상태 머신 · 발사                        | 신규         |
| `src/components/CmdKnob.tsx`                     | 조이스틱 렌더 · 포인터 드래그 · armed 가이드                         | 신규         |
| `src/components/CmdKnob.css`                     | 베이스/스틱/틸트/스프링/reduced-motion                               | 신규         |
| `src/App.tsx`                                    | `<CmdKnob />` 전역 1회 마운트                                        | 수정         |
| `src/components/settings/NavigationSettings.tsx` | "조이스틱" 섹션(4방향 + 호출 키 칩)                                  | 수정         |

검증 명령(정본 `docs/reference/commands.md`): `pnpm vitest run`, `pnpm typecheck`, `pnpm lint`.
커밋 전 `export PATH="$HOME/.cargo/bin:$PATH"`(husky pre-commit가 `cargo fmt --check` 실행).

---

## Task 1: `parseHotkeySpec` + `dispatchHotkey`

**Files:**

- Modify: `src/lib/hotkey.ts`
- Test: `src/lib/hotkey.test.ts` (신규)
- Create: `src/lib/dispatchHotkey.ts`
- Test: `src/lib/dispatchHotkey.test.ts` (신규)

- [ ] **Step 1: `parseHotkeySpec` 실패 테스트 작성** — `src/lib/hotkey.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { eventToHotkeySpec, parseHotkeySpec } from "./hotkey";

describe("parseHotkeySpec", () => {
  it("Cmd+Left → ArrowLeft + metaKey", () => {
    expect(parseHotkeySpec("Cmd+Left")).toEqual({
      key: "ArrowLeft",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    });
  });

  it("Cmd+Shift+C → c + meta + shift", () => {
    expect(parseHotkeySpec("Cmd+Shift+C")).toEqual({
      key: "c",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
    });
  });

  it("Cmd+, → Comma 특수키", () => {
    expect(parseHotkeySpec("Cmd+,")?.key).toBe(",");
  });

  it("modifier 없음/빈 값 → null", () => {
    expect(parseHotkeySpec("Left")).toBeNull();
    expect(parseHotkeySpec("")).toBeNull();
  });

  it("eventToHotkeySpec와 라운드트립", () => {
    const parsed = parseHotkeySpec("Cmd+Right")!;
    const spec = eventToHotkeySpec({
      key: parsed.key,
      ctrlKey: parsed.ctrlKey,
      metaKey: parsed.metaKey,
      altKey: parsed.altKey,
      shiftKey: parsed.shiftKey,
    });
    expect(spec).toBe("Cmd+Right");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/lib/hotkey.test.ts`
Expected: FAIL — `parseHotkeySpec is not a function`.

- [ ] **Step 3: `parseHotkeySpec` 구현** — `src/lib/hotkey.ts` 끝에 추가(기존 `SPECIALS` 재사용)

```ts
/** label → e.key 역매핑(SPECIALS 반대 방향). "Left"→"ArrowLeft", "Comma"→"," 등. */
const LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIALS).map(([key, label]) => [label, key]),
);

export interface ParsedHotkey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * "Cmd+Left" 류 spec → 합성 KeyboardEvent에 넣을 필드. modifier가 하나도 없거나
 * 키 라벨이 없으면 null(eventToHotkeySpec의 역). 단일 문자는 소문자 e.key로,
 * 특수 라벨은 LABEL_TO_KEY로 복원한다(F1~F12는 그대로).
 */
export function parseHotkeySpec(spec: string): ParsedHotkey | null {
  const parts = spec
    .trim()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const mods = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  let label: string | null = null;
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case "ctrl":
        mods.ctrlKey = true;
        break;
      case "cmd":
      case "meta":
        mods.metaKey = true;
        break;
      case "alt":
        mods.altKey = true;
        break;
      case "shift":
        mods.shiftKey = true;
        break;
      default:
        label = p;
    }
  }
  if (!label) return null;
  if (!mods.ctrlKey && !mods.metaKey && !mods.altKey && !mods.shiftKey) return null;
  const key = LABEL_TO_KEY[label] ?? (label.length === 1 ? label.toLowerCase() : label);
  return { key, ...mods };
}
```

- [ ] **Step 4: parse 테스트 통과 확인**

Run: `pnpm vitest run src/lib/hotkey.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: `dispatchHotkey` 실패 테스트 작성** — `src/lib/dispatchHotkey.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchHotkey } from "./dispatchHotkey";

describe("dispatchHotkey", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Cmd+Left → window에 ArrowLeft+meta keydown 발사 후 true", () => {
    const seen: KeyboardEvent[] = [];
    const handler = (e: Event) => seen.push(e as KeyboardEvent);
    window.addEventListener("keydown", handler);
    const ok = dispatchHotkey("Cmd+Left");
    window.removeEventListener("keydown", handler);

    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("ArrowLeft");
    expect(seen[0].metaKey).toBe(true);
    expect(seen[0].altKey).toBe(false);
    expect(seen[0].shiftKey).toBe(false);
  });

  it("빈/무효 spec → 발사 없이 false", () => {
    const handler = vi.fn();
    window.addEventListener("keydown", handler);
    expect(dispatchHotkey("")).toBe(false);
    window.removeEventListener("keydown", handler);
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: 실패 확인**

Run: `pnpm vitest run src/lib/dispatchHotkey.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 7: `dispatchHotkey` 구현** — `src/lib/dispatchHotkey.ts`

```ts
import { parseHotkeySpec } from "@/lib/hotkey";

/**
 * combo spec("Cmd+Left")을 합성 keydown 이벤트로 만들어 window에 dispatch한다.
 * 기존 전역 keydown 핸들러(useViewShortcuts/App)가 읽는 필드만 채운다 — keyup은 불필요.
 * 파싱 실패 시 아무것도 안 쏘고 false. (knob 방향 발사 전용 유틸.)
 */
export function dispatchHotkey(spec: string): boolean {
  const parsed = parseHotkeySpec(spec);
  if (!parsed) return false;
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: parsed.key,
      ctrlKey: parsed.ctrlKey,
      metaKey: parsed.metaKey,
      altKey: parsed.altKey,
      shiftKey: parsed.shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
```

- [ ] **Step 8: 통과 확인 + 커밋**

Run: `pnpm vitest run src/lib/hotkey.test.ts src/lib/dispatchHotkey.test.ts`
Expected: PASS.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/lib/hotkey.ts src/lib/hotkey.test.ts src/lib/dispatchHotkey.ts src/lib/dispatchHotkey.test.ts
git commit -m "feat(knob): parseHotkeySpec + dispatchHotkey — combo spec을 합성 keydown으로 발사"
```

---

## Task 2: knob geometry 순수 함수

**Files:**

- Create: `src/lib/knobGeometry.ts`
- Test: `src/lib/knobGeometry.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `src/lib/knobGeometry.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { armedDirection, clampToThrow, type KnobDir } from "./knobGeometry";

const ALL: Record<KnobDir, boolean> = { up: true, down: true, left: true, right: true };

describe("clampToThrow", () => {
  it("반경 안이면 그대로", () => {
    expect(clampToThrow(3, 4, 10)).toEqual({ x: 3, y: 4 });
  });
  it("반경 밖이면 원 위로 클램프(거리=반경)", () => {
    const { x, y } = clampToThrow(30, 40, 10); // dist 50 → 1/5
    expect(Math.hypot(x, y)).toBeCloseTo(10);
    expect(x).toBeCloseTo(6);
    expect(y).toBeCloseTo(8);
  });
});

describe("armedDirection", () => {
  const R = 100;
  const RATIO = 0.55; // 임계 55

  it("임계 미만이면 null", () => {
    expect(armedDirection(40, 0, R, RATIO, ALL)).toBeNull();
  });
  it("우세 축이 좌측이면 left", () => {
    expect(armedDirection(-60, 10, R, RATIO, ALL)).toBe("left");
  });
  it("우세 축이 위면 up(화면 y는 아래가 양수)", () => {
    expect(armedDirection(10, -70, R, RATIO, ALL)).toBe("up");
  });
  it("해당 방향이 disabled면 null", () => {
    expect(armedDirection(-60, 10, R, RATIO, { ...ALL, left: false })).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/lib/knobGeometry.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/lib/knobGeometry.ts`

```ts
export type KnobDir = "up" | "down" | "left" | "right";

/** 드래그 오프셋(dx,dy)을 반경 안으로 원형 클램프. 반경 안/0이면 그대로. */
export function clampToThrow(dx: number, dy: number, radius: number): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius || dist === 0) return { x: dx, y: dy };
  const k = radius / dist;
  return { x: dx * k, y: dy * k };
}

/**
 * 현재 편향에서 armed 방향 판정. 우세 축의 절대값이 임계(radius*ratio)를 넘고
 * 그 방향이 enabled일 때만 방향 반환. 화면 좌표라 위쪽이 음의 y.
 */
export function armedDirection(
  dx: number,
  dy: number,
  radius: number,
  ratio: number,
  enabled: Record<KnobDir, boolean>,
): KnobDir | null {
  const threshold = radius * ratio;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return null;
  const dir: KnobDir = ax >= ay ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
  return enabled[dir] ? dir : null;
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm vitest run src/lib/knobGeometry.test.ts`
Expected: PASS.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/lib/knobGeometry.ts src/lib/knobGeometry.test.ts
git commit -m "feat(knob): clampToThrow + armedDirection 순수 geometry"
```

---

## Task 3: nav.ts — knob 방향/트리거 메타 + 기본 keymap

**Files:**

- Modify: `src/lib/nav.ts`
- Test: `src/lib/nav.test.ts` (없으면 신규)

- [ ] **Step 1: 실패 테스트 작성** — `src/lib/nav.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { defaultKeymap, KNOB_DIRECTIONS, KNOB_TRIGGER_DEFAULT, KNOB_TRIGGER_KEY } from "./nav";

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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/lib/nav.test.ts`
Expected: FAIL — export 없음.

- [ ] **Step 3: 구현** — `src/lib/nav.ts`

상단 import에 추가:

```ts
import type { KnobDir } from "@/lib/knobGeometry";
```

`adjacentView` 위(파일 끝 근처)에 추가:

```ts
/** 조이스틱 방향 메타 — 설정 행/가이드 글리프/keymap 키를 한 곳에서. */
export const KNOB_DIRECTIONS: { dir: KnobDir; key: string; label: string; glyph: string }[] = [
  { dir: "up", key: "knob_up", label: "조이스틱 ↑", glyph: "↑" },
  { dir: "down", key: "knob_down", label: "조이스틱 ↓", glyph: "↓" },
  { dir: "left", key: "knob_left", label: "조이스틱 ←", glyph: "←" },
  { dir: "right", key: "knob_right", label: "조이스틱 →", glyph: "→" },
];

/** knob 호출(트리거) 모디파이어 spec을 담는 예약 keymap 키 + 기본값. */
export const KNOB_TRIGGER_KEY = "knob_trigger";
export const KNOB_TRIGGER_DEFAULT = "Cmd";
```

`defaultKeymap()` 본문 마지막 `return m;` 직전에 추가:

```ts
// 조이스틱: 좌우는 인접 뷰 nav(기존 슬라이드 재사용), 상하는 기본 비활성(빈값).
m.knob_left = "Cmd+Left";
m.knob_right = "Cmd+Right";
m.knob_up = "";
m.knob_down = "";
m[KNOB_TRIGGER_KEY] = KNOB_TRIGGER_DEFAULT;
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm vitest run src/lib/nav.test.ts && pnpm typecheck`
Expected: PASS / 타입 OK.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/lib/nav.ts src/lib/nav.test.ts
git commit -m "feat(knob): KNOB_DIRECTIONS/트리거 메타 + defaultKeymap knob 엔트리"
```

---

## Task 4: `useCmdKnob` 훅 (트리거 dwell + 발사)

훅은 트리거 hold/dwell 감지, 커서 좌표, 방향 enabled, 발사·해제를 담당한다. 드래그 포인터 수학은
컴포넌트(Task 5)가 `knobGeometry`로 처리하고 `fire(dir)`를 호출한다.

**Files:**

- Create: `src/lib/useCmdKnob.ts`

- [ ] **Step 1: 트리거 파서 + 모디파이어 키 판정 작성** (구현 먼저 — DOM 타이머 의존이라 유닛 대신 Task 7 스모크로 검증)

`src/lib/useCmdKnob.ts`:

```ts
import { useEffect, useRef, useState } from "react";

import { isOverlayOpen } from "@/components/ui/overlay-stack";
import { dispatchHotkey } from "@/lib/dispatchHotkey";
import type { KnobDir } from "@/lib/knobGeometry";
import { KNOB_DIRECTIONS, KNOB_TRIGGER_DEFAULT, KNOB_TRIGGER_KEY } from "@/lib/nav";
import { useNavKeymap } from "@/lib/query";

const DWELL_MS = 300;
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

type TriggerMods = { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

/** "Cmd+Shift" 류 트리거 spec → 모디파이어 집합. 빈 값/무효는 Cmd 단독으로 폴백. */
function parseTrigger(spec: string | undefined): TriggerMods {
  const mods: TriggerMods = { ctrl: false, meta: false, alt: false, shift: false };
  const parts = (spec && spec.trim() ? spec : KNOB_TRIGGER_DEFAULT)
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const p of parts) {
    if (p === "ctrl") mods.ctrl = true;
    else if (p === "cmd" || p === "meta") mods.meta = true;
    else if (p === "alt") mods.alt = true;
    else if (p === "shift") mods.shift = true;
  }
  if (!mods.ctrl && !mods.meta && !mods.alt && !mods.shift) mods.meta = true;
  return mods;
}

/** 이벤트의 현재 모디파이어 상태가 트리거와 정확히 일치하는가(추가 모디파이어 없음). */
function modsExactlyMatch(e: KeyboardEvent, t: TriggerMods): boolean {
  return (
    e.ctrlKey === t.ctrl && e.metaKey === t.meta && e.altKey === t.alt && e.shiftKey === t.shift
  );
}

function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!node.isContentEditable;
}

export interface CmdKnobState {
  visible: boolean;
  origin: { x: number; y: number };
  dirEnabled: Record<KnobDir, boolean>;
  /** 방향 발사: 그 방향에 설정된 combo를 dispatch. 미설정이면 no-op. */
  fire: (dir: KnobDir) => void;
  /** 강제 해제(드래그 취소 등). */
  dismiss: () => void;
}

/**
 * 트리거 모디파이어 단독 hold(~300ms dwell) → 커서 위치에 knob을 띄운다.
 * dwell 중 비-모디파이어 키/추가 모디파이어가 오면 그 hold 세션 취소(기존 조합키 무손상).
 * visible 이후엔 키로 취소하지 않는다 — 자기 합성 발사에 스스로 닫히지 않도록(설계 §3).
 * 트리거 release로만 종료.
 */
export function useCmdKnob(): CmdKnobState {
  const keymap = useNavKeymap();
  const [visible, setVisible] = useState(false);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });

  // 리스너에서 안전하게 읽을 최신값 ref.
  const keymapRef = useRef(keymap.data);
  const pointerRef = useRef({ x: 0, y: 0 });
  const visibleRef = useRef(false);
  const dwellTimerRef = useRef<number | null>(null);
  const downNonModRef = useRef(false);
  useEffect(() => {
    keymapRef.current = keymap.data;
  });
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const dirEnabled: Record<KnobDir, boolean> = {
    up: !!(keymap.data?.knob_up ?? "").trim(),
    down: !!(keymap.data?.knob_down ?? "").trim(),
    left: !!(keymap.data?.knob_left ?? "").trim(),
    right: !!(keymap.data?.knob_right ?? "").trim(),
  };

  const dismiss = () => {
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    if (visibleRef.current) setVisible(false);
  };

  const fire = (dir: KnobDir) => {
    const map = keymapRef.current;
    const key = KNOB_DIRECTIONS.find((d) => d.dir === dir)?.key;
    const combo = key ? (map?.[key] ?? "") : "";
    if (combo.trim()) dispatchHotkey(combo.trim());
  };

  useEffect(() => {
    const cancelDwell = () => {
      if (dwellTimerRef.current !== null) {
        window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // visible: 키 무시(자기-발사 자기-취소 방지). 트리거 release는 keyup에서만 처리.
      if (visibleRef.current) return;

      const trigger = parseTrigger(keymapRef.current?.[KNOB_TRIGGER_KEY]);

      if (!MODIFIER_KEYS.has(e.key)) {
        // 비-모디파이어 키 → arming 취소(Cmd+K 등 기존 조합 무손상).
        downNonModRef.current = true;
        cancelDwell();
        return;
      }

      // 모디파이어 keydown: 지금 눌린 모디파이어가 트리거와 정확히 일치 + 비모디파이어 키 없음 → dwell 시작.
      if (!downNonModRef.current && modsExactlyMatch(e, trigger)) {
        cancelDwell();
        dwellTimerRef.current = window.setTimeout(() => {
          dwellTimerRef.current = null;
          if (isOverlayOpen() || isEditableTarget(document.activeElement)) return;
          setOrigin(pointerRef.current);
          setVisible(true);
        }, DWELL_MS);
      } else {
        cancelDwell();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(e.key)) {
        // 모든 비-모디파이어가 떼어졌다고 가정할 순 없지만, 단순화: 비모디파이어 up이면 플래그 해제.
        downNonModRef.current = false;
        return;
      }
      const trigger = parseTrigger(keymapRef.current?.[KNOB_TRIGGER_KEY]);
      // 모디파이어를 떼서 더 이상 트리거와 일치하지 않으면 dwell 취소 / knob 해제.
      if (!modsExactlyMatch(e, trigger)) {
        cancelDwell();
        if (visibleRef.current) setVisible(false);
      }
    };

    const onBlur = () => {
      cancelDwell();
      downNonModRef.current = false;
      if (visibleRef.current) setVisible(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      cancelDwell();
    };
  }, []);

  return { visible, origin, dirEnabled, fire, dismiss };
}
```

- [ ] **Step 2: 타입 확인**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/lib/useCmdKnob.ts
git commit -m "feat(knob): useCmdKnob — 트리거 dwell 상태머신 + 방향 발사"
```

> NOTE: `useNavKeymap`이 `@/lib/query`에서 export되는지 확인(이미 그렇다). `isOverlayOpen`은
> `@/components/ui/overlay-stack`에서 import(기존 App.tsx가 동일 경로 사용).

---

## Task 5: `CmdKnob` 컴포넌트 + CSS + App 마운트

**Files:**

- Create: `src/components/CmdKnob.tsx`, `src/components/CmdKnob.css`
- Modify: `src/App.tsx`

- [ ] **Step 1: 컴포넌트 작성** — `src/components/CmdKnob.tsx`

```tsx
import { useEffect, useRef, useState } from "react";

import "./CmdKnob.css";

import { armedDirection, clampToThrow, type KnobDir } from "@/lib/knobGeometry";
import { useCmdKnob } from "@/lib/useCmdKnob";

const THROW_RADIUS = 46; // px — 스틱 최대 편향
const ARM_RATIO = 0.55; // 임계 = 반경 * 0.55
const TILT_DEG = 22; // 풀 편향 시 최대 틸트 각

const GLYPH: Record<KnobDir, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/**
 * 전역 오락실 조이스틱(설계 §3). useCmdKnob이 visible/origin/발사를 관리하고,
 * 여기선 포인터 드래그 → clampToThrow/armedDirection으로 스틱 위치·armed 방향을 계산한다.
 * mouseup 시 armed면 fire(dir), 항상 중앙으로 스프링백. 트리거 release는 훅이 dismiss.
 */
export function CmdKnob() {
  const { visible, origin, dirEnabled, fire } = useCmdKnob();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [armed, setArmed] = useState<KnobDir | null>(null);
  const draggingRef = useRef(false);

  // 보이지 않게 되면 드래그 상태 리셋.
  useEffect(() => {
    if (!visible) {
      draggingRef.current = false;
      setOffset({ x: 0, y: 0 });
      setArmed(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const { x, y } = clampToThrow(e.clientX - origin.x, e.clientY - origin.y, THROW_RADIUS);
      setOffset({ x, y });
      setArmed(armedDirection(x, y, THROW_RADIUS, ARM_RATIO, dirEnabled));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (armed) fire(armed);
      setOffset({ x: 0, y: 0 });
      setArmed(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [visible, origin, dirEnabled, armed, fire]);

  if (!visible) return null;

  const tiltX = (offset.y / THROW_RADIUS) * TILT_DEG; // 위로 밀면 -y → 앞으로 기울기
  const tiltY = (offset.x / THROW_RADIUS) * TILT_DEG;

  return (
    <div
      className="cmd-knob"
      style={{ left: origin.x, top: origin.y }}
      role="presentation"
      aria-hidden
    >
      <div className="cmd-knob-base">
        {(Object.keys(GLYPH) as KnobDir[]).map((dir) => (
          <span
            key={dir}
            className="cmd-knob-guide"
            data-dir={dir}
            data-enabled={dirEnabled[dir] || undefined}
            data-armed={armed === dir || undefined}
          >
            {GLYPH[dir]}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="cmd-knob-stick"
        data-dragging={draggingRef.current || undefined}
        style={{
          transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) perspective(220px) rotateX(${-tiltX}deg) rotateY(${tiltY}deg)`,
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
        }}
        aria-label="조이스틱 — 방향으로 밀어 단축키 실행"
      />
    </div>
  );
}
```

- [ ] **Step 2: CSS 작성** — `src/components/CmdKnob.css` (DESIGN.md 토큰 사용)

```css
/* 전역 오락실 조이스틱. origin(커서 좌표)에 fixed, 베이스 중심을 origin에 맞춘다. */
.cmd-knob {
  position: fixed;
  z-index: 70; /* 오버레이 스택 위 — 팔레트/드로어와 겹치지 않게(억제는 훅에서) */
  width: 0;
  height: 0;
  pointer-events: none; /* 베이스는 통과, 스틱만 잡힘 */
  animation: cmd-knob-in var(--wr-motion-fast, 0.16s) var(--wr-ease-out, ease-out) both;
}

.cmd-knob-base {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 124px;
  height: 124px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--color-wr-surface, #fff);
  border: 1px solid var(--color-wr-border, rgba(0, 0, 0, 0.12));
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.08),
    0 8px 24px rgba(0, 0, 0, 0.14);
}

.cmd-knob-guide {
  position: absolute;
  font-size: 13px;
  line-height: 1;
  color: var(--color-wr-muted, rgba(0, 0, 0, 0.28));
  opacity: 0.35;
  transition:
    opacity 0.12s ease-out,
    color 0.12s ease-out;
}
.cmd-knob-guide[data-enabled] {
  opacity: 0.7;
}
.cmd-knob-guide[data-armed] {
  color: var(--color-wr-accent, #2563eb);
  opacity: 1;
}
.cmd-knob-guide[data-dir="up"] {
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
}
.cmd-knob-guide[data-dir="down"] {
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
}
.cmd-knob-guide[data-dir="left"] {
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
}
.cmd-knob-guide[data-dir="right"] {
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
}

.cmd-knob-stick {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 56px;
  height: 56px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--color-wr-border, rgba(0, 0, 0, 0.16));
  background: radial-gradient(circle at 38% 32%, #fff 0%, #ececed 62%, #d8d8da 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.8),
    0 4px 10px rgba(0, 0, 0, 0.22);
  cursor: grab;
  pointer-events: auto;
  transform: translate(-50%, -50%);
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1); /* 스프링백 */
}
.cmd-knob-stick[data-dragging] {
  cursor: grabbing;
  transition: none; /* 드래그 중 1:1 추적 */
}

@keyframes cmd-knob-in {
  from {
    opacity: 0;
    transform: scale(0.82);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cmd-knob {
    animation: none;
  }
  .cmd-knob-stick {
    transition: none;
  }
}
```

> NOTE: 토큰명(`--color-wr-surface` 등)은 `DESIGN.md`/`src/styles/tokens.css`의 실제 토큰으로
> 맞춘다. 폴백값을 둬서 토큰 누락 시에도 동작하지만, 구현 시 `tokens.css`를 grep해 정확한 변수명으로
> 교체할 것(예: `--color-wr-bg`는 이미 존재).

- [ ] **Step 3: App에 마운트** — `src/App.tsx`

import 추가:

```tsx
import { CmdKnob } from "@/components/CmdKnob";
```

`<ToastHost />` 다음 줄(다른 전역 오버레이 옆)에 추가:

```tsx
{
  /* 전역 오락실 조이스틱 — 트리거 hold 시 커서 위치에 등장(useCmdKnob). */
}
<CmdKnob />;
```

- [ ] **Step 4: 타입/린트 확인**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (lint은 게이트 에러 0 — 기존 warning은 무관).

- [ ] **Step 5: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/components/CmdKnob.tsx src/components/CmdKnob.css src/App.tsx
git commit -m "feat(knob): CmdKnob 컴포넌트 + 전역 마운트 — 드래그 틸트/스프링/armed 가이드"
```

---

## Task 6: 설정 — "조이스틱" 섹션 (4방향 + 호출 키)

**Files:**

- Modify: `src/components/settings/NavigationSettings.tsx`

- [ ] **Step 1: import 확장**

```tsx
import { EXTRA_ACTIONS, KNOB_DIRECTIONS, KNOB_TRIGGER_KEY, NAV_ITEMS } from "@/lib/nav";
```

- [ ] **Step 2: 모디파이어 칩 피커 컴포넌트 추가** — 파일 하단(ViewKeymapCapture 아래)

```tsx
// ── 호출 키(모디파이어 전용) 칩 피커 ───────────────────────────────
const TRIGGER_CHIPS: { mod: string; glyph: string }[] = [
  { mod: "Cmd", glyph: "⌘" },
  { mod: "Ctrl", glyph: "⌃" },
  { mod: "Alt", glyph: "⌥" },
  { mod: "Shift", glyph: "⇧" },
];

/** "Cmd+Shift" 류 spec ↔ 칩 토글. 모디파이어 순서는 Ctrl→Cmd→Alt→Shift 고정. */
function TriggerPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const active = new Set(
    value
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  const toggle = (mod: string) => {
    const next = new Set(active);
    if (next.has(mod)) next.delete(mod);
    else next.add(mod);
    const ordered = ["Ctrl", "Cmd", "Alt", "Shift"].filter((m) => next.has(m));
    onChange(ordered.join("+"));
  };
  return (
    <div className="flex items-center gap-1.5">
      {TRIGGER_CHIPS.map((c) => (
        <button
          key={c.mod}
          type="button"
          className={cn(
            "border-input bg-background text-foreground flex h-8 min-w-[40px] items-center justify-center rounded-md border font-mono text-sm transition-colors",
            active.has(c.mod) && "border-primary ring-ring ring-2",
          )}
          onClick={() => toggle(c.mod)}
          aria-pressed={active.has(c.mod)}
          title={`${c.mod} 토글`}
        >
          {c.glyph}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 섹션 렌더 추가** — `hasDup` 경고 블록 다음, 저장 버튼 행 앞에 삽입

```tsx
{
  /* 조이스틱(knob) — 방향별 발사 단축키 + 호출 키 */
}
<div className="flex flex-col gap-1.5">
  <SectionLabel>조이스틱 (호출 키 hold → 커서에 등장, 방향으로 밀어 실행)</SectionLabel>
  <div className="flex items-center gap-3 py-1">
    <span className="text-foreground w-28 shrink-0 text-[13px]">호출 키</span>
    <TriggerPicker
      value={kmDraft[KNOB_TRIGGER_KEY] ?? ""}
      onChange={(v) => setKmDraft((prev) => ({ ...prev, [KNOB_TRIGGER_KEY]: v }))}
    />
  </div>
  {KNOB_DIRECTIONS.map((d) => (
    <div key={d.key} className="flex items-center gap-3 py-1">
      <span className="text-foreground w-28 shrink-0 text-[13px]">{d.label}</span>
      <ViewKeymapCapture
        value={kmDraft[d.key] ?? ""}
        onChange={(v) => setKmDraft((prev) => ({ ...prev, [d.key]: v }))}
        label={d.label}
        duplicate={false}
      />
    </div>
  ))}
  <p className="text-muted-foreground text-xs">
    뷰 전환(인접 이동)은 <code>Cmd+Left</code>/<code>Cmd+Right</code>처럼 Shift·Alt 없는 조합만
    동작합니다. 그 외 방향엔 원하는 메뉴 단축키(예: Cmd+1)를 지정하세요. 빈 값 = 그 방향 비활성.
  </p>
</div>;
```

> NOTE: knob 행은 기존 "메뉴 단축키" 중복 감지(`specCounts`)에 포함하지 않는다(발사용이라 중복이
> 정상일 수 있음) → `duplicate={false}` 고정. `kmDraft`/`saveKeymap`은 기존 경로를 그대로 타므로
> knob\_\* / knob_trigger가 자동 저장된다.

- [ ] **Step 4: 타입/린트 + 수동 확인**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/components/settings/NavigationSettings.tsx
git commit -m "feat(knob): 설정에 조이스틱 방향 4행 + 호출 키 칩 피커"
```

---

## Task 7: 토큰 정합 · 검증 · 수동 스모크

**Files:** (조정만)

- Modify: `src/components/CmdKnob.css` (토큰명 확정 시)

- [ ] **Step 1: 토큰명 확정** — `src/styles/tokens.css`를 grep해 surface/border/muted/accent 실제
      변수명으로 CmdKnob.css 폴백 교체. 없으면 가장 가까운 기존 토큰(`--color-wr-bg`, 보더 토큰 등) 사용.

Run: `grep -n "color-wr\|--color" src/styles/tokens.css | head -40`

- [ ] **Step 2: 전체 자동 검증**

Run:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm vitest run && pnpm typecheck && pnpm lint
```

Expected: vitest 전부 PASS, typecheck OK, lint 게이트 에러 0. `bindings.ts` 변경 없음(IPC 무손상).

- [ ] **Step 3: 수동 스모크(`pnpm tauri dev`)** — 설계 §8 done-criteria

체크(관찰 결과로 채움):

- [ ] ⌘ ~300ms hold → 커서 위치에 knob 등장.
- [ ] ⌘+K는 knob 안 뜨고 팔레트 토글(arming 취소 확인).
- [ ] 스틱 ← 임계 너머 밀고 떼기 → 이전 뷰로 기존 슬라이드; → 다음 뷰.
- [ ] 발사 후 ⌘ 유지 상태에서 다시 밀기 가능(자기-취소 없음).
- [ ] 설정에서 ↑=`Cmd+1` 지정 → ↑ 밀기 → board 이동.
- [ ] 설정에서 호출 키 ⌃로 변경 → ⌘ hold 무반응, ⌃ hold에 등장.
- [ ] 입력 필드 포커스 / 팔레트 열림 중 hold → 억제.
- [ ] OS `prefers-reduced-motion` on → tilt/스프링 축소.

- [ ] **Step 4: 결정 로그 + (선택) 메모리**

`docs/decisions.md`에 한 줄 추가:

```
- 2026-05-29 cmd-knob: 전역 모디파이어 hold→커서 조이스틱→방향별 설정 단축키를 합성 keydown으로 발사.
  knob은 의미 무지(기존 핸들러 재사용), 방향/호출키 모두 keymap(knob_*)에 저장, IPC 무변경.
```

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add docs/decisions.md src/components/CmdKnob.css
git commit -m "chore(knob): 토큰 정합 + decisions 로그"
```

- [ ] **Step 5: INVARIANT 별도 reviewer 패스** (self-approve 금지 — AGENTS.md)
      `critic`/`code-reviewer`로 decision-rails 7 INVARIANT 위반 여부 확인 후 PR.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: 설계 §3 트리거/생명주기→Task4, §4 방향매핑→Task3/6, §5 호출키→Task3/6,
  §6 모듈경계→Task1~6, §3 자기-취소 방지→Task4(visible 시 키 무시), §4 nav modifier-exact→Task6 주의문구.
  §8 done-criteria→Task7 스모크. ✅ 누락 없음.
- **Placeholder 스캔**: 코드 스텝마다 실제 코드 포함. CmdKnob.css 토큰명은 Task7 Step1에서 확정(명시적
  follow-up이라 placeholder 아님).
- **타입 정합**: `KnobDir`(knobGeometry) — nav/useCmdKnob/CmdKnob에서 동일 import. `dirEnabled`는
  `Record<KnobDir,boolean>` 일관. `fire(dir)`/`KNOB_DIRECTIONS[].key` 일치. `parseHotkeySpec`
  반환 필드 = `dispatchHotkey`/테스트 사용 필드 일치.

## 알려진 한계 / deferred

- jsdom에서 트리거 dwell/드래그 통합 테스트는 타이머·포인터 모킹이 무거워 **수동 스모크로 대체**
  (Task7). 순수 유닛(hotkey/geometry/nav)만 자동화.
- hold-repeat·대각선 8방향·방향별 1:1 스크럽 프리뷰는 설계 §2 비목표(추후).
