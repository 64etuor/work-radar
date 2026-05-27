# Today×Timeline PR 4 — 블록 렌더 & 인라인 Popover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ATracker식 병렬 분할 알고리즘(`timelineLayout.ts`)을 순수함수로 작성 + 테스트. 시간축에 카드/Google 이벤트/루틴 인스턴스 블록 렌더. 블록 클릭 = 인라인 popover (편집은 기존 모달 위임). 드래그 없음.

**Architecture:** `lib/timelineLayout.ts`는 입력 `TimedBlock[]` → 출력 `LayoutBox[]` 순수함수. `TimelineBlock.tsx`가 박스 1개 렌더. `EventPopover.tsx`는 shadcn Popover. 데이터는 PR 1에서 추가된 `WorkSignal.scheduledAt/Duration/linkedEventId`와 `useCalendarEvents`/`useTodayRoutines` 조합.

**Tech Stack:** React, vitest, shadcn Popover (radix).

**Spec:** §4, §7, §8.5. **Depends on:** PR 1, PR 3.

---

### Task 1: TimedBlock 타입 + 입력 합성 함수 (TDD)

**Files:**

- Create: `src/lib/timelineLayout.ts`, `src/lib/timelineLayout.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/timelineLayout.test.ts
import { describe, it, expect } from "vitest";
import { computeLayout, type TimedBlock } from "./timelineLayout";

const make = (id: string, start: string, end: string): TimedBlock => ({
  id,
  kind: "event",
  title: id,
  startISO: start,
  endISO: end,
  calendarId: "c",
  color: "#888",
});

describe("computeLayout", () => {
  it("single block fills width", () => {
    const out = computeLayout([make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", leftPct: 0, widthPct: 100 });
  });

  it("two non-overlapping each full width", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T11:00:00", "2026-05-28T12:00:00"),
    ]);
    expect(out.find((b) => b.id === "a")!.widthPct).toBe(100);
    expect(out.find((b) => b.id === "b")!.widthPct).toBe(100);
  });

  it("two overlapping → 50/50", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:30:00"),
      make("b", "2026-05-28T10:00:00", "2026-05-28T11:00:00"),
    ]);
    expect(out.find((b) => b.id === "a")!.widthPct).toBe(50);
    expect(out.find((b) => b.id === "b")!.widthPct).toBe(50);
    expect(new Set(out.map((b) => b.leftPct))).toEqual(new Set([0, 50]));
  });

  it("three mutually overlapping → 33/33/33", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T11:00:00"),
      make("b", "2026-05-28T09:30:00", "2026-05-28T10:30:00"),
      make("c", "2026-05-28T10:00:00", "2026-05-28T11:30:00"),
    ]);
    expect(out.map((b) => Math.round(b.widthPct))).toEqual(
      [34, 33, 33].sort((x, y) => x - y).map((_, i, arr) => (i === 0 ? 34 : 33)),
    );
  });

  it("cluster boundary: a-b overlap, c separate → cluster1=50/50, c=100", () => {
    const out = computeLayout([
      make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00"),
      make("b", "2026-05-28T09:30:00", "2026-05-28T10:30:00"),
      make("c", "2026-05-28T11:00:00", "2026-05-28T12:00:00"),
    ]);
    expect(out.find((x) => x.id === "a")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "c")!.widthPct).toBe(100);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run timelineLayout
```

Expected: FAIL (모듈 없음).

- [ ] **Step 3: 최소 구현**

```ts
// src/lib/timelineLayout.ts
export type TimedBlock = {
  id: string;
  kind: "signal" | "routine" | "event";
  title: string;
  startISO: string;
  endISO: string;
  calendarId: string;
  color: string;
  linkedEventId?: string;
};

export type LayoutBox = {
  id: string;
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
  block: TimedBlock;
};

const HOUR_PX = 60;

function toMin(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

export function computeLayout(blocks: TimedBlock[]): LayoutBox[] {
  const items = [...blocks].sort((a, b) => a.startISO.localeCompare(b.startISO));
  // 1) 클러스터링: 정렬 후 sweep, 활성 max end <= current start이면 cluster 종료.
  const clusters: TimedBlock[][] = [];
  let cur: TimedBlock[] = [];
  let curMaxEnd = -Infinity;
  for (const b of items) {
    const start = toMin(b.startISO);
    if (cur.length === 0 || start < curMaxEnd) {
      cur.push(b);
      curMaxEnd = Math.max(curMaxEnd, toMin(b.endISO));
    } else {
      clusters.push(cur);
      cur = [b];
      curMaxEnd = toMin(b.endISO);
    }
  }
  if (cur.length) clusters.push(cur);

  const out: LayoutBox[] = [];
  for (const cluster of clusters) {
    // 2) 컬럼 그리디 배정.
    const cols: { end: number; idx: number }[] = []; // 각 컬럼의 현재 end
    const colOf = new Map<string, number>();
    for (const b of cluster) {
      const s = toMin(b.startISO);
      let placed = -1;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].end <= s) {
          placed = i;
          break;
        }
      }
      if (placed === -1) {
        placed = cols.length;
        cols.push({ end: 0, idx: placed });
      }
      cols[placed].end = toMin(b.endISO);
      colOf.set(b.id, placed);
    }
    const n = cols.length;
    const widthPct = 100 / n;
    for (const b of cluster) {
      const col = colOf.get(b.id)!;
      out.push({
        id: b.id,
        topPx: toMin(b.startISO) * (HOUR_PX / 60),
        heightPx: Math.max(20, (toMin(b.endISO) - toMin(b.startISO)) * (HOUR_PX / 60)),
        leftPct: col * widthPct,
        widthPct,
        block: b,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: 테스트 통과 확인 + edge case 추가**

```bash
pnpm vitest run timelineLayout
```

Expected: 첫 4개 PASS. 3중겹침 테스트는 `widthPct = 100/3 ≈ 33.33`이므로 둥글기 검증 수정 필요할 수 있음. 수정 (예: `Math.abs(b.widthPct - 100/3) < 0.01` 등).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/timelineLayout.ts src/lib/timelineLayout.test.ts
git commit -m "feat(today): timelineLayout pure fn with overlap clustering (PR 4/7)"
```

---

### Task 2: blocks 합성 — signals + events + routines

**Files:**

- Create: `src/lib/todayBlocks.ts`
- Create: `src/lib/todayBlocks.test.ts`

- [ ] **Step 1: 테스트**

```ts
// src/lib/todayBlocks.test.ts
import { describe, it, expect } from "vitest";
import { buildTodayBlocks } from "./todayBlocks";

describe("buildTodayBlocks", () => {
  it("signal with linked_event_id absorbs matching google event", () => {
    const signals = [
      {
        id: "s1",
        title: "S",
        scheduledAt: "2026-05-28T09:00:00",
        scheduledDuration: 60,
        linkedEventId: "g1",
        linkedCalendarId: "cal",
      } as any,
    ];
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarSummary: "cal",
        projectColor: "#444",
      } as any,
    ];
    const blocks = buildTodayBlocks({ signals, events, routines: [], date: "2026-05-28" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("signal");
  });

  it("google event without linked signal renders as event kind", () => {
    const events = [
      {
        id: "g1",
        title: "G",
        start: "2026-05-28T09:00:00",
        end: "2026-05-28T10:00:00",
        allDay: false,
        calendarSummary: "cal",
        projectColor: "#444",
      } as any,
    ];
    const blocks = buildTodayBlocks({ signals: [], events, routines: [], date: "2026-05-28" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("event");
  });

  it("routine with time_of_day produces virtual instance", () => {
    const routines = [{ id: "r1", title: "R", timeOfDay: "07:00", timeOverride: null } as any];
    const blocks = buildTodayBlocks({ signals: [], events: [], routines, date: "2026-05-28" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("routine");
    expect(blocks[0].startISO).toContain("07:00");
  });

  it("routine time_override wins over time_of_day", () => {
    const routines = [{ id: "r1", title: "R", timeOfDay: "07:00", timeOverride: "09:00" } as any];
    const blocks = buildTodayBlocks({ signals: [], events: [], routines, date: "2026-05-28" });
    expect(blocks[0].startISO).toContain("09:00");
  });
});
```

- [ ] **Step 2: 실패 확인 → 구현**

```ts
// src/lib/todayBlocks.ts
import type { CalendarEvent, WorkSignal } from "@/bindings";
import type { TodayRoutineItem } from "@/lib/query";
import type { TimedBlock } from "./timelineLayout";

type Input = {
  signals: WorkSignal[];
  events: CalendarEvent[];
  routines: TodayRoutineItem[];
  date: string; // YYYY-MM-DD
};

function isoFor(
  date: string,
  hhmm: string,
  durationMin = 30,
): { startISO: string; endISO: string } {
  const [h, m] = hhmm.split(":").map(Number);
  const start = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function plusMin(iso: string, m: number): string {
  return new Date(new Date(iso).getTime() + m * 60_000).toISOString();
}

export function buildTodayBlocks({ signals, events, routines, date }: Input): TimedBlock[] {
  const out: TimedBlock[] = [];
  const absorbed = new Set<string>();

  for (const s of signals) {
    if (!s.scheduledAt || !s.scheduledDuration) continue;
    out.push({
      id: `signal:${s.id}`,
      kind: "signal",
      title: s.title,
      startISO: s.scheduledAt,
      endISO: plusMin(s.scheduledAt, s.scheduledDuration),
      calendarId: s.linkedCalendarId ?? "",
      color: "#4a7bb8",
      linkedEventId: s.linkedEventId ?? undefined,
    });
    if (s.linkedEventId) absorbed.add(s.linkedEventId);
  }

  for (const e of events) {
    if (e.allDay) continue;
    if (absorbed.has(e.id)) continue;
    out.push({
      id: `event:${e.id}`,
      kind: "event",
      title: e.title,
      startISO: e.start,
      endISO: e.end ?? plusMin(e.start, 30),
      calendarId: e.calendarSummary ?? "",
      color: e.projectColor ?? "#888",
    });
  }

  for (const r of routines) {
    const time = r.timeOverride ?? r.timeOfDay;
    if (!time) continue;
    const { startISO, endISO } = isoFor(date, time, 30);
    out.push({
      id: `routine:${r.id}`,
      kind: "routine",
      title: r.title,
      startISO,
      endISO,
      calendarId: r.linkedCalendarId ?? "",
      color: "#7aa84e",
      linkedEventId: r.linkedEventId ?? undefined,
    });
  }

  return out;
}
```

- [ ] **Step 3: PASS + 커밋**

```bash
pnpm vitest run todayBlocks
git add src/lib/todayBlocks.ts src/lib/todayBlocks.test.ts
git commit -m "feat(today): buildTodayBlocks merges signals/events/routines (PR 4/7)"
```

---

### Task 3: TimelineBlock 컴포넌트

**Files:**

- Create: `src/components/today/TimelineBlock.tsx`

- [ ] **Step 1: 작성**

```tsx
import { Repeat } from "lucide-react";
import type { LayoutBox } from "@/lib/timelineLayout";

type Props = {
  box: LayoutBox;
  onClick: (box: LayoutBox, e: React.MouseEvent) => void;
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function TimelineBlock({ box, onClick }: Props) {
  const { block, topPx, heightPx, leftPct, widthPct } = box;
  return (
    <button
      type="button"
      className={`tl-block tl-block-${block.kind}`}
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        left: `calc(60px + ${leftPct}% * (100% - 60px) / 100)`,
        width: `calc(${widthPct}% * (100% - 60px) / 100 - 4px)`,
        borderLeftColor: block.color,
      }}
      onClick={(e) => onClick(box, e)}
      title={block.title}
    >
      <div className="tl-block-time">
        {hhmm(block.startISO)}–{hhmm(block.endISO)}
      </div>
      <div className="tl-block-title">
        {block.kind === "routine" && <Repeat className="mr-1 inline size-3" />}
        {block.title}
      </div>
    </button>
  );
}
```

- [ ] **Step 2: TimelineCanvas에 블록 레이어 통합**

`src/components/today/TimelineCanvas.tsx` 수정 — `boxes: LayoutBox[]`, `onBlockClick` props 받고 블록 렌더:

```tsx
type Props = {
  date: string;
  today: string;
  boxes: LayoutBox[];
  onBlockClick: (box: LayoutBox, e: React.MouseEvent) => void;
};
// ... 기존 grid 안에 추가:
{
  boxes.map((b) => <TimelineBlock key={b.id} box={b} onClick={onBlockClick} />);
}
```

- [ ] **Step 3: TodayView에서 blocks 계산 + 전달**

```tsx
const blocks = useMemo(
  () => buildTodayBlocks({ signals: rail, events: all, routines: routineList, date }),
  [rail, all, routineList, date],
);
const boxes = useMemo(() => computeLayout(blocks), [blocks]);
// ... TimelineCanvas에 boxes 전달, onBlockClick은 다음 Task에서
```

- [ ] **Step 4: CSS 추가**

`TodayView.css`에 추가:

```css
.tl-block {
  position: absolute;
  background: #fff;
  border: 1px solid var(--wr-border-light);
  border-left-width: 3px;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  text-align: left;
  overflow: hidden;
  cursor: pointer;
}
.tl-block:hover {
  background: #fafaf7;
}
.tl-block-time {
  font-size: 10px;
  color: var(--wr-subtle);
  font-family: ui-monospace, monospace;
}
.tl-block-title {
  font-weight: 500;
}
.tl-block-signal {
  background: #f6f9ff;
}
.tl-block-routine {
  background: #f6fbf2;
}
```

- [ ] **Step 5: tauri dev 스모크**

```bash
pnpm tauri dev
```

Expected: 블록이 시간축에 정확히 배치됨. 겹침 시 균등 분할. 클릭은 아직 무반응.

- [ ] **Step 6: 타입체크 + 커밋**

```bash
pnpm typecheck && pnpm vitest run
git add src/components/today/ src/components/TodayView.tsx src/components/TodayView.css
git commit -m "feat(today): render timeline blocks with overlap layout (PR 4/7)"
```

---

### Task 4: EventPopover — 인라인 조회/편집

**Files:**

- Create: `src/components/today/EventPopover.tsx`

- [ ] **Step 1: 작성 (shadcn Popover 활용)**

```tsx
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { LayoutBox } from "@/lib/timelineLayout";
import { openExternal } from "@/lib/query";

type Props = {
  open: boolean;
  box: LayoutBox | null;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  onOpenFullModal: (box: LayoutBox) => void;
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EventPopover({ open, box, anchor, onClose, onOpenFullModal }: Props) {
  if (!open || !box || !anchor) return null;
  const { block } = box;

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>
        <span
          style={{ position: "fixed", left: anchor.x, top: anchor.y, width: 1, height: 1 }}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent className="w-[280px]">
        <div className="space-y-2">
          <div className="text-sm font-semibold">{block.title}</div>
          <div className="text-wr-subtle text-xs">
            {hhmm(block.startISO)}–{hhmm(block.endISO)} · {block.calendarId || block.kind}
          </div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => onOpenFullModal(box)}>
              더보기
            </Button>
            {block.linkedEventId && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void openExternal(
                    `https://calendar.google.com/calendar/event?eid=${block.linkedEventId}`,
                  )
                }
              >
                Google에서 열기
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: TodayView에서 wiring**

```tsx
const [popover, setPopover] = useState<{ box: LayoutBox; anchor: { x: number; y: number } } | null>(
  null,
);
const handleBlockClick = (box: LayoutBox, e: React.MouseEvent) => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setPopover({ box, anchor: { x: rect.right + 8, y: rect.top } });
};
// ... pass handleBlockClick to TimelineCanvas
// ... 렌더 하단:
<EventPopover
  open={popover !== null}
  box={popover?.box ?? null}
  anchor={popover?.anchor ?? null}
  onClose={() => setPopover(null)}
  onOpenFullModal={(box) => {
    setPopover(null);
    // 기존 CalendarEventModal 또는 카드 편집 UI 호출 (signal이면 board로 jump 등 — PR 7에서 정련)
  }}
/>;
```

- [ ] **Step 3: shadcn popover가 없으면 추가**

```bash
grep -q "ui/popover" src/components/ui/*.tsx 2>/dev/null || pnpm dlx shadcn@latest add popover
```

- [ ] **Step 4: 스모크 + 커밋**

```bash
pnpm tauri dev
# 블록 클릭 → popover 뜨는지 확인 → ESC로 닫힘 확인
pnpm typecheck && pnpm vitest run
git add src/components/today/EventPopover.tsx src/components/ui/popover.tsx src/components/TodayView.tsx
git commit -m "feat(today): EventPopover inline view + 더보기 hook (PR 4/7)"
```

---

### Task 5: 통합 검증 + push

- [ ] **Step 1: 풀체크**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && pnpm lint && pnpm vitest run
```

- [ ] **Step 2: push**

```bash
git push origin dev
```

## 자체 검증

- ✅ Spec §8.5 ATracker 분할 알고리즘 + 6개 테스트
- ✅ Spec §7-row6 블록 클릭 = 인라인 popover
- ✅ 카드 정본 (linked_event_id 매칭 시 google event 흡수)
- ✅ 루틴 time_override 우선 (시각 미리 배치)
