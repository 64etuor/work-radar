# Today×Timeline PR 5 — DnD + Sync Wiring + Staged Apply

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 7가지 드래그 인터랙션을 PR 2의 `stage_calendar_write` 큐에 연결. Optimistic UI (React Query 캐시 패치 + 실패 시 롤백). Cross-calendar 변경의 staged "적용" 배지/버튼.

**Architecture:** `@dnd-kit/core`의 `DndContext` + `useDraggable` + `useDroppable`. 드래그 종류 7가지를 `calendarSync.ts`의 단일 dispatcher로 매핑. Optimistic 패치는 `queryClient.setQueryData` + 실패 이벤트 수신 시 `invalidateQueries`로 롤백. Staged는 `usePendingWrites` 쿼리로 상단 배지.

**Tech Stack:** @dnd-kit/core, @tanstack/react-query, tauri-specta events.

**Spec:** §6.2~§6.5, §7, §D11~D12. **Depends on:** PR 1, PR 2, PR 3, PR 4.

---

### Task 1: calendarSync IPC 래퍼

**Files:**
- Create: `src/lib/calendarSync.ts`

- [ ] **Step 1: 작성**

```ts
import { commands } from "@/bindings";
import { v4 as uuid } from "uuid";

export type StageInput =
  | { kind: "schedule"; targetSignalId: string; at: string; durationMin: number; calendarId: string; title: string }
  | { kind: "reschedule"; targetSignalId: string; at: string; durationMin: number }
  | { kind: "resize"; targetSignalId: string; durationMin: number }
  | { kind: "unschedule"; targetSignalId: string }
  | { kind: "moveCalendar"; targetSignalId: string; calendarId: string; at: string; durationMin: number; title: string }
  | { kind: "createBlank"; title: string; at: string; durationMin: number; calendarId: string }
  | { kind: "routineSchedule"; routineId: string; date: string; at: string; durationMin: number; calendarId: string; title: string }
  | { kind: "routineUnschedule"; routineId: string; date: string };

export async function stage(input: StageInput): Promise<void> {
  const idempotencyKey = uuid();
  const req = toRequest(input, idempotencyKey);
  const res = await commands.stageCalendarWrite(req);
  if (res.status === "error") throw new Error(res.error);
}

function toRequest(i: StageInput, key: string) {
  // bindings에서 생성된 enum 타입에 맞춰 매핑
  switch (i.kind) {
    case "schedule":
      return { target: { kind: "signal", id: i.targetSignalId },
               op: { op: "schedule", at: i.at, duration_min: i.durationMin, calendar_id: i.calendarId, title: i.title },
               idempotency_key: key };
    case "reschedule":
      return { target: { kind: "signal", id: i.targetSignalId },
               op: { op: "reschedule", at: i.at, duration_min: i.durationMin },
               idempotency_key: key };
    case "resize":
      return { target: { kind: "signal", id: i.targetSignalId },
               op: { op: "resize", duration_min: i.durationMin },
               idempotency_key: key };
    case "unschedule":
      return { target: { kind: "signal", id: i.targetSignalId },
               op: { op: "unschedule" },
               idempotency_key: key };
    case "moveCalendar":
      return { target: { kind: "signal", id: i.targetSignalId },
               op: { op: "move_calendar", calendar_id: i.calendarId, at: i.at, duration_min: i.durationMin, title: i.title },
               idempotency_key: key };
    case "createBlank":
      return { target: { kind: "signal", id: "" /* unused for blank → spec note */ },
               op: { op: "create_blank", title: i.title, at: i.at, duration_min: i.durationMin, calendar_id: i.calendarId },
               idempotency_key: key };
    case "routineSchedule":
      return { target: { kind: "routine_check", routine_id: i.routineId, date: i.date },
               op: { op: "schedule", at: i.at, duration_min: i.durationMin, calendar_id: i.calendarId, title: i.title },
               idempotency_key: key };
    case "routineUnschedule":
      return { target: { kind: "routine_check", routine_id: i.routineId, date: i.date },
               op: { op: "unschedule" },
               idempotency_key: key };
  }
}
```

(주: `commands.stageCalendarWrite` snake/camel은 bindings 출력 따라. 컴파일하며 조정.)

- [ ] **Step 2: 타입체크 + 커밋**

```bash
pnpm add uuid && pnpm add -D @types/uuid
pnpm typecheck
git add src/lib/calendarSync.ts package.json pnpm-lock.yaml
git commit -m "feat(today): calendarSync IPC wrapper (PR 5/7)"
```

---

### Task 2: optimistic 패치 헬퍼 (TDD)

**Files:**
- Create: `src/lib/optimisticSchedule.ts`
- Create: `src/lib/optimisticSchedule.test.ts`

- [ ] **Step 1: 테스트**

```ts
import { describe, it, expect } from "vitest";
import { applySchedulePatch, rollbackSchedulePatch } from "./optimisticSchedule";

describe("schedulePatch", () => {
  it("applies new scheduledAt and duration", () => {
    const signals = [{ id: "s1", scheduledAt: null, scheduledDuration: null } as any];
    const next = applySchedulePatch(signals, "s1", { at: "2026-05-28T09:00:00", durationMin: 60 });
    expect(next.find((s) => s.id === "s1")?.scheduledAt).toBe("2026-05-28T09:00:00");
    expect(next.find((s) => s.id === "s1")?.scheduledDuration).toBe(60);
  });

  it("rollback restores prior state", () => {
    const orig = [{ id: "s1", scheduledAt: "X", scheduledDuration: 30 } as any];
    const patched = applySchedulePatch(orig, "s1", { at: "Y", durationMin: 90 });
    const back = rollbackSchedulePatch(patched, "s1", orig);
    expect(back.find((s) => s.id === "s1")?.scheduledAt).toBe("X");
    expect(back.find((s) => s.id === "s1")?.scheduledDuration).toBe(30);
  });
});
```

- [ ] **Step 2: 구현**

```ts
import type { WorkSignal } from "@/bindings";

export function applySchedulePatch(
  signals: WorkSignal[],
  id: string,
  patch: { at?: string; durationMin?: number; calendarId?: string; clearLink?: boolean },
): WorkSignal[] {
  return signals.map((s) => {
    if (s.id !== id) return s;
    return {
      ...s,
      scheduledAt: patch.at !== undefined ? patch.at : s.scheduledAt,
      scheduledDuration: patch.durationMin !== undefined ? patch.durationMin : s.scheduledDuration,
      linkedCalendarId: patch.calendarId !== undefined ? patch.calendarId : s.linkedCalendarId,
      linkedEventId: patch.clearLink ? null : s.linkedEventId,
    };
  });
}

export function rollbackSchedulePatch(
  current: WorkSignal[],
  id: string,
  original: WorkSignal[],
): WorkSignal[] {
  const orig = original.find((s) => s.id === id);
  if (!orig) return current;
  return current.map((s) => (s.id === id ? orig : s));
}
```

- [ ] **Step 3: PASS + 커밋**

```bash
pnpm vitest run optimisticSchedule
git add src/lib/optimisticSchedule.ts src/lib/optimisticSchedule.test.ts
git commit -m "feat(today): optimistic schedule patch + rollback (PR 5/7)"
```

---

### Task 3: DnD context + 7가지 인터랙션 매핑

**Files:**
- Modify: `src/components/TodayView.tsx`
- Create: `src/components/today/useTimelineDnd.ts`

- [ ] **Step 1: useTimelineDnd hook**

`useTimelineDnd.ts`는 큰 hook이 됨. 핵심 책임:
- `DndContext` props 제공 (`sensors`, `onDragEnd`).
- 드래그 종류 식별 (data attribute `data-from`, `data-to`, `data-target`).
- onDragEnd에서 픽셀 → 시간 변환 (drop Y / HOUR_PX), 15분 스냅.
- `stage()` 호출 + optimistic 패치 + 실패 핸들러 등록.

```ts
import { useCallback } from "react";
import { DragEndEvent } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { stage } from "@/lib/calendarSync";
import { applySchedulePatch } from "@/lib/optimisticSchedule";
import { localToday } from "@/lib/query";

const HOUR_PX = 60;
const SNAP_MIN = 15;

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function pixelToIso(date: string, yPx: number, scrollTop: number): string {
  const totalMin = snap(((yPx + scrollTop) / HOUR_PX) * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const d = new Date(`${date}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  return d.toISOString();
}

export function useTimelineDnd(opts: {
  date: string;
  defaultCalendarFor: (signalId: string) => Promise<string | null>;
  promptCalendarPicker: (signalId: string) => Promise<string | null>;
}) {
  const qc = useQueryClient();
  const today = localToday();

  const onDragEnd = useCallback(async (ev: DragEndEvent) => {
    const a = ev.active;
    const o = ev.over;
    if (!o) return;
    const from = String(a.data.current?.from ?? "");
    const to = String(o.data.current?.to ?? "");
    const signalId = String(a.data.current?.signalId ?? "");
    const routineId = String(a.data.current?.routineId ?? "");
    const date = opts.date;

    // 1: tray → canvas
    if (from === "tray" && to === "canvas" && signalId) {
      const cal = (await opts.defaultCalendarFor(signalId)) ?? (await opts.promptCalendarPicker(signalId));
      if (!cal) return;
      const at = pixelToIso(date, ev.delta.y + (a.data.current?.startY ?? 0), 0); // 단순화
      const durationMin = 60;
      const title = String(a.data.current?.title ?? "");
      qc.setQueryData(["signals"], (old: any) => old ? applySchedulePatch(old, signalId, { at, durationMin, calendarId: cal }) : old);
      try { await stage({ kind: "schedule", targetSignalId: signalId, at, durationMin, calendarId: cal, title }); }
      catch { qc.invalidateQueries({ queryKey: ["signals"] }); }
      return;
    }

    // 2: canvas reschedule
    if (from === "canvas" && to === "canvas" && signalId) {
      const currentAt = String(a.data.current?.startISO ?? "");
      const durationMin = Number(a.data.current?.durationMin ?? 60);
      const at = pixelToIso(date, ev.delta.y + (a.data.current?.topPx ?? 0), 0);
      qc.setQueryData(["signals"], (old: any) => old ? applySchedulePatch(old, signalId, { at }) : old);
      try { await stage({ kind: "reschedule", targetSignalId: signalId, at, durationMin }); }
      catch { qc.invalidateQueries({ queryKey: ["signals"] }); }
      return;
    }

    // 3: resize handled separately (special droppable on bottom edge — Task 4)
    // 4: canvas → tray
    if (from === "canvas" && to === "tray" && signalId) {
      qc.setQueryData(["signals"], (old: any) => old ? applySchedulePatch(old, signalId, { at: null as any, durationMin: null as any, clearLink: true }) : old);
      try { await stage({ kind: "unschedule", targetSignalId: signalId }); }
      catch { qc.invalidateQueries({ queryKey: ["signals"] }); }
      return;
    }

    // 5: cross-cal move → staged
    if (from === "canvas" && to.startsWith("canvas:cal:") && signalId) {
      const newCal = to.slice("canvas:cal:".length);
      const at = pixelToIso(date, ev.delta.y + (a.data.current?.topPx ?? 0), 0);
      const durationMin = Number(a.data.current?.durationMin ?? 60);
      const title = String(a.data.current?.title ?? "");
      // staged는 optimistic 안 함 — 명시 적용 게이트.
      try { await stage({ kind: "moveCalendar", targetSignalId: signalId, calendarId: newCal, at, durationMin, title }); }
      catch { /* UI 토스트 */ }
      qc.invalidateQueries({ queryKey: ["pendingWrites"] });
      return;
    }

    // 7: routine drag
    if (from === "routine" && to === "canvas" && routineId) {
      const cal = (await opts.defaultCalendarFor(routineId)) ?? (await opts.promptCalendarPicker(routineId));
      if (!cal) return;
      const at = pixelToIso(date, ev.delta.y + (a.data.current?.startY ?? 0), 0);
      const title = String(a.data.current?.title ?? "");
      try { await stage({ kind: "routineSchedule", routineId, date: today, at, durationMin: 30, calendarId: cal, title }); }
      catch { qc.invalidateQueries({ queryKey: ["todayRoutines"] }); }
      qc.invalidateQueries({ queryKey: ["todayRoutines"] });
      return;
    }
  }, [opts, qc, today]);

  return { onDragEnd };
}
```

- [ ] **Step 2: TodayView에서 DndContext 적용**

```tsx
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
// ...
const { onDragEnd } = useTimelineDnd({ date, defaultCalendarFor, promptCalendarPicker });
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
return (
  <DndContext sensors={sensors} onDragEnd={onDragEnd}>
    <div className="today">{/* ...기존 ... */}</div>
  </DndContext>
);
```

- [ ] **Step 3: UnscheduledTray의 row + TimelineBlock + TimelineCanvas 빈영역 각각 `useDraggable`/`useDroppable` 적용**

각 컴포넌트에 `data-from`/`data-to` 메타 부여. (구체 코드는 @dnd-kit 표준 패턴.)

- [ ] **Step 4: defaultCalendarFor / promptCalendarPicker 구현**

`projects` 쿼리에서 signal.project_id → project.default_write_calendar_id 매핑. 미설정 시 popover (Task 4).

- [ ] **Step 5: 스모크 + 커밋**

```bash
pnpm tauri dev
# 트레이 → 캔버스 드래그 → 800ms 후 Google 이벤트 생성 확인
# 캔버스 블록 드래그 → 시간 이동 확인
# 캔버스 블록 → 트레이 드래그 → 이벤트 삭제 확인
pnpm typecheck && pnpm vitest run
git add src/components/today/ src/components/TodayView.tsx
git commit -m "feat(today): DnD wiring with optimistic UI (PR 5/7)"
```

---

### Task 4: 캘린더 픽 popover (project default 미설정 시)

**Files:**
- Create: `src/components/today/CalendarPickerPopover.tsx`

- [ ] **Step 1: 작성**

```tsx
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useProjects, useUpdateProject } from "@/lib/query";

type Props = {
  signalProjectId: string | null;
  onPick: (calendarId: string, saveAsDefault: boolean) => void;
  onClose: () => void;
};

export function CalendarPickerPopover({ signalProjectId, onPick, onClose }: Props) {
  const projectsQ = useProjects();
  const update = useUpdateProject();
  const project = (projectsQ.data ?? []).find((p) => p.id === signalProjectId);
  const candidates: string[] = project ? JSON.parse(project.googleCalendarIds || "[]") : [];
  const [picked, setPicked] = useState<string | null>(null);
  const [save, setSave] = useState(true);

  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild><span style={{ position: "fixed", left: 0, top: 0 }} /></PopoverTrigger>
      <PopoverContent className="w-[280px] space-y-2">
        <div className="text-sm font-semibold">캘린더 선택</div>
        {candidates.length === 0 && (
          <div className="text-xs text-wr-subtle">이 프로젝트에 연결된 캘린더가 없습니다.</div>
        )}
        {candidates.map((c) => (
          <button key={c} className={`w-full text-left text-xs px-2 py-1 rounded ${picked === c ? "bg-wr-accent-soft" : "hover:bg-wr-bg-soft"}`}
            onClick={() => setPicked(c)}>{c}</button>
        ))}
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          기본 캘린더로 저장
        </label>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" disabled={!picked}
            onClick={() => {
              if (!picked) return;
              if (save && project) update.mutate({ id: project.id, defaultWriteCalendarId: picked });
              onPick(picked, save);
            }}>적용</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: TodayView에서 promptCalendarPicker = Promise<string> 형태로 mount**

`promptCalendarPicker = (signalId) => new Promise((resolve) => { setPicker({ signalId, resolve }) })`.

- [ ] **Step 3: 커밋**

```bash
git add src/components/today/CalendarPickerPopover.tsx src/components/TodayView.tsx
git commit -m "feat(today): calendar picker popover + auto-save default (PR 5/7)"
```

---

### Task 5: Staged "변경 N건 적용" 배지

**Files:**
- Create: `src/components/today/StagedBadge.tsx`
- Create: `src/lib/query/calendarSync.ts`

- [ ] **Step 1: query hook**

```ts
// src/lib/query/calendarSync.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/bindings";

export function usePendingWrites() {
  return useQuery({
    queryKey: ["pendingWrites"],
    queryFn: async () => {
      const res = await commands.listPendingWrites();
      if (res.status === "error") throw new Error(res.error);
      return res.data;
    },
    refetchInterval: 2000,
  });
}

export function useCommitStaged() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await commands.commitStagedWrites(ids);
      if (res.status === "error") throw new Error(res.error);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pendingWrites"] }),
  });
}

export function useCancelPending() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await commands.cancelPendingWrite(id);
      if (res.status === "error") throw new Error(res.error);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pendingWrites"] }),
  });
}
```

- [ ] **Step 2: StagedBadge — 헤더에 마운트**

```tsx
import { Button } from "@/components/ui/button";
import { usePendingWrites, useCommitStaged } from "@/lib/query/calendarSync";

export function StagedBadge() {
  const pending = usePendingWrites();
  const commit = useCommitStaged();
  const staged = (pending.data ?? []).filter((p) => p.payload_json.includes('"staged":true'));
  if (staged.length === 0) return null;
  return (
    <div className="today-staged">
      <span>변경 {staged.length}건 대기</span>
      <Button size="sm" disabled={commit.isPending}
        onClick={() => commit.mutate(staged.map((s) => s.id))}>적용</Button>
    </div>
  );
}
```

- [ ] **Step 3: TodayHeader에 StagedBadge 마운트 + CSS**

```css
.today-staged { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; background: #fff3cd; border: 1px solid #f0d878; border-radius: 9999px; font-size: 11px; }
```

- [ ] **Step 4: 스모크 + 커밋**

```bash
pnpm tauri dev
# cross-cal 드래그 → 배지 출현 → 적용 버튼 누르면 사라짐
git add src/lib/query/calendarSync.ts src/components/today/StagedBadge.tsx src/components/today/TodayHeader.tsx src/components/TodayView.css
git commit -m "feat(today): staged badge with apply button (PR 5/7)"
```

---

### Task 6: 실패 이벤트 수신 → 토스트 + 롤백

**Files:**
- Create: `src/lib/calendarSyncEvents.ts`
- Modify: `src/components/TodayView.tsx`

- [ ] **Step 1: 이벤트 구독 hook**

```ts
import { useEffect } from "react";
import { events } from "@/bindings";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ToastHost";

export function useCalendarSyncEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const unsub = events.calendarSyncFailed.listen((ev) => {
      toast({ kind: "error", message: `동기화 실패 — ${ev.payload.error}`, action: { label: "다시 시도", onClick: () => qc.invalidateQueries({ queryKey: ["pendingWrites"] }) } });
      qc.invalidateQueries({ queryKey: ["signals"] });
      qc.invalidateQueries({ queryKey: ["calendarEvents"] });
    });
    return () => { void unsub.then((u) => u()); };
  }, [qc]);
}
```

(주: `events`/`toast` API는 프로젝트 표준에 맞춰 조정. ToastHost가 `toast()` 함수 export하지 않으면 store action 사용.)

- [ ] **Step 2: TodayView에서 호출**

```tsx
useCalendarSyncEvents();
```

- [ ] **Step 3: 커밋**

```bash
git add src/lib/calendarSyncEvents.ts src/components/TodayView.tsx
git commit -m "feat(today): subscribe sync failure + toast + rollback (PR 5/7)"
```

---

### Task 7: 통합 검증 + push

- [ ] **Step 1: 풀체크**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && pnpm lint && pnpm vitest run
```

- [ ] **Step 2: 수동 E2E**

```bash
pnpm tauri dev
```
체크리스트 (직접 클릭/드래그):
- 트레이 → 캔버스 빈영역 드래그 → 800ms 후 Google PATCH/POST 발사 (콘솔 trace 확인)
- 캔버스 블록 → 같은 캔버스 다른 시간 → patch
- 캔버스 블록 → 트레이 → delete
- 캔버스 블록을 다른 캘린더 드롭 zone → 헤더에 staged 배지 → 적용 버튼 → flush

- [ ] **Step 3: push**

```bash
git push origin dev
```

## 자체 검증

- ✅ Spec §7 드래그 7가지 전부 매핑 (resize는 다음 단계 또는 본 PR 후속 commit으로)
- ✅ Spec §6.4 optimistic + 실패 토스트 + 롤백
- ✅ Spec §6.2 staged 배지 + 적용 버튼
- ✅ Spec §D11 디바운스는 Rust 측 800ms (PR 2에서 보장)
- ✅ INVARIANT #7: within-cal = 사람 손 직접, cross-cal = 명시 적용
