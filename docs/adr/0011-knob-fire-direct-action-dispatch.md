---
adr-id: ADR-0011
status: accepted
date: 2026-06-11
decision-makers: [yangha.park]
tags: [frontend-shell, keymap, cmd-knob, shortcuts, ipc-none]
supersedes:
---

# 0011. knob fire의 합성 keydown 버스 폐기 — 일급 AppAction 디스패치

## Context and Problem Statement

**Scope**: `src/lib/{appActions,useViewShortcuts,useCmdKnob}.ts`, `src/components/CmdKnob.tsx`,
`src/App.tsx` (Rust/IPC 무변경).

Cmd-hold 조이스틱(knob)의 방향 발사는 합성 `KeyboardEvent`를 `window`에 dispatch하고
(`dispatchHotkey`), `useViewShortcuts`가 그 이벤트를 문자열 spec으로 되-매칭해 액션을
실행하는 구조였다. 의도가 타입 없는 전역 사이드채널을 왕복하면서 실제로 다음 결함들이
발생했다(2026-06-11 라이브 디버깅으로 전부 관찰):

- **자기-매칭**: keymap 한 네임스페이스에 액션 바인딩(`board: "Cmd+1"`)과 knob 설정
  (`knob_up: "Cmd+Up"` = "쏠 콤보")이 섞여 있어, knob ↑ fire(`Cmd+Up`)가 keymap 매칭에서
  **자기 자신**(`knob_up`)과 매칭 → `onAction("knob_up")` → `as View` 캐스팅으로 store
  view가 무효값으로 오염 → `adjacentView(무효값)`이 현재값을 그대로 반환해 좌/우 네비가
  전부 no-op("위/아래 거치면 좌/우 사망", 뷰를 다시 고르면 복구돼 간헐로 위장).
- **리스너 순서 의존**: 소비가 window keydown 리스너들의 등록 순서 +
  `stopImmediatePropagation` 암묵 계약에 좌우된다(HermesView의 "마지막 등록" 전제는
  child effect가 parent보다 먼저 돌아 성립하지 않음).
- **키 라벨 왕복**: dispatcher와 matcher가 `"Left"↔"ArrowLeft"` 변환 규약을 공유해야 한다.
- **관측 불가**: 유닛(기하학/매칭/디스패치)은 전부 green인데 기능은 죽는 유닛-사이 버그 —
  발사→소비 사이를 검증하는 테스트를 쓸 수 없었다.

## Decision

합성 keydown 경로를 제거하고 **일급 액션 디스패치**로 교체한다.

- `src/lib/appActions.ts`(신규): `AppAction` 유니온(`navigate`/`adjacent`/
  `toggle-calendar`/`toggle-inbox`) + 순수 리졸버.
  - `findKeymapAction(map, combo)`: combo→액션 키. **knob 예약 키 제외**(자기-매칭 차단).
  - `actionForKeymapKey(key)`: 등록 view/액션만 `AppAction`으로 — 무효 키(제거된 view 등)는
    null. `as View` 캐스팅 경로 자체가 사라진다.
  - `resolveCombo(map, spec)`: 하드코딩 인접 네비(`Cmd/Ctrl+←/→`)를 keymap보다 먼저
    해석(런타임 매처와 동일 우선순위).
- `App.dispatchAction`: 액션 실행 단일 chokepoint. `useViewShortcuts`(물리 키보드)와
  `useCmdKnob.fire`(knob)가 같은 함수로 수렴.
- knob fire: 콤보 → `resolveCombo` → `dispatchAction` **인프로세스 직행**.
  `dispatchHotkey.ts` 삭제.

## Consequences

- 자기-매칭/리스너 순서/라벨 왕복 결함 부류가 구조적으로 소멸. `fire(dir)→store 변화`를
  DOM 이벤트 없이 헤드리스로 테스트 가능.
- **의도적 좁힘**: knob 콤보는 이제 keymap 액션 + 인접 네비만 의미를 가진다. 종전엔 합성
  이벤트라 하드코딩 단축키(예: `Cmd+K` 팔레트)도 knob으로 발사 가능했지만, 그 범용성이
  정확히 버그의 원인이었다. 필요해지면 해당 액션을 `AppAction`에 추가하는 게 정도(正道).
- 후속 후보(별도 결정): ① knob 방향을 콤보 문자열 대신 액션에 직접 바인딩(Settings
  드롭다운)+저장 keymap 마이그레이션, ② window keydown 리스너 4곳(App/useViewShortcuts/
  useCmdKnob/Hermes)의 명시적 우선순위 키보드 매니저 통합.

## Validation

- `pnpm typecheck` 0 / `pnpm vitest run` 전체 green(appActions 신규 테스트 포함,
  knob 자기-매칭 콤보 → null end-to-end 가드).
- `fire(dir)→store 변화` 헤드리스 테스트는 이 구조가 **가능하게 만든** 것이고 아직 작성
  전(deferred) — 현재 커버리지는 리졸버 순수 함수 레벨.
- 라이브 스모크(knob 4방향 + 물리 Cmd+←/→)=사용자.
