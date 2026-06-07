# Cmd-hold 페이지 메뉴 (joystick 동반 가로 메뉴)

- 날짜: 2026-06-07
- 상태: 설계 승인 (구현 대기)
- 범위: 프런트엔드 전용 (`src/components/CmdKnob.tsx` 영역). IPC/Rust/마이그레이션 무관.
- 관련 도메인: `docs/areas/frontend-shell.md` (전역 단축키/오버레이), `DESIGN.md` (시각 토큰)

## 문제 / 기대 영향

현재 Cmd(Win: Ctrl)를 ~300ms hold 하면 커서 위치에 오락실 조이스틱 "레버"(`CmdKnob`)가
뜨고, 방향으로 밀어 keymap 단축키를 발사한다. 기본값상 ←/→ = **인접 뷰 한 칸씩** 이동이라,
원하는 페이지로 가려면 여러 번 밀어야 한다.

사용자는 Cmd hold 시 **레버와 함께 가로로 펼쳐지는 페이지 선택 메뉴**가 보이길 원한다.
모든 페이지를 한눈에 보고 마우스로 바로 점프할 수 있게 한다. 레버는 그대로 유지한다.

기대 영향: Cmd hold 한 번으로 임의 페이지에 직접 도달(인접 스텝 불필요). 키 학습 부담 없이
시각적으로 전체 네비를 노출.

## 비목표 (YAGNI)

- 레버(조이스틱)의 방향 발사·기본 keymap(Cmd+←/→ 인접 nav, ↑/↓)은 **변경하지 않는다**.
- 메뉴에 대한 키보드 화살표 네비게이션(메뉴 항목 간 키 포커스 이동)은 도입하지 않는다.
  상호작용은 마우스 호버/클릭 + 레버. (Cmd가 눌린 상태라 키 입력은 레버 세션이 무시함.)
- 페이지 재정렬·고정·검색 입력 등 메뉴 커스터마이즈 없음. 목록은 `NAV_ITEMS` 정본 그대로.
- 새 단축키/keymap 키 추가 없음.

## 동작 (Behavior)

1. Cmd(Win: Ctrl) hold → 기존 dwell 세션(`useCmdKnob`)이 `visible`이 될 때:
   - 커서 위치(origin)에 **조이스틱 레버는 기존과 동일하게** 렌더.
   - 그 위쪽(공간 부족 시 아래쪽)에 **페이지 칩이 가로로** 펼쳐진다.
2. 칩 = `NAV_ITEMS`의 **아이콘 + 라벨**. 별도 목록을 만들지 않고 정본을 매핑한다(11개:
   캡처보드 / Today / Weekly / 회고 / 루틴 / PR Radar / Worktree / Jobs / 스킬 / 컨트롤룸 / 설정).
3. **현재 보고 있는 뷰** 칩은 활성 표시(하이라이트).
4. 칩 **호버** → 강조. 칩 **클릭** → `goTo(view)`로 즉시 점프.
5. **Cmd를 계속 누르고 있으면 레버+메뉴 유지** → 연속 점프 가능. **Cmd release →
   레버+메뉴 함께 닫힘**(기존 `useCmdKnob`의 trigger keyup / blur / visibilitychange 종료 경로
   그대로 사용 — 별도 종료 로직 추가 없음).
6. 마우스로 칩을 클릭해도 레버 발사와 충돌하지 않는다: 레버는 stick의 `mousedown`으로만
   `draggingRef`가 켜지고, 칩 클릭은 stick이 아니므로 레버의 window `mouseup` 핸들러가
   `draggingRef.current === false`로 early-return 한다.

### 종료/세션 경계 (기존 자산 재사용)

- 닫힘은 전적으로 `useCmdKnob`의 `visible`에 종속. 메뉴는 별도 dismiss 상태를 갖지 않는다.
- overlay-stack에 **등록하지 않는다**(레버와 동일 정책). Esc 처리 불필요 — Cmd release로 종료.
- `goTo`는 `paletteOpen:false` 등만 건드리고 `visible`(knob)을 닫지 않으므로 "점프 후 메뉴 유지"가
  자연히 성립한다.

## 레이아웃 (Layout)

- 커서 origin 기준 **위쪽**, origin.x를 중심으로 가로 정렬.
- 한 줄이 뷰포트보다 넓으면 **2줄로 wrap**(`flex-wrap`). 칩 크기는 컴팩트하게.
- 좌우 가장자리를 넘으면 좌/우 가장자리에 닿도록 **clamp**(margin 유지).
- origin이 화면 상단에 가까워 위 공간이 부족하면 레버 **아래쪽**으로 배치(flip).
- 위치 계산은 순수 함수로 분리:
  `clampMenuPosition(origin, viewport, menuSize, margin) -> { left, top, placement }`
  - `placement: "above" | "below"`.
  - 메뉴 실측 크기(`menuSize`)는 마운트 후 `ref`로 측정해 `useLayoutEffect`에서 1회 반영
    (첫 프레임 flash 방지: 측정 전엔 가시성을 억제하거나 off-screen 위치로 둔다).

## 구조 / 파일

### 편집

- `src/components/CmdKnob.tsx`
  - `useCmdKnob()`를 **여전히 한 번만** 호출(리스너/세션 단일화 유지).
  - `visible`일 때 기존 레버 `<div class="cmd-knob">` 와 함께 신규
    `<CmdPageMenu origin={origin} />`를 렌더(같은 세션에 종속).
  - 레버 관련 로직/JSX는 변경하지 않는다.

### 신규

- `src/components/CmdPageMenu.tsx`
  - props: `origin: { x: number; y: number }`.
  - `useUIStore`에서 `view`(활성 표시), `goTo`(점프) 구독.
  - `NAV_ITEMS`를 매핑해 칩(버튼) 렌더. 각 칩: `<Icon/>` + 라벨, `aria-label`,
    `data-active={item.view === view || undefined}`.
  - `clampMenuPosition`으로 컨테이너 위치 인라인 style.
  - onClick → `goTo(item.view, item.view === "settings" ? "open" : undefined)`
    (CommandPalette와 동일 idiom).
- `src/components/CmdPageMenu.css` (또는 Tailwind 유틸로 대체)
  - DESIGN.md 토큰 준수: white surface, `border-border` hairline(검은 테두리 금지),
    Media Lift shadow, 칩은 상단 nav/팔레트 톤과 일치(`text-wr-subtle` 아이콘,
    hover `bg-accent`, 활성 칩 강조). 마케팅 전용 스타일 금지.
- `src/lib/cmdPageMenuPosition.ts` (순수)
  - `clampMenuPosition(...)` 구현. `knobGeometry.ts`와 동일하게 순수 + 단위 테스트.

## 영향 없음 / 불변 유지

- keymap · `KNOB_DIRECTIONS` · `KNOB_TRIGGER_*` · 레버 ↑↓←→ · 기본 Cmd+←/→ 인접 nav: 무변경.
- IPC / `bindings.ts` / 마이그레이션 / Rust: 무관(순수 프런트 추가).
- `NAV_ITEMS`는 읽기만 — 정본 수정 없음.
- overlay-stack 카운터 무관(미등록).

## 테스트 / 검증

- 단위(vitest):
  - `cmdPageMenuPosition.test.ts` — 중앙 정렬, 좌/우 가장자리 clamp, 상단 부족 시 below flip.
  - `CmdPageMenu` 렌더 테스트 — `NAV_ITEMS` 수만큼 칩 렌더, 활성 칩 표시, 칩 클릭 시 `goTo`가
    해당 view로 호출됨(설정은 intent `"open"`).
- 게이트: `pnpm typecheck` · `pnpm lint` · `pnpm vitest run` (전부 green).
- 통합: `pnpm tauri dev` 부팅 확인.
- 라이브 스모크(네이티브 WKWebView — 에이전트 불가, 사용자/cmux):
  Cmd hold → 레버+메뉴 동시 등장 / 칩 호버·클릭 점프 / Cmd 유지 시 연속 점프 / Cmd release 닫힘 /
  화면 상단·좌우 가장자리에서 clamp·flip / 레버 드래그 발사가 여전히 동작.

## 위험 / 롤백

- 위험: 11개 아이콘+라벨 칩이 작은 창에서 넓을 수 있음 → 2줄 wrap + clamp로 완화.
- 위험: 메뉴 첫 프레임 위치 측정 전 flash → 측정 전 가시성 억제로 완화.
- 롤백: `CmdKnob.tsx`에서 `<CmdPageMenu/>` 한 줄 제거 + 신규 파일 삭제로 완전 원복(레버 무영향).

## 문서 업데이트

- 작은 Phase 트레이드오프 한 줄을 `docs/decisions.md`에 남긴다(메뉴=직접 선택, overlay-stack
  미등록, Cmd release 종료 재사용).
