import type { RefObject } from "react";
import type { RoutineToday, WorkSignal } from "@/bindings";
import { RoutinesPanel, type RoutineDraft } from "@/components/board/RoutinesPanel";
import { TodayRail } from "@/components/board/TodayRail";

export function ExecutionRail({
  todayItems,
  routines,
  todayPanelRef,
  onToggleTodayDone,
  onUnpromoteToday,
  onReorderToday,
  onToggleRoutine,
  onCreateRoutine,
  onUpdateRoutine,
  onDeleteRoutine,
  onReorderRoutines,
  onOpenRoutineTracking,
}: {
  todayItems: WorkSignal[];
  routines: RoutineToday[];
  todayPanelRef: RefObject<HTMLDivElement | null>;
  onToggleTodayDone: (id: string, done: boolean) => void;
  onUnpromoteToday: (id: string) => void;
  onReorderToday: (ids: string[]) => void;
  onToggleRoutine: (routineId: string, done: boolean) => void;
  onCreateRoutine: (draft: RoutineDraft) => void;
  onUpdateRoutine: (id: string, draft: RoutineDraft) => void;
  onDeleteRoutine: (id: string) => void;
  onReorderRoutines: (ids: string[]) => void;
  onOpenRoutineTracking: () => void;
}) {
  return (
    <div className="execute">
      <TodayRail
        items={todayItems}
        panelRef={todayPanelRef}
        onToggleDone={(id, done) => onToggleTodayDone(id, done)}
        onUnpromote={onUnpromoteToday}
        onReorder={onReorderToday}
      />
      <RoutinesPanel
        routines={routines}
        onToggle={(routineId, done) => onToggleRoutine(routineId, done)}
        onCreate={onCreateRoutine}
        onUpdate={onUpdateRoutine}
        onDelete={onDeleteRoutine}
        onReorder={onReorderRoutines}
        onOpenTracking={onOpenRoutineTracking}
      />
    </div>
  );
}
