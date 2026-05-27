# Today×Timeline PR 3 — Shell, TimelineView 제거, Read-only 캔버스

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/timeline` 라우트와 `TimelineView` 완전 제거. 새 TodayView 셸(좌측 트레이 + 우측 빈 시간축, 드래그 없음, read-only) 도입. Work Debt를 헤더 칩으로 흡수.

**Architecture:** `src/components/today/` 신규 폴더 — TodayHeader, UnscheduledTray, TimelineCanvas. 이번 PR은 read-only 셸만 — 블록 렌더는 PR 4, 드래그는 PR 5. `@dnd-kit/core` 의존성도 본 PR에 추가하되 활성 사용은 PR 5부터.

**Tech Stack:** React 18, Tailwind v4, shadcn/ui, lucide-react.

**Spec:** §3, §8, §D1~D4, §D13. **Depends on:** PR 1 (bindings에 신규 필드 보임).

---

### Task 1: TimelineView 제거 + 라우트 정리

**Files:**

- Delete: `src/components/TimelineView.tsx`, `src/components/TimelineView.css`
- Modify: `src/lib/nav.ts`, `src/App.tsx`

- [ ] **Step 1: 파일 삭제**

```bash
git rm src/components/TimelineView.tsx src/components/TimelineView.css
```

- [ ] **Step 2: `src/lib/nav.ts`에서 timeline 라우트 제거**

Run: `grep -n "timeline" src/lib/nav.ts`. 해당 라인 + 라벨 + 아이콘 import 제거.

- [ ] **Step 3: `src/App.tsx`에서 import와 case 제거**

Run: `grep -n "TimelineView\|timeline" src/App.tsx`. import 제거, route case 제거.

- [ ] **Step 4: 타입체크**

```bash
pnpm typecheck
```

Expected: 통과 (남은 참조 없음).

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "refactor(today): remove TimelineView, absorbed into Today (PR 3/7)"
```

---

### Task 2: `@dnd-kit` 의존성 추가

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: 설치**

```bash
pnpm add @dnd-kit/core @dnd-kit/utilities
```

Expected: 두 패키지 추가됨.

- [ ] **Step 2: 타입체크 + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: 통과.

- [ ] **Step 3: 커밋**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add @dnd-kit/core for timeline drag (PR 3/7)"
```

---

### Task 3: TodayHeader — debt 흡수

**Files:**

- Create: `src/components/today/TodayHeader.tsx`

- [ ] **Step 1: 작성**

```tsx
import { ChevronLeft, ChevronRight, Flame, Inbox, TriangleAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stepDate } from "@/lib/calendarRange";
import { useUIStore } from "@/store";

type DebtCounts = {
  unclassified?: number;
  q1Overdue?: number;
  staleBacklog?: number;
  cleanupNeeded?: number;
};

type Props = {
  date: string;
  today: string;
  debt: DebtCounts;
  onDateChange: (d: string) => void;
};

const CHIPS: Array<{
  key: keyof DebtCounts;
  label: string;
  icon: React.ReactNode;
  tone: "urgent" | "warn" | "muted";
  go: "board" | "radar";
}> = [
  {
    key: "unclassified",
    label: "미분류",
    icon: <Inbox className="size-3.5" />,
    tone: "warn",
    go: "board",
  },
  {
    key: "q1Overdue",
    label: "Q1 overdue",
    icon: <Flame className="size-3.5" />,
    tone: "urgent",
    go: "board",
  },
  {
    key: "staleBacklog",
    label: "stale",
    icon: <TriangleAlert className="size-3.5" />,
    tone: "warn",
    go: "board",
  },
  {
    key: "cleanupNeeded",
    label: "cleanup",
    icon: <Trash2 className="size-3.5" />,
    tone: "muted",
    go: "radar",
  },
];

export function TodayHeader({ date, today, debt, onDateChange }: Props) {
  const { goTo } = useUIStore();
  const isToday = date === today;
  return (
    <header className="today-head" data-tauri-drag-region>
      <span className="today-title">Today</span>
      <div className="today-nav">
        <Button
          variant="outline"
          size="sm"
          className="size-[26px] shrink-0 p-0"
          aria-label="이전 날짜"
          onClick={() => onDateChange(stepDate("day", date, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="today-date">{date}</span>
        <Button
          variant="outline"
          size="sm"
          className="size-[26px] shrink-0 p-0"
          aria-label="다음 날짜"
          onClick={() => onDateChange(stepDate("day", date, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-[26px] rounded-full px-3 text-[12px]"
          disabled={isToday}
          onClick={() => onDateChange(today)}
        >
          오늘로
        </Button>
      </div>
      <div className="today-debt-chips">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`today-debt-chip today-debt-${c.tone}`}
            onClick={() => goTo(c.go)}
            title={c.label}
          >
            {c.icon}
            <span>{c.label}</span>
            <span className="today-debt-num">{debt[c.key] ?? "—"}</span>
          </button>
        ))}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: 타입체크**

```bash
pnpm typecheck
```

Expected: 통과.

- [ ] **Step 3: 커밋**

```bash
git add src/components/today/TodayHeader.tsx
git commit -m "feat(today): TodayHeader with absorbed debt chips (PR 3/7)"
```

---

### Task 4: UnscheduledTray (read-only)

**Files:**

- Create: `src/components/today/UnscheduledTray.tsx`

- [ ] **Step 1: 작성**

```tsx
import { useState } from "react";
import { Calendar, CheckCircle2, ChevronDown, ChevronRight, Circle, Repeat } from "lucide-react";
import type { CalendarEvent, WorkSignal } from "@/bindings";
import type { TodayRoutineItem } from "@/lib/query";
import { calendarColorStyle } from "@/lib/projectCalendarColor";

type Props = {
  unscheduledTodays: WorkSignal[];
  unscheduledRoutines: TodayRoutineItem[];
  allDayEvents: CalendarEvent[];
  onToggleDone: (id: string, done: boolean) => void;
  onToggleRoutine: (routineId: string, done: boolean) => void;
};

export function UnscheduledTray({
  unscheduledTodays,
  unscheduledRoutines,
  allDayEvents,
  onToggleDone,
  onToggleRoutine,
}: Props) {
  const [allDayOpen, setAllDayOpen] = useState(false);
  const empty =
    unscheduledTodays.length === 0 && unscheduledRoutines.length === 0 && allDayEvents.length === 0;

  return (
    <aside className="today-tray">
      <div className="today-tray-head">미배치</div>
      <div className="today-tray-body">
        {empty && <div className="today-tray-empty">모든 항목이 시간축에 배치됐어요.</div>}
        {unscheduledTodays.map((s) => (
          <div key={`s-${s.id}`} className="today-tray-row" data-kind="today">
            <button
              type="button"
              className="today-tray-check"
              aria-label={s.completedAt ? "완료 취소" : "완료"}
              onClick={() => onToggleDone(s.id, !s.completedAt)}
            >
              {s.completedAt ? (
                <CheckCircle2 className="text-q2 size-4" />
              ) : (
                <Circle className="text-wr-subtle size-4" />
              )}
            </button>
            <span className="today-tray-title">{s.title}</span>
            <span className="today-tray-tag tag-today">Today</span>
          </div>
        ))}
        {unscheduledRoutines.map((r) => (
          <div key={`r-${r.id}`} className="today-tray-row" data-kind="routine">
            <button
              type="button"
              className="today-tray-check"
              aria-label={r.done ? "완료 취소" : "완료"}
              onClick={() => onToggleRoutine(r.id, !r.done)}
            >
              {r.done ? (
                <CheckCircle2 className="text-q2 size-4" />
              ) : (
                <Circle className="text-wr-subtle size-4" />
              )}
            </button>
            <Repeat className="text-wr-subtle size-3.5" />
            <span className="today-tray-title">{r.title}</span>
          </div>
        ))}
        {allDayEvents.length > 0 && (
          <div className="today-tray-section">
            <button
              type="button"
              className="today-tray-section-head"
              onClick={() => setAllDayOpen((v) => !v)}
            >
              {allDayOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <Calendar className="size-3.5" />
              <span>종일</span>
              <span className="today-tray-count">{allDayEvents.length}</span>
            </button>
            {allDayOpen && (
              <div className="today-tray-allday">
                {allDayEvents.map((e) => (
                  <span
                    key={e.id}
                    className="today-tray-chip"
                    style={calendarColorStyle(e.projectColor, e.projectTextColor)}
                    title={e.calendarSummary}
                  >
                    {e.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: 타입체크 (TodayRoutineItem import 경로 확인)**

```bash
pnpm typecheck
```

Expected: 통과. 안 통과면 `useTodayRoutines` 반환 타입을 export하도록 `src/lib/query/index.ts` 손봐.

- [ ] **Step 3: 커밋**

```bash
git add src/components/today/UnscheduledTray.tsx src/lib/query/
git commit -m "feat(today): UnscheduledTray read-only (PR 3/7)"
```

---

### Task 5: TimelineCanvas — 빈 시간 그리드 + now line

**Files:**

- Create: `src/components/today/TimelineCanvas.tsx`

- [ ] **Step 1: 작성**

```tsx
import { useEffect, useState } from "react";

const HOUR_PX = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  date: string;
  today: string;
};

function nowOffsetPx(): number {
  const d = new Date();
  return (d.getHours() + d.getMinutes() / 60) * HOUR_PX;
}

export function TimelineCanvas({ date, today }: Props) {
  const [nowPx, setNowPx] = useState<number>(() => nowOffsetPx());

  useEffect(() => {
    if (date !== today) return;
    const t = setInterval(() => setNowPx(nowOffsetPx()), 60_000);
    return () => clearInterval(t);
  }, [date, today]);

  const showNow = date === today;

  return (
    <div className="today-canvas" data-date={date}>
      <div className="today-canvas-grid" style={{ height: `${24 * HOUR_PX}px` }}>
        {HOURS.map((h) => (
          <div key={h} className="today-canvas-hour" style={{ top: `${h * HOUR_PX}px` }}>
            <span className="today-canvas-hour-label">{String(h).padStart(2, "0")}:00</span>
            <div className="today-canvas-hour-rule" />
          </div>
        ))}
        {showNow && (
          <div className="today-canvas-now" style={{ top: `${nowPx}px` }} aria-label="현재 시각" />
        )}
        {/* 블록 레이어는 PR 4에서 추가 */}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입체크 + 커밋**

```bash
pnpm typecheck
git add src/components/today/TimelineCanvas.tsx
git commit -m "feat(today): TimelineCanvas read-only grid + now line (PR 3/7)"
```

---

### Task 6: 새 TodayView 셸

**Files:**

- Modify: `src/components/TodayView.tsx`
- Replace: `src/components/TodayView.css`

- [ ] **Step 1: TodayView 재작성**

```tsx
import { useMemo, useState } from "react";
import "./TodayView.css";
import { TodayHeader } from "@/components/today/TodayHeader";
import { UnscheduledTray } from "@/components/today/UnscheduledTray";
import { TimelineCanvas } from "@/components/today/TimelineCanvas";
import { Button } from "@/components/ui/button";
import {
  localToday,
  localWeekday,
  useCalendarEvents,
  useProjects,
  useToday,
  useTodayOverview,
  useTodayRoutines,
  useToggleRoutineCheck,
  useToggleTodayDone,
} from "@/lib/query";
import { useUIStore } from "@/store";

export function TodayView() {
  const { goTo } = useUIStore();
  const today = localToday();
  const weekday = localWeekday();
  const [date, setDate] = useState<string>(today);

  const overview = useTodayOverview(today);
  const events = useCalendarEvents(date);
  const todayRail = useToday(today);
  const routines = useTodayRoutines(today, weekday);
  const projectsQ = useProjects();
  const toggleDone = useToggleTodayDone();
  const toggleRoutine = useToggleRoutineCheck();

  const noCalendarsConfigured = useMemo(() => {
    const projects = projectsQ.data ?? [];
    if (projectsQ.isLoading || projects.length === 0) return false;
    return projects.every((p) => {
      const ids = p.googleCalendarIds?.trim();
      return !ids || ids === "[]";
    });
  }, [projectsQ.data, projectsQ.isLoading]);

  const all = events.data ?? [];
  const allDay = all.filter((e) => e.allDay);
  const rail = todayRail.data ?? [];
  const unscheduledTodays = rail.filter((s) => !s.scheduledAt);
  const routineList = routines.data ?? [];
  const unscheduledRoutines = routineList.filter((r) => !r.timeOverride && !r.timeOfDay);

  return (
    <div className="today">
      <TodayHeader
        date={date}
        today={today}
        debt={overview.data?.workDebt ?? {}}
        onDateChange={setDate}
      />
      <div className="today-main">
        <UnscheduledTray
          unscheduledTodays={unscheduledTodays}
          unscheduledRoutines={unscheduledRoutines}
          allDayEvents={allDay}
          onToggleDone={(id, done) => toggleDone.mutate({ id, date: today, done })}
          onToggleRoutine={(routineId, done) =>
            toggleRoutine.mutate({ routineId, date: today, done })
          }
        />
        <div className="today-canvas-wrap">
          {noCalendarsConfigured ? (
            <div className="today-canvas-cta">
              <p>Google 계정이 연결되지 않았습니다.</p>
              <Button onClick={() => goTo("settings")}>Google 계정 연결</Button>
            </div>
          ) : (
            <TimelineCanvas date={date} today={today} />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS 재작성 — 셸 + 트레이 + 캔버스**

`src/components/TodayView.css` 전체 교체 (디자인 시안 §1 따라). 핵심 그리드:

```css
.today {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--wr-bg);
}
.today-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--wr-border-light);
}
.today-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.today-nav {
  display: flex;
  align-items: center;
  gap: 6px;
}
.today-date {
  font-family:
    ui-monospace,
    SF Mono,
    monospace;
  font-size: 13px;
  min-width: 96px;
  text-align: center;
}
.today-debt-chips {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.today-debt-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 11px;
  border: 1px solid var(--wr-border-light);
  background: #fff;
}
.today-debt-chip .today-debt-num {
  font-weight: 700;
}
.today-debt-urgent {
  color: #b8413a;
  border-color: #ecc2bf;
}
.today-debt-warn {
  color: #b58b1f;
  border-color: #eddfaa;
}
.today-debt-muted {
  color: var(--wr-subtle);
}

.today-main {
  display: grid;
  grid-template-columns: 280px 1fr;
  flex: 1;
  min-height: 0;
}
.today-tray {
  border-right: 1px solid var(--wr-border-light);
  overflow-y: auto;
}
.today-tray-head {
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--wr-subtle);
  border-bottom: 1px solid var(--wr-border-light);
}
.today-tray-body {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.today-tray-empty {
  padding: 16px;
  color: var(--wr-subtle);
  font-size: 12px;
}
.today-tray-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: #fff;
  border: 1px solid var(--wr-border-light);
  border-radius: 6px;
}
.today-tray-title {
  flex: 1;
  font-size: 12px;
}
.today-tray-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 9999px;
}
.tag-today {
  background: #eef3ff;
  color: #4a7bb8;
}
.today-tray-section-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--wr-subtle);
}
.today-tray-count {
  margin-left: auto;
}
.today-tray-allday {
  padding: 0 8px 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.today-tray-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--wr-border-light);
  background: #fff;
}

.today-canvas-wrap {
  position: relative;
  overflow-y: auto;
  background: #fff;
}
.today-canvas {
  position: relative;
  min-height: 100%;
}
.today-canvas-grid {
  position: relative;
  padding-left: 60px;
}
.today-canvas-hour {
  position: absolute;
  left: 0;
  right: 0;
  height: 60px;
}
.today-canvas-hour-label {
  position: absolute;
  left: 8px;
  top: -7px;
  font-size: 10px;
  color: var(--wr-subtle);
  font-family: ui-monospace, monospace;
}
.today-canvas-hour-rule {
  position: absolute;
  left: 60px;
  right: 0;
  top: 0;
  height: 1px;
  background: var(--wr-border-light);
}
.today-canvas-now {
  position: absolute;
  left: 60px;
  right: 0;
  height: 2px;
  background: #e0584a;
  z-index: 5;
}
.today-canvas-now::before {
  content: "";
  position: absolute;
  left: -4px;
  top: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e0584a;
}
.today-canvas-cta {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  height: 100%;
}

@media (max-width: 1040px) {
  .today-main {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
  .today-tray {
    border-right: 0;
    border-bottom: 1px solid var(--wr-border-light);
    max-height: 200px;
  }
}
```

- [ ] **Step 3: tauri dev 스모크**

```bash
pnpm tauri dev
```

Expected: 부팅, Today 화면이 새 레이아웃으로 표시됨 (좌 트레이 + 우 빈 시간축 + 헤더 debt 칩 4개). 일정·블록은 아직 안 보임 (PR 4에서).

- [ ] **Step 4: 타입체크 + lint + vitest**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```

Expected: 통과.

- [ ] **Step 5: 커밋**

```bash
git add src/components/TodayView.tsx src/components/TodayView.css
git commit -m "feat(today): new shell (header + tray + canvas), debt absorbed (PR 3/7)"
```

---

### Task 7: 통합 검증 + push

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

- ✅ Spec §D1 timeline 라우트/뷰 완전 제거
- ✅ Spec §D2 좌 트레이 + 우 시간축 레이아웃
- ✅ Spec §D3 트레이 = Today 시간없음 + 루틴 시간없음 + 종일(접힘)
- ✅ Spec §D13 Work Debt 헤더 흡수
- ✅ Spec §D14 @dnd-kit 도입 (다음 PR에서 사용)
- ✅ 캘린더 미연결 graceful degrade 유지
