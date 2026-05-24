# PR A — 매트릭스 중앙 BrainDump 토글 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 매트릭스 캔버스 중앙(사분면 교차점)에 BrainDump 토글 pill을 두고, 클릭 시 가로 인라인 확장으로 기존 캡처 입력(개인/업무 토글 + 텍스트 + 붙이기 버튼)을 호출한다. 하단 풀폭 `<CapturePanel />`은 제거하고, 그 자리에 PR C에서 뉴스 티커가 채울 placeholder를 둔다.

**Architecture:**
신규 `BrainDumpToggle` 컴포넌트가 캡처 폼 상태/제출 로직을 캡슐화한다(`useState`로 open/value/pendingKind 관리, 기존 `parseDump` 헬퍼 재사용). `MatrixCanvas`의 `.canvas` 컨테이너 안에 절대 위치 중앙 자식으로 마운트한다. 단일 소비처(CaptureBoard 하단)였던 `CapturePanel`은 삭제하고, 그 자리에 PR C용 placeholder 슬롯을 둔다(`<div className="news-ticker-slot">`).

**Tech Stack:** React 18, TypeScript, Tailwind v4 + custom CSS tokens, lucide-react(`Sparkles`), shadcn `ToggleGroup`·`Button`, Tauri 2.

---

## File Structure

| 파일 | 변경 | 책임 |
|---|---|---|
| `src/components/board/BrainDumpToggle.tsx` | **Create** | 중앙 pill 토글 + 펼친 캡처 폼(상태·submit). |
| `src/components/board/CapturePanel.tsx` | **Delete** | 단일 소비처(`CaptureBoard` 하단) 제거됨 → 자체 dead. |
| `src/components/board/MatrixCanvas.tsx` | **Modify** | props에 `onCapture`/`captureInputRef`/`captureDisabled` 추가, `.canvas` 안에 `<BrainDumpToggle />` 절대 중앙 마운트. |
| `src/components/CaptureBoard.tsx` | **Modify** | 캡처 props를 `MatrixCanvas`로 전달, 하단 `<CapturePanel />` 제거, `<div className="news-ticker-slot">` placeholder. import 정리. |
| `src/styles.css` | **Modify** | `.brain-dump-toggle*` 신규, `.news-ticker-slot` 신규, **죽은 `.cb .capture*`/`.cb .capture .bd`/`.cb .capture input.dump` 및 @media `.cb .capture .bd` 룰 제거**. |

---

## Pre-flight

- [ ] **Step 0: 브랜치 생성 + dev 최신화**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
rtk git fetch origin
rtk git checkout dev && rtk git pull --ff-only
rtk git checkout -b feat/brain-dump-toggle
```

Expected: clean `dev` working tree, new branch `feat/brain-dump-toggle` checked out.

---

## Task 1 — `BrainDumpToggle` 컴포넌트 작성

**Files:**
- Create: `src/components/board/BrainDumpToggle.tsx`

- [ ] **Step 1.1: 새 파일 작성**

```tsx
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import type { Kind } from "@/bindings";
import { parseDump } from "@/components/board/board-utils";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Props = {
  /** kind = 파싱된 마커 우선, 없으면 토글 기본값. */
  onSubmit: (title: string, kind: Kind) => void;
  disabled?: boolean;
  /** CaptureBoard가 단축키(F)로 포커스를 요청할 때 사용. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

/**
 * 매트릭스 캔버스 중앙(사분면 교차점)에 떠 있는 BrainDump 토글 pill.
 * collapsed: `Sparkles` 아이콘 + 'BRAIN' caps 라벨.
 * expanded: 개인/업무 ToggleGroup + 입력 + 붙이기(기존 CapturePanel과 동일 폼).
 * 외부 클릭 / Esc(빈 입력일 때만) / submit 후 → collapsed로 복귀.
 * 입력 중일 때 Esc는 collapse 대신 입력 유지(사용자 데이터 보호).
 */
export function BrainDumpToggle({ onSubmit, disabled, inputRef }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [pendingKind, setPendingKind] = useState<Kind>("work");
  const rootRef = useRef<HTMLDivElement>(null);
  const innerInputRef = useRef<HTMLInputElement>(null);
  // 외부에서 inputRef를 받으면 그것을 사용(단축키 포커스), 없으면 내부 ref.
  const effectiveInputRef = inputRef ?? innerInputRef;

  // collapsed → expanded 전환 시 입력에 자동 포커스(단축키 흐름과 동일 UX).
  useEffect(() => {
    if (open) {
      effectiveInputRef.current?.focus();
    }
  }, [open, effectiveInputRef]);

  // 외부 클릭으로 collapse(빈 입력일 때만). pointerdown으로 모달 동작 직전에 잡는다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      if (value.trim().length === 0) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open, value]);

  const submit = () => {
    const raw = value;
    if (!raw.trim()) return;
    const { kind, text } = parseDump(raw);
    if (!text) return;
    onSubmit(text, kind ?? pendingKind);
    setValue("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") {
      if (value.trim().length === 0) {
        setOpen(false);
        // 트리거 버튼으로 포커스 복원은 collapse 후 다음 tick에 처리.
      }
    }
  };

  if (!open) {
    return (
      <div ref={rootRef} className="brain-dump-toggle">
        <button
          type="button"
          className="bd-pill"
          onClick={() => setOpen(true)}
          aria-label="브레인 덤프 열기"
          title="브레인 덤프"
        >
          <Sparkles aria-hidden className="bd-icon" size={14} />
          <span className="bd-label">BRAIN</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="brain-dump-toggle is-open">
      <span className="bd-label" aria-hidden>
        BRAIN
      </span>
      {/* 개인/업무 2-state 세그먼트 — 기존 CapturePanel과 동일 의미색 매핑. */}
      <ToggleGroup
        type="single"
        value={pendingKind}
        onValueChange={(v) => v && setPendingKind(v as Kind)}
        className="shrink-0 overflow-hidden rounded-full border border-wr-border-light"
      >
        <ToggleGroupItem
          value="personal"
          size="sm"
          className="font-semibold text-wr-subtle data-[state=on]:bg-wr-accent-soft data-[state=on]:text-wr-accent"
        >
          개인
        </ToggleGroupItem>
        <ToggleGroupItem
          value="work"
          size="sm"
          className="font-semibold text-wr-subtle data-[state=on]:bg-wr-pale-green data-[state=on]:text-wr-green"
        >
          업무
        </ToggleGroupItem>
      </ToggleGroup>
      {/* .dump = 기존 보더리스 캡처 필드(shadcn Input은 6+ 오버라이드+링 회귀라 bespoke 유지, AGENTS.md ≤3 규율). */}
      <input
        ref={effectiveInputRef}
        className="dump"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="예) '일, 데모 준비' · '개인, 원두 주문' — Enter로 톡"
        autoComplete="off"
        autoFocus
      />
      <Button type="button" size="pill" onClick={submit} disabled={disabled}>
        붙이기
      </Button>
    </div>
  );
}
```

- [ ] **Step 1.2: typecheck 확인**

Run:
```bash
rtk tsc --noEmit 2>&1 | tail -10
```
Expected: `TypeScript compilation completed` (no errors). 새 파일은 아직 import되지 않아 dead이지만 컴파일은 통과해야 한다.

---

## Task 2 — `.brain-dump-toggle` CSS 추가

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 2.1: capture 블록 옆에 새 룰 삽입**

찾을 위치: `.cb .capture input.dump::placeholder` 룰 바로 다음(라인 ~820, "카드 액션 메뉴" 주석 직전).

삽입 텍스트:

```css

/* ── Brain Dump 토글(매트릭스 중앙 pill) ──
   collapsed=아이콘+BRAIN 라벨 작은 캡슐, expanded=가로 확장으로 개인/업무·input·붙이기 인라인.
   .canvas 안에 절대 위치(translate −50%)로 정중앙. z=20(카드 위, cmdk 90 아래). */
.brain-dump-toggle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border: 1px solid var(--color-wr-border-light);
  background: var(--color-wr-bg);
  border-radius: 9999px;
  box-shadow:
    0 1px 0 rgba(10, 14, 30, 0.02),
    0 6px 16px rgba(10, 14, 30, 0.06);
  transition:
    box-shadow 0.18s ease,
    border-color 0.18s ease,
    padding 0.18s ease;
}
.brain-dump-toggle .bd-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 9999px;
  color: var(--color-wr-fg);
}
.brain-dump-toggle .bd-icon {
  color: var(--color-wr-coral);
}
.brain-dump-toggle .bd-label {
  font: 700 10px var(--font-mono);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--color-wr-fg);
}
.brain-dump-toggle:hover {
  border-color: var(--color-wr-coral-soft);
  box-shadow:
    0 1px 0 rgba(10, 14, 30, 0.02),
    0 10px 22px rgba(255, 119, 89, 0.14);
}
/* expanded — 가로 확장 + 인라인 폼. width는 컨텐츠 기준 자동 + min으로 안정. */
.brain-dump-toggle.is-open {
  padding: 8px 14px;
  gap: 10px;
  min-width: 420px;
  max-width: min(640px, 80%);
}
.brain-dump-toggle.is-open .dump {
  flex: 1;
  min-width: 160px;
  border: none;
  outline: none;
  background: transparent;
  font: 400 14px var(--font-sans);
  color: var(--color-wr-fg);
  padding: 4px 2px;
}
.brain-dump-toggle.is-open .dump::placeholder {
  color: var(--color-wr-subtle);
}

/* PR C에서 뉴스 티커가 차지할 슬롯 — PR A 동안에는 안내 텍스트만. */
.cb .news-ticker-slot {
  flex: 0 0 auto;
  height: 40px;
  margin: 0 16px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 400 12px var(--font-mono);
  letter-spacing: 0.04em;
  color: var(--color-wr-subtle);
  border-top: 1px dashed var(--color-wr-border);
  background: transparent;
}
```

- [ ] **Step 2.2: typecheck 확인 (CSS만이지만 빌드 단위 확인)**

Run:
```bash
rtk tsc --noEmit 2>&1 | tail -5
```
Expected: 0 errors.

---

## Task 3 — `MatrixCanvas`에서 BrainDumpToggle 마운트

**Files:**
- Modify: `src/components/board/MatrixCanvas.tsx`

- [ ] **Step 3.1: import 추가**

`src/components/board/MatrixCanvas.tsx` 상단 import 영역에 추가:

```tsx
import { BrainDumpToggle } from "@/components/board/BrainDumpToggle";
import type { Kind } from "@/bindings";
```

- [ ] **Step 3.2: Props 타입 확장**

기존 `type Props = { ... }` 블록 끝에 추가:

```tsx
  /** 매트릭스 중앙 BrainDump 토글에서 캡처 제출. */
  onCapture: (title: string, kind: Kind) => void;
  /** 단축키(F)가 포커스 잡을 입력 ref. */
  captureInputRef?: React.RefObject<HTMLInputElement | null>;
  /** create_signal 진행 중 — 붙이기 버튼 disable. */
  captureDisabled?: boolean;
```

- [ ] **Step 3.3: 함수 signature destructure에 새 props 추가**

`export function MatrixCanvas({...}` 의 destructure 목록 끝에 추가:

```tsx
  onCapture,
  captureInputRef,
  captureDisabled,
```

- [ ] **Step 3.4: `.canvas` 안에 마운트**

`<div className="canvas" ref={canvasRef}>` 직후, 포스트잇 영역 시작 전에 삽입:

```tsx
        {/* 캔버스 정중앙 BrainDump 토글 — 사분면 교차점 위에 떠 있음(z=20).
            클릭 시 가로 확장으로 캡처 폼 인라인 표시(외부클릭/빈Esc로 collapse). */}
        <BrainDumpToggle
          onSubmit={onCapture}
          disabled={captureDisabled}
          inputRef={captureInputRef}
        />
```

- [ ] **Step 3.5: typecheck 확인**

Run:
```bash
rtk tsc --noEmit 2>&1 | tail -10
```
Expected: 새 props가 required인데 호출처(`CaptureBoard`)에서 아직 전달 안 함 → 에러 발생 예상. **다음 task에서 호출처 수정으로 해결**. 그래도 메시지 한 줄 캡쳐:
> Property 'onCapture' is missing in type ... but required in type 'Props'.

이 에러는 Task 4 종료 시점에 사라져야 한다.

---

## Task 4 — `CaptureBoard`에서 props 전달, 하단 패널 제거, placeholder 추가

**Files:**
- Modify: `src/components/CaptureBoard.tsx`

- [ ] **Step 4.1: `CapturePanel` import 제거**

19번째 줄 근처:
```tsx
import { CapturePanel } from "@/components/board/CapturePanel";
```
를 **삭제**.

- [ ] **Step 4.2: MatrixCanvas 호출처에 capture props 추가**

`<MatrixCanvas ... />` 호출(약 506번째 줄)을 찾아 props에 추가:

```tsx
<MatrixCanvas
  signals={signals}
  selectedId={selectedId}
  poppedIds={poppedIds}
  // ...기존 props...
  todayPanelRef={todayPanelRef}
  // 신규 — 중앙 BrainDump 토글로 라우팅:
  onCapture={handleCapture}
  captureInputRef={captureInputRef}
  captureDisabled={createSignal.isPending}
/>
```

기존 다른 props는 그대로. 정확한 위치는 grep으로 `<MatrixCanvas` 찾아 닫는 태그 직전.

- [ ] **Step 4.3: 하단 `<CapturePanel />` 호출 블록을 placeholder로 교체**

569–573번 줄 부근:

```tsx
<CapturePanel
  onSubmit={handleCapture}
  disabled={createSignal.isPending}
  inputRef={captureInputRef}
/>
```

를 아래로 **교체**:

```tsx
{/* 하단 풀폭 슬롯 — PR C에서 뉴스 티커로 채워짐. 그 전까지 안내 placeholder. */}
<div className="news-ticker-slot" aria-label="뉴스 티커 자리 (PR C에서 활성화)">
  뉴스 티커 자리 — PR C에서 활성화
</div>
```

- [ ] **Step 4.4: typecheck 확인**

Run:
```bash
rtk tsc --noEmit 2>&1 | tail -10
```
Expected: `TypeScript compilation completed` (0 errors). Task 3에서 발생한 missing props 에러가 해소되어야 한다.

- [ ] **Step 4.5: lint 확인**

Run:
```bash
pnpm lint 2>&1 | tail -15
```
Expected: exit code 0. 신규 에러 0 (49 baseline 경고 유지).

---

## Task 5 — 죽은 `CapturePanel` + 옛 캡처 CSS 제거

**Files:**
- Delete: `src/components/board/CapturePanel.tsx`
- Modify: `src/styles.css`

- [ ] **Step 5.1: CapturePanel 사용처 확인 (안전망)**

Run:
```bash
grep -rn "from \"@/components/board/CapturePanel\"\|from \"./CapturePanel\"\|CapturePanel" /Users/davidpark/private_project/work-radar/src 2>/dev/null
```
Expected: 결과 0건. 1건 이상이면 Task 4가 누락 → 그 호출처 먼저 정리.

- [ ] **Step 5.2: 파일 삭제**

```bash
cd /Users/davidpark/private_project/work-radar
rm src/components/board/CapturePanel.tsx
```

- [ ] **Step 5.3: 죽은 CSS 제거**

`src/styles.css`에서 아래 블록(라인 787~819 근처) **전부 삭제**:

```css
/* 하단 캡처 패널 */
.cb .capture {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  /* 풀폭 너무 휑함 → 가운데 정렬 + 가독 폭으로 캡. 측여백 16px 보존(작은 창에서). */
  width: calc(100% - 32px);
  max-width: 640px;
  margin: 0 auto 16px;
  padding: 12px 14px;
  border: 1px solid var(--color-wr-border-light);
  border-radius: var(--cb-r-lg);
  background: var(--color-wr-bg);
  box-shadow: 0 10px 30px rgba(10, 14, 30, 0.08);
}
.cb .capture .bd {
  font: 700 10px var(--font-mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--color-wr-coral);
}
.cb .capture input.dump {
  flex: 1;
  min-width: 160px;
  border: none;
  outline: none;
  background: transparent;
  font: 400 16px var(--font-sans);
  color: var(--color-wr-fg);
  padding: 6px 2px;
}
.cb .capture input.dump::placeholder {
  color: var(--color-wr-subtle);
}
```

- [ ] **Step 5.4: 반응형 media query에서 죽은 `.cb .capture .bd` 룰 제거**

라인 972~979 부근:

```css
@media (max-width: 560px) {
  .cb .execute {
    flex-direction: column;
  }
  .cb .capture .bd {
    display: none;
  }
}
```

를 아래로 **교체**(`.capture .bd` 룰만 제거, execute는 유지):

```css
@media (max-width: 560px) {
  .cb .execute {
    flex-direction: column;
  }
}
```

- [ ] **Step 5.5: CSS에 `.cb .capture` 잔존 참조 0건 확인**

Run:
```bash
grep -n "\.cb \.capture\|\.cb\.capture" /Users/davidpark/private_project/work-radar/src/styles.css
```
Expected: 결과 0건.

- [ ] **Step 5.6: typecheck + lint 다시 확인**

Run (병렬):
```bash
rtk tsc --noEmit 2>&1 | tail -5
pnpm lint 2>&1 | tail -10
```
Expected: 둘 다 0 errors. (bindings 변경 없음 — Rust 무관)

---

## Task 6 — 시각/통합 검증 + cmux 스모크

**Files:** none (런타임 검증)

- [ ] **Step 6.1: `pnpm tauri dev`로 앱 부팅**

Run:
```bash
pnpm tauri dev
```
앱 창이 뜨면 **CaptureBoard** 뷰를 연다. 시각 확인:

| 항목 | 기대 |
|---|---|
| 매트릭스 중앙 | `Sparkles` 아이콘 + `BRAIN` 라벨의 작은 pill이 사분면 교차점에 떠 있음 |
| pill hover | 보더 코랄, soft glow |
| pill 클릭 | 가로로 확장, 개인/업무 토글 + 입력 + 붙이기 버튼 인라인 표시, 입력 자동 포커스 |
| 텍스트 입력 후 Enter | 카드가 미분류로 생성됨, pill collapsed로 복귀, 입력 비워짐 |
| 빈 입력 상태 Esc | pill collapsed로 복귀 |
| 입력에 텍스트 있는 상태 Esc | collapse 안 됨(데이터 보호), 입력 유지 |
| 빈 입력 상태 외부 클릭 | pill collapsed로 복귀 |
| 입력에 텍스트 있는 상태 외부 클릭 | collapse 안 됨(데이터 보호) |
| 하단 | "뉴스 티커 자리 — PR C에서 활성화" 한 줄, dashed top border |

- [ ] **Step 6.2: cmux 브라우저 스모크 (있는 경우)**

`/oh-my-claudecode:cmux` 또는 cmux MCP가 활성화된 경우, BrainDumpToggle expanded 상태에서 Esc → collapse + `window.hide` 미호출 + 트리거 포커스 복원을 확인. (모달 슬라이스 hard gate — AGENTS.md shadcn 규율.) cmux 없으면 수동 확인.

- [ ] **Step 6.3: 검증 명령 풀세트**

Run:
```bash
rtk tsc --noEmit 2>&1 | tail -5
pnpm lint 2>&1 | tail -10
export PATH="$HOME/.cargo/bin:$PATH" && cd /Users/davidpark/private_project/work-radar/src-tauri && rtk cargo test --lib 2>&1 | tail -10
```
Expected:
- typecheck: `TypeScript compilation completed`
- lint: exit 0 (49 baseline)
- cargo test: PR A는 Rust 무관이라 변경 없이 통과해야 한다(`test result: ok. ...`).

---

## Task 7 — 커밋 & push dev

**Files:** 변경된 5개(+1 삭제) git add

- [ ] **Step 7.1: git status 확인**

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git status -sb
```
Expected:
```
## feat/brain-dump-toggle
 M src/components/CaptureBoard.tsx
 M src/components/board/MatrixCanvas.tsx
 M src/styles.css
 D src/components/board/CapturePanel.tsx
?? src/components/board/BrainDumpToggle.tsx
```

- [ ] **Step 7.2: 커밋**

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH" && \
rtk git add src/components/board/BrainDumpToggle.tsx \
            src/components/board/CapturePanel.tsx \
            src/components/board/MatrixCanvas.tsx \
            src/components/CaptureBoard.tsx \
            src/styles.css && \
rtk git commit -m "feat(ui): 매트릭스 중앙 BrainDump 토글 (PR A)

- 신규 BrainDumpToggle: Sparkles+BRAIN pill, 클릭 시 가로 확장으로
  개인/업무 토글 + 입력 + 붙이기를 인라인 호출 (기존 parseDump 재사용)
- MatrixCanvas: .canvas 안 절대 중앙(translate −50%, z=20)에 마운트
- CaptureBoard: 하단 풀폭 <CapturePanel /> 제거 → news-ticker-slot
  placeholder (PR C에서 채움)
- CapturePanel.tsx 삭제(단일 소비처 정리), 죽은 .cb .capture* CSS 제거
- 외부클릭/빈Esc로 collapse, 텍스트 있을 때는 보호(데이터 안 잃음)

INVARIANT #1 무관(표시/입력 UX만, 결정 레일 무침투).
검증: typecheck 0·lint 0 errors(49 baseline)·cargo test pass."
```

- [ ] **Step 7.3: dev로 fast-forward + push**

브랜치 전략 결정:
- (a) 직접 dev로 머지(메모리 "work-radar push to dev only" 패턴): 작은 PR 이므로 가능
- (b) PR로 띄움: 작업 가시성 위함

기본 (a):
```bash
export PATH="$HOME/.cargo/bin:$PATH" && \
rtk git checkout dev && \
rtk git merge --ff-only feat/brain-dump-toggle && \
rtk git push origin dev
```
Expected: `ok ✓ dev`.

- [ ] **Step 7.4: decisions.md 한 줄 추가 (별도 커밋)**

`docs/decisions.md` 끝에 추가:

```
- **PR A — 매트릭스 중앙 BrainDump 토글 머지**: 매트릭스 캔버스 정중앙(사분면 교차점)에 `BrainDumpToggle` pill(`Sparkles`+'BRAIN' caps). 클릭 시 가로 확장으로 기존 캡처 폼(개인/업무 토글·input·붙이기 — `parseDump` 재사용) 인라인 호출. 외부 클릭/빈Esc로 collapse, 입력에 텍스트 있을 땐 보호(데이터 안 잃음). 단일 소비처였던 `CapturePanel.tsx`는 삭제, 하단 풀폭은 `news-ticker-slot` placeholder로 교체(PR C 대기). INVARIANT #1 무관(표시/입력 UX). 검증: typecheck 0·lint 0(49 baseline)·cargo test pass. dev push.
```

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH" && \
rtk git add docs/decisions.md && \
rtk git commit -m "docs(decisions): PR A 머지 기록" && \
rtk git push origin dev
```

---

## Done-criteria (spec §4 매핑)

| spec 요구 | task |
|---|---|
| 매트릭스 중앙 pill(Sparkles+BRAIN) | Task 1, 2, 3 |
| 클릭 → 가로 확장 → 입력 자동 포커스 | Task 1 (useEffect on open) |
| 외부 클릭 / 빈Esc → collapse | Task 1 (pointerdown listener + keydown) |
| Enter 후 collapse + 입력 비움 | Task 1 (submit() → setOpen(false)) |
| z-index: 카드(<10) < pill(20) < cmdk(90) | Task 2 (z-index: 20) |
| 하단 placeholder | Task 4 + Task 2 (`.news-ticker-slot`) |
| 옛 `.cb .capture*` 제거 | Task 5 |
| 검증: typecheck/lint/cargo test/cmux 스모크 | Task 6 |

---

## Self-Review

**1. Spec coverage:** 위 표 참조. PR A에 해당하는 spec §4 항목 전부 task 매핑됨.

**2. Placeholder scan:** TBD/TODO/"implement later" 등 0건. 모든 step에 실제 코드/명령/기대값 포함.

**3. Type consistency:** `Kind`는 `@/bindings`에서 import(이미 CapturePanel/SprintTimer가 쓰는 정식 타입). `BrainDumpToggle`의 `onSubmit` 시그니처는 기존 `CapturePanel`의 `onSubmit`(라인 10)과 동일 — 호출처 `handleCapture`는 그대로 사용. `inputRef`는 `React.RefObject<HTMLInputElement | null>`로 통일.

**4. 의존성 가드:**
- `lucide-react` `Sparkles` 아이콘 — 이미 enrich-all 버튼에서 사용 중(`docs/decisions.md` 413), 신규 의존성 0.
- `parseDump` — `@/components/board/board-utils`에 존재(현 CapturePanel에서 import).
- `ToggleGroup`/`Button` — `@/components/ui/*`에 존재.

**5. 위험:**
- 외부 pointerdown listener가 다른 모달(Dialog 등)과 충돌 가능성 → 빈 입력일 때만 close라 데이터 손실은 없음. 추후 cmux 스모크에서 모달 중첩 시 동작 확인.
- 사용자가 단축키(F)로 입력 포커스 요청 시 BrainDumpToggle이 collapsed면 입력에 포커스 못 잡음 → **다음 follow-up**: CaptureBoard 단축키 핸들러가 `setOpen(true)`도 트리거하도록 BrainDumpToggle에 imperative API 노출(useImperativeHandle) 또는 store 상태로 끌어올리기. PR A 범위 외, 사용자 피드백 후 결정.

---

## Plan complete

다음 단계 선택:

1. **Subagent-Driven (recommended)** — 각 task마다 fresh subagent 띄우고 사이에 review.
2. **Inline Execution** — 이 세션에서 task 순차 실행, 체크포인트마다 review.

진행 방식 알려주세요.
