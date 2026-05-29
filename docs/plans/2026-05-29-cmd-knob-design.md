# Cmd-Knob — 오락실 조이스틱 단축키 런처 (Design)

> 상태: design / 승인 대기. 구현 계획은 `2026-05-29-cmd-knob-plan.md`(예정)로 분리.
> 관련 도메인: `docs/areas/frontend-shell.md`(App 셸 / 전역 오버레이 / keymap),
> `DESIGN.md`(Cohere white editorial), `src/lib/hotkey.ts`(단축키 spec 포맷).

## 1. 문제 / 동기

좌우 뷰 전환은 이미 `Cmd+←/→`(→ `useViewShortcuts` → `navigateView` 워크스페이스 슬라이드)로
가능하다. 사용자는 **마우스만으로** 이 전환을 — 그리고 임의의 단축키를 — 발사하고 싶어 한다.
모티브는 **오락실 조이스틱**: 호출 키를 누르고 있으면 커서 위치에 스틱이 떠서, 잡아서 상하좌우로
밀면 그 방향에 지정된 단축키가 실행된다.

핵심 결정: **knob은 동작의 의미를 모른다.** 각 방향에 사용자가 설정한 단축키 combo를 합성
`KeyboardEvent`로 발사할 뿐이고, 실제 처리는 기존 전역 핸들러가 한다. 덕분에:

- 위/아래의 의미를 코드가 정할 필요가 없다(사용자가 설정에서 지정).
- ←=`Cmd+Left`면 **기존 슬라이드 애니메이션이 그대로** 재사용된다.
- 앞으로 추가되는 어떤 단축키든 별도 작업 없이 knob으로 발사 가능하다.

## 2. 비목표 (YAGNI)

- 대각선 8방향 — 4방향(↑↓←→)만. (추후 확장 여지만 남긴다.)
- 한 번 밀어 여러 칸 연속 이동(hold-repeat) — 한 번 밀기 = 한 번 발사. 여러 칸은 밀고-떼고-다시.
- OS 전역(앱 비포커스 시) 동작 — 앱 윈도 안에서만.
- 방향별 "1:1 라이브 스크럽 미리보기" — 임의 단축키엔 일반화 불가(아래 §7 트레이드오프).
- IPC/Rust/bindings 변경 — 전부 프런트 + 기존 keymap 저장소.

## 3. 사용자 흐름

1. **호출**: 설정된 모디파이어(기본 ⌘)를 **단독으로** ~300ms 누르고 있는다.
   - 그 사이 다른(비-모디파이어) 키가 눌리면 즉시 취소 → 기존 `Cmd+K`/`Cmd+,` 등 무손상.
   - 텍스트 입력/`contenteditable` 포커스 중이거나 오버레이(팔레트/Dialog/Drawer)가 열려 있으면 억제.
2. **등장**: 커서 좌표에 조이스틱이 스프링-인. 베이스(받침) + 중앙의 볼-탑 스틱.
3. **잡기**: 스틱 노브에 `mousedown` → 포인터를 따라 스틱이 **1:1로 기울어진다**(throw 반경 제한,
   가장자리로 갈수록 스프링 저항감).
4. **조준**: 한 축의 편향이 임계(스틱 반경의 ~55%)를 넘으면 그 방향 가이드가 `armed`로 강조된다.
   해당 방향에 단축키가 설정돼 있지 않으면 armed 되지 않는다(시각적으로 비활성).
5. **발사**: `mouseup` 시 `armed`면 그 방향 combo를 발사하고 스틱이 중앙으로 복귀.
   임계 미만에서 떼면 발사 없이 스냅백(취소).
6. **해제**: 모디파이어를 떼면(드래그 중이라도) knob이 페이드-아웃하며 사라진다(발사 안 함).

상태 머신: `idle → arming(dwell 중) → visible → dragging → (armed) → firing → visible`
(발사 후엔 모디파이어가 여전히 눌려 있으므로 `visible`로 복귀 — 밀고-떼고-다시 가능).
종료는 `모디파이어 release → idle`.

**취소-온-키는 `arming` 단계에서만.** dwell 중 비-모디파이어 키가 오면 그 hold 세션의 dwell을
취소한다(→ `Cmd+K`/`Cmd+,` 등 무손상; 재시도는 모디파이어 release 후 재-press). **일단 `visible`이
되면 키로는 취소하지 않는다** — 그래야 knob이 §6에서 발사하는 **자기 합성 keydown에 스스로
취소되지 않는다**(이 자기-취소가 audit에서 드러난 실제 버그). `visible` 이후 유일한 종료는
모디파이어 release.

dwell 게이트는 설정된 모디파이어 집합이 **정확히** 눌린 상태(추가 모디파이어·비모디파이어 키 없음)
에서만 시작한다. 모디파이어 키는 macOS에서 auto-repeat keydown이 없으므로 한 번의 keydown으로
타이머를 건다.

## 4. 방향 → 단축키 매핑 (설정)

- 설정의 keymap 섹션에 **"조이스틱 방향"** 그룹을 추가. 4행(`↑ ↓ ← →`), 각 행은 기존 hotkey
  레코더 위젯을 재사용해 combo("Cmd+Left" 류)를 기록/표시한다.
- **기본값**: `←=Cmd+Left`, `→=Cmd+Right`, `↑/↓ = 빈값`(미설정·비활성). 빈값은 그 방향 비활성.
- 저장 형태는 기존 keymap과 동일한 `Record<string, string>`에 새 키로 추가:
  `knob_up`, `knob_down`, `knob_left`, `knob_right` → combo 문자열.
  (단, 의미는 "이 액션의 트리거 단축키"가 아니라 "이 방향이 **발사할** 단축키" — 설정 UI 라벨로 구분.)
- **뷰 전환(인접 nav)을 노릴 땐 `Cmd+Left`/`Cmd+Right`처럼 shift/alt 없는 조합**이어야 한다.
  `useViewShortcuts`의 화살표 핸들러가 `!altKey && !shiftKey`를 요구하기 때문(audit risk #2).
  `Cmd+Shift+Right` 등으로 바꾸면 nav 핸들러를 안 타고 일반 keymap combo 경로로 빠지며, 그 combo가
  keymap에 없으면 무동작. 설정 UI에 이 주의 문구를 노출한다.

## 5. 호출 키(트리거) 설정

- 설정에 **"조이스틱 호출 키"** 항목 추가 — 모디파이어 칩 토글(`⌘ ⌃ ⌥ ⇧`). 단일 또는 조합 허용.
- 기본값 `⌘`(Meta). 저장 형태: 모디파이어 spec 문자열(예: `"Cmd"`, `"Cmd+Shift"`) — keymap에
  예약 키 `knob_trigger`로 저장.
- 기존 hotkey 레코더는 비-모디파이어 키를 요구하므로 **모디파이어 전용 칩 피커**를 별도로 둔다.
- dwell 감지는 이 설정된 모디파이어 집합이 **정확히** 눌린 상태(그 외 키 없음)를 기준으로 한다.

## 6. 아키텍처 / 모듈 경계

| 단위                                    | 책임                                                                | 의존                                     |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| `src/lib/dispatchHotkey.ts`             | combo spec → 합성 `KeyboardEvent("keydown")` 생성·`window` dispatch | `hotkey.ts` SPECIALS 역매핑              |
| `src/lib/useCmdKnob.ts` (hook)          | 트리거 dwell 감지 · 커서 좌표 · 드래그 상태 머신 · 발사 결정        | keymap(`useNavKeymap`), `dispatchHotkey` |
| `src/components/CmdKnob.tsx` (+ `.css`) | 조이스틱 렌더 · tilt/스프링 모션 · armed 가이드 · 등장/해제         | `useCmdKnob`                             |
| `nav.ts`                                | `KNOB_DIRECTIONS`(4) 메타 + 기본 keymap 엔트리(`knob_*`)            | —                                        |
| 설정 UI(`settings/…`)                   | "조이스틱 방향" 4행 + "호출 키" 칩 피커 섹션                        | keymap 저장(기존 경로)                   |

- `CmdKnob`은 App에 **전역 1회 마운트**(다른 전역 오버레이 — `CalendarDrawer`/`ToastHost`/`AgentRunModal`
  옆). 보이지 않을 땐 `null` 렌더.
- `dispatchHotkey`는 순수 함수에 가깝게: spec 파싱 → `{key, ctrlKey, metaKey, altKey, shiftKey}`
  → `new KeyboardEvent("keydown", {…, bubbles:true, cancelable:true})` → `window.dispatchEvent`.
  화살표는 `key:"ArrowLeft"`(useViewShortcuts가 `e.key`로 직접 비교) 등 SPECIALS 역매핑 필수.

## 7. 트레이드오프 / 위험

- **1:1 스크럽 미리보기 포기**: 방향별로 임의 단축키를 허용하면(↑=Cmd+K 등) 드래그 진행률을
  화면 전환에 1:1로 매핑할 수 없다. 그래서 **스틱은 1:1로 기울되**, 화면 전환은 발사된 단축키가
  소유한다(좌우는 기존 슬라이드 그대로). 스틱의 tactile 1:1 + 발사 후 기존 모션 = 일관.
- **합성 이벤트 신뢰성**: `useViewShortcuts`/App `onKeyDown`이 읽는 필드(`key`, `metaKey`,
  `ctrlKey`, `altKey`, `shiftKey`)만 채우면 충분. `isTrusted=false`지만 앱 내부 핸들러는
  무관(브라우저 기본 단축키를 노리는 게 아님). 무한 루프 없음(단발 dispatch, knob은 keydown 비소비).
- **트리거 오발**: ⇧ 단독 트리거 + 타이핑 충돌 → 입력 포커스 중 억제로 방어. dwell + 비모디파이어
  키 취소로 일반 조합키 무손상.
- **reduced-motion**: tilt/스프링/슬라이드 모두 `prefers-reduced-motion`에서 축소(기존 motion.css 관례).
- **bounded**: 타이머(dwell)·리스너는 cleanup. 무한 retry/poll 없음(INVARIANT 부합).

## 8. 검증 (done-criteria 후보)

- ⌘ ~300ms hold → 커서 위치에 knob 등장; ⌘+K는 knob 안 뜨고 팔레트 토글(취소 동작).
- 스틱을 ← 임계 너머로 밀고 떼면 이전 뷰로 기존 슬라이드 전환; → 는 다음 뷰.
- 설정에서 ↑=`Cmd+1` 지정 후 ↑ 밀기 → board로 이동.
- 설정에서 호출 키를 `⌃`로 바꾸면 ⌘ hold는 무반응, ⌃ hold에 knob 등장.
- 입력 필드 포커스 중 / 팔레트 열림 중 hold → knob 억제.
- `prefers-reduced-motion`에서 tilt·스프링 축소.
- `pnpm typecheck` · `pnpm lint` · `pnpm vitest run`(있으면 knob 유닛) green; `bindings.ts` drift 0.
