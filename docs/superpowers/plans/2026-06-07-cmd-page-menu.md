# Cmd-hold 페이지 메뉴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd(Win: Ctrl)를 hold 했을 때 기존 조이스틱 레버와 **함께** 모든 페이지를 아이콘+라벨 칩으로 가로로 펼치는 직접 선택 메뉴를 띄워, 마우스 클릭으로 임의 페이지에 즉시 점프할 수 있게 한다.

**Architecture:** 순수 위치 계산 함수(`clampMenuPosition`) + 표현 컴포넌트(`CmdPageMenu`)를 추가하고, 기존 `CmdKnob`가 단일 `useCmdKnob()` 세션 안에서 레버와 메뉴를 함께 렌더한다. 메뉴는 자체 dismiss 상태 없이 `useCmdKnob`의 `visible`(Cmd release/blur로 종료)에 종속한다. 순수 프런트 추가 — IPC/Rust/마이그레이션 무관.

**Tech Stack:** React 19 + TypeScript, zustand(`useUIStore`), Tailwind v4 `@theme` 토큰 + 컴포넌트 CSS, vitest(node env, `renderToStaticMarkup`로 컴포넌트 테스트 — RTL 미도입).

**정본 스펙:** `docs/superpowers/specs/2026-06-07-cmd-page-menu-design.md`

---

## File Structure

생성:

- `src/lib/cmdPageMenuPosition.ts` — 메뉴 화면 위치 계산 순수 함수(중앙 정렬 + 뷰포트 clamp + above/below flip).
- `src/lib/cmdPageMenuPosition.test.ts` — 위 함수 단위 테스트.
- `src/components/CmdPageMenu.tsx` — `NAV_ITEMS` 칩 렌더 + 클릭 점프 + 위치 적용 표현 컴포넌트.
- `src/components/CmdPageMenu.css` — 메뉴/칩 스타일(DESIGN 토큰 재사용).
- `src/components/CmdPageMenu.test.tsx` — `renderToStaticMarkup` 마크업 테스트(칩 렌더/활성 표시).

수정:

- `src/components/CmdKnob.tsx` — `visible`일 때 `<CmdPageMenu origin={origin} />`를 함께 렌더(레버 로직 무변경).
- `docs/decisions.md` — Phase 트레이드오프 한 줄 추가.

읽기만(수정 금지): `src/lib/nav.ts`(`NAV_ITEMS`), `src/store.ts`(`useUIStore.view`/`goTo`), `src/lib/useCmdKnob.ts`.

---

## Task 1: 메뉴 위치 계산 순수 함수

origin(커서) 기준 가로 중앙 정렬, 기본은 레버 위쪽(above), 위 공간 부족 시 아래(below)로 flip, 항상 뷰포트 안으로 clamp. `knobGeometry.ts`와 동일한 "순수 함수 + 단위 테스트" 패턴을 따른다.

**Files:**

- Create: `src/lib/cmdPageMenuPosition.ts`
- Test: `src/lib/cmdPageMenuPosition.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/cmdPageMenuPosition.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { clampMenuPosition } from "./cmdPageMenuPosition";

const VP = { w: 1000, h: 800 };
const MENU = { w: 200, h: 60 };
const MARGIN = 8;
const CLEAR = 70;

describe("clampMenuPosition", () => {
  it("origin.x를 중심으로 가로 정렬", () => {
    const p = clampMenuPosition({ x: 500, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.left).toBe(400); // 500 - 200/2
  });

  it("좌측 가장자리를 넘으면 margin으로 clamp", () => {
    const p = clampMenuPosition({ x: 10, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.left).toBe(8);
  });

  it("우측 가장자리를 넘으면 (뷰포트폭 - 메뉴폭 - margin)으로 clamp", () => {
    const p = clampMenuPosition({ x: 990, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.left).toBe(792); // 1000 - 200 - 8
  });

  it("위 공간이 충분하면 above 배치(top = origin.y - clearance - menu.h)", () => {
    const p = clampMenuPosition({ x: 500, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(270); // 400 - 70 - 60
  });

  it("위 공간이 부족하면 below로 flip(top = origin.y + clearance)", () => {
    const p = clampMenuPosition({ x: 500, y: 20 }, VP, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(90); // 20 + 70
  });

  it("below가 아래로 넘치면 (뷰포트높이 - 메뉴높이 - margin)으로 clamp", () => {
    // 작은 뷰포트: 위도 부족 → below, 그러나 below도 넘침 → 끌어올림
    const p = clampMenuPosition({ x: 500, y: 10 }, { w: 1000, h: 120 }, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(52); // clamp: 120 - 60 - 8
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/lib/cmdPageMenuPosition.test.ts`
Expected: FAIL — `clampMenuPosition` 모듈/함수 없음.

- [ ] **Step 3: 최소 구현**

`src/lib/cmdPageMenuPosition.ts`:

```ts
export interface MenuPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Cmd 페이지 메뉴의 화면 위치 계산(순수). origin(커서) 기준 가로 중앙 정렬,
 * 기본은 레버 위쪽(above) — 위 공간이 부족하면 아래(below)로 flip하고, 항상 뷰포트 안으로 clamp.
 * margin = 뷰포트 가장자리 최소 여백, clearance = origin(레버 중심)에서 메뉴까지 띄울 간격.
 */
export function clampMenuPosition(
  origin: { x: number; y: number },
  viewport: { w: number; h: number },
  menu: { w: number; h: number },
  margin: number,
  clearance: number,
): MenuPosition {
  const rawLeft = origin.x - menu.w / 2;
  const maxLeft = Math.max(margin, viewport.w - menu.w - margin);
  const left = Math.min(Math.max(rawLeft, margin), maxLeft);

  const aboveTop = origin.y - clearance - menu.h;
  let placement: "above" | "below";
  let top: number;
  if (aboveTop >= margin) {
    placement = "above";
    top = aboveTop;
  } else {
    placement = "below";
    top = origin.y + clearance;
  }
  const maxTop = Math.max(margin, viewport.h - menu.h - margin);
  top = Math.min(Math.max(top, margin), maxTop);

  return { left, top, placement };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/lib/cmdPageMenuPosition.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"  # husky pre-commit가 cargo fmt 호출 — PATH 필요
git add src/lib/cmdPageMenuPosition.ts src/lib/cmdPageMenuPosition.test.ts
git commit -m "feat(cmd-knob): add clampMenuPosition for page menu placement"
```

---

## Task 2: CmdPageMenu 컴포넌트 + 스타일

`NAV_ITEMS`를 아이콘+라벨 칩으로 렌더하고, 클릭 시 `goTo`로 점프, 현재 뷰 칩을 활성 표시한다. 위치는 Task 1 함수로 계산(마운트 후 ref 실측 → `useLayoutEffect`에서 1회 반영, 측정 전엔 `visibility: hidden`으로 flash 방지).

**Files:**

- Create: `src/components/CmdPageMenu.tsx`
- Create: `src/components/CmdPageMenu.css`
- Test: `src/components/CmdPageMenu.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/components/CmdPageMenu.test.tsx` (기존 `AskUserCard.test.tsx`와 동일하게 `renderToStaticMarkup` 사용 — node env + RTL 미도입):

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CmdPageMenu } from "./CmdPageMenu";
import { NAV_ITEMS } from "@/lib/nav";

describe("CmdPageMenu", () => {
  it("모든 NAV_ITEMS 라벨을 칩으로 렌더한다", () => {
    const html = renderToStaticMarkup(<CmdPageMenu origin={{ x: 0, y: 0 }} />);
    for (const item of NAV_ITEMS) {
      expect(html).toContain(item.label);
    }
  });

  it("초기(측정 전)엔 visibility hidden으로 렌더한다(flash 방지)", () => {
    const html = renderToStaticMarkup(<CmdPageMenu origin={{ x: 0, y: 0 }} />);
    expect(html).toContain("visibility:hidden");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/components/CmdPageMenu.test.tsx`
Expected: FAIL — `CmdPageMenu` 모듈 없음.

- [ ] **Step 3: 컴포넌트 구현**

`src/components/CmdPageMenu.tsx`:

```tsx
import "./CmdPageMenu.css";

import { useLayoutEffect, useRef, useState } from "react";

import { clampMenuPosition, type MenuPosition } from "@/lib/cmdPageMenuPosition";
import { NAV_ITEMS } from "@/lib/nav";
import { useUIStore } from "@/store";

const MARGIN = 8;
const CLEARANCE = 78; // 레버 베이스(124px)의 반경 + 여유 — 메뉴가 레버를 가리지 않게

/**
 * Cmd-hold 세션에서 레버와 함께 뜨는 가로 페이지 메뉴(설계 2026-06-07).
 * 모든 NAV_ITEMS를 아이콘+라벨 칩으로 펼치고, 클릭 시 goTo로 즉시 점프한다.
 * 자체 dismiss 상태 없음 — CmdKnob의 visible(=Cmd release/blur)에 종속해 함께 닫힌다.
 * 위치는 clampMenuPosition으로 origin 중앙 정렬 + 뷰포트 clamp/flip(마운트 후 실측 1회).
 */
export function CmdPageMenu({ origin }: { origin: { x: number; y: number } }) {
  const view = useUIStore((s) => s.view);
  const goTo = useUIStore((s) => s.goTo);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        origin,
        { w: window.innerWidth, h: window.innerHeight },
        { w: rect.width, h: rect.height },
        MARGIN,
        CLEARANCE,
      ),
    );
  }, [origin]);

  return (
    <div
      ref={ref}
      className="cmd-page-menu"
      data-placement={pos?.placement}
      style={
        pos
          ? { left: pos.left, top: pos.top, visibility: "visible" }
          : { left: 0, top: 0, visibility: "hidden" }
      }
      role="menu"
      aria-label="페이지 바로가기"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.view === view;
        return (
          <button
            key={item.view}
            type="button"
            className="cmd-page-menu-chip"
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            onClick={() => goTo(item.view)}
          >
            <Icon className="size-4" aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

> 참고: `goTo(view, intent = "open")`는 intent 기본값이 `"open"`이라 `goTo(item.view)` 한 줄이면 충분하다(CommandPalette의 `goTo(view, view==="settings" ? "open" : undefined)`와 효과 동일 — settings만 intent를 읽고 나머지는 무시). `goTo`는 `paletteOpen:false`만 닫고 knob `visible`은 건드리지 않으므로 "점프 후 메뉴 유지"가 자연히 성립한다.

- [ ] **Step 4: 스타일 작성**

`src/components/CmdPageMenu.css` (CmdKnob.css의 토큰/모션 재사용 — 모두 확인된 토큰):

```css
/* Cmd-hold 가로 페이지 메뉴(설계 2026-06-07). 레버(.cmd-knob)와 같은 세션, origin 기준 fixed 배치. */
.cmd-page-menu {
  position: fixed;
  z-index: 71; /* 레버(.cmd-knob = 70) 바로 위 */
  display: flex;
  flex-wrap: wrap; /* 한 줄이 넘치면 2줄로 wrap */
  justify-content: center;
  align-content: flex-start;
  gap: 6px;
  max-width: min(720px, calc(100vw - 16px));
  padding: 8px;
  border-radius: 12px;
  background: var(--color-wr-surface);
  border: 1px solid var(--color-wr-border);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.08),
    0 8px 24px rgba(0, 0, 0, 0.14);
  animation: cmd-knob-in var(--wr-motion-fast) var(--wr-ease-out) both;
}

.cmd-page-menu-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1;
  color: var(--color-wr-fg);
  background: transparent;
  border: 1px solid transparent;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--wr-motion-fast) var(--wr-ease-out),
    border-color var(--wr-motion-fast) var(--wr-ease-out);
}

.cmd-page-menu-chip:hover {
  background: var(--color-wr-hover);
}

.cmd-page-menu-chip[data-active] {
  background: var(--color-wr-hover);
  border-color: var(--color-wr-border);
  font-weight: 600;
}

.cmd-page-menu-chip svg {
  color: var(--color-wr-muted);
}
```

> `cmd-knob-in` keyframe은 `CmdKnob.css`에 정의돼 있고, `CmdKnob`가 항상 함께 마운트되므로(메뉴는 CmdKnob 안에서만 렌더) 전역으로 사용 가능하다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run src/components/CmdPageMenu.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/CmdPageMenu.tsx src/components/CmdPageMenu.css src/components/CmdPageMenu.test.tsx
git add src/components/CmdPageMenu.tsx src/components/CmdPageMenu.css src/components/CmdPageMenu.test.tsx
git commit -m "feat(cmd-knob): add CmdPageMenu horizontal page chips"
```

---

## Task 3: CmdKnob에 메뉴 배선

`CmdKnob`가 `visible`일 때 레버와 함께 `CmdPageMenu`를 같은 세션 안에서 렌더한다. 기존 레버 로직/JSX는 변경하지 않는다.

**Files:**

- Modify: `src/components/CmdKnob.tsx`

- [ ] **Step 1: import 추가**

`src/components/CmdKnob.tsx` 상단 import 블록에 추가:

```tsx
import { CmdPageMenu } from "@/components/CmdPageMenu";
```

- [ ] **Step 2: 렌더에 메뉴 추가**

`if (!visible) return null;` 이후의 `return (` 본문에서, 최상위 `<div className="cmd-knob" …>` 와 형제로 `CmdPageMenu`를 추가한다. 기존 반환 JSX를 Fragment로 감싼다:

```tsx
return (
  <>
    <div
      className="cmd-knob"
      style={{ left: origin.x, top: origin.y }}
      role="presentation"
      aria-hidden
    >
      {/* …기존 cmd-knob-base / cmd-knob-stick 내용 그대로… */}
    </div>
    <CmdPageMenu origin={origin} />
  </>
);
```

> 메뉴를 `.cmd-knob`(`pointer-events: none`) **밖**의 형제로 두는 것이 중요하다 — 칩이 클릭을 받아야 하므로 부모의 `pointer-events: none`을 상속하면 안 된다. `.cmd-page-menu`는 자체 `position: fixed`라 레이아웃상 독립적이다.

- [ ] **Step 3: 타입/린트 확인**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 error (기존 baseline 경고 외 신규 에러 없음).

- [ ] **Step 4: 전체 vitest 확인**

Run: `pnpm vitest run`
Expected: 기존 통과 수 + 8 (Task1 6 + Task2 2), 0 실패.

- [ ] **Step 5: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
pnpm exec prettier --write src/components/CmdKnob.tsx
git add src/components/CmdKnob.tsx
git commit -m "feat(cmd-knob): render CmdPageMenu alongside joystick on Cmd-hold"
```

---

## Task 4: 결정 로그 + 최종 게이트 검증

**Files:**

- Modify: `docs/decisions.md`

- [ ] **Step 1: decisions.md에 한 줄 추가**

`docs/decisions.md` 말미(append-only)에 추가:

```markdown
- 2026-06-07 Cmd-hold 페이지 메뉴: Cmd hold 시 레버와 함께 NAV_ITEMS 가로 칩 메뉴(직접 선택, icon+label)를 띄움. overlay-stack 미등록(레버와 동일 — Cmd release/blur 종료 재사용), 점프 후 메뉴 유지(goTo가 knob visible 무관). 위치=clampMenuPosition 순수 함수(중앙 정렬+clamp+above/below flip). 순수 프런트, IPC/마이그레이션 무영향. 스펙: docs/superpowers/specs/2026-06-07-cmd-page-menu-design.md.
```

- [ ] **Step 2: 전체 게이트 실행(실제 출력 관찰)**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm vitest run
```

Expected: typecheck 0 error / lint 신규 에러 0(baseline 경고만) / vitest 전부 green(+8).

- [ ] **Step 3: Tauri 부팅 스모크(가능하면)**

Run: `pnpm tauri dev` (백그라운드) → 부팅 로그 패닉 없음 확인 후 종료.
주의: 네이티브 WKWebView GUI 클릭 스모크(레버+메뉴 동시 등장 / 칩 호버·클릭 점프 / Cmd 유지 연속 점프 / Cmd release 닫힘 / 화면 가장자리 clamp·flip / 레버 드래그 발사 유지)는 에이전트 불가 → **사용자/cmux**가 수행. 실행 못 한 항목은 "could not run"으로 명시.

- [ ] **Step 4: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add docs/decisions.md
git commit -m "docs(decisions): log Cmd-hold page menu"
```

---

## Self-Review (작성자 체크)

- **Spec coverage:** 동작(직접 선택·icon+label·활성표시·호버/클릭·Cmd유지/release종료·레버 비충돌)=Task2/3, 레이아웃(중앙·wrap·clamp·flip·flash방지)=Task1+Task2, 구조/파일=Task1–3, 불변(keymap/레버/IPC 무변경)=Task3 범위 한정 + Task4 게이트, 테스트/검증=각 Task Step + Task4, 문서=Task4. 모든 스펙 섹션에 대응 Task 존재.
- **Placeholder scan:** 모든 코드 스텝에 실제 코드/명령/기대출력 포함. TBD/TODO 없음.
- **Type consistency:** `clampMenuPosition`/`MenuPosition`(left/top/placement) Task1 정의 → Task2 동일 사용. `NAV_ITEMS`(view/label/icon) `nav.ts` 실제 필드. `useUIStore` selector(`s.view`/`s.goTo`), `goTo(view)` 시그니처 일치. `origin: {x,y}` Task2/3 일치.

---

## Review Bar / 별도 패스

- self-approve 금지: 구현 완료 후 INVARIANT(`docs/areas/decision-rails.md`) 위반 여부 + 코드 헬스를 **별도 reviewer/critic 패스**로 확인한 뒤에만 done.
- 푸시 정책(사용자 지시): **자동 push 금지** — 사용자가 명시적으로 요청할 때만 dev에 push.
