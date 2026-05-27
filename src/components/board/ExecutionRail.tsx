import type { RefObject } from "react";

import type { Kind, LifeWheelTagConfig, RoutineToday, WorkSignal } from "@/bindings";
import { RoutinesPanel, type RoutineDraft } from "@/components/board/RoutinesPanel";
import { TodayRail } from "@/components/board/TodayRail";

export function ExecutionRail({
  todayItems,
  routines,
  lifeWheelTags,
  todayPanelRef,
  onToggleTodayDone,
  onUnpromoteToday,
  onReorderToday,
  onSetTodayKind,
  onSetTodayAreaTagKey,
  onToggleRoutine,
  onCreateRoutine,
  onUpdateRoutine,
  onDeleteRoutine,
  onReorderRoutines,
  onOpenRoutineTracking,
  onSetRoutineKind,
  onSetRoutineAreaTagKey,
}: {
  todayItems: WorkSignal[];
  routines: RoutineToday[];
  lifeWheelTags: LifeWheelTagConfig[];
  todayPanelRef: RefObject<HTMLDivElement | null>;
  onToggleTodayDone: (id: string, done: boolean) => void;
  onUnpromoteToday: (id: string) => void;
  onReorderToday: (ids: string[]) => void;
  onSetTodayKind: (id: string, kind: Kind | null) => void;
  onSetTodayAreaTagKey: (id: string, tagKey: string | null) => void;
  onToggleRoutine: (routineId: string, done: boolean) => void;
  onCreateRoutine: (draft: RoutineDraft) => void;
  onUpdateRoutine: (id: string, draft: RoutineDraft) => void;
  onDeleteRoutine: (id: string) => void;
  onReorderRoutines: (ids: string[]) => void;
  onOpenRoutineTracking: () => void;
  onSetRoutineKind: (id: string, kind: Kind | null) => void;
  onSetRoutineAreaTagKey: (id: string, tagKey: string | null) => void;
}) {
  return (
    <div className="execute">
      <TodayRail
        items={todayItems}
        lifeWheelTags={lifeWheelTags}
        panelRef={todayPanelRef}
        onToggleDone={(id, done) => onToggleTodayDone(id, done)}
        onUnpromote={onUnpromoteToday}
        onReorder={onReorderToday}
        onSetKind={onSetTodayKind}
        onSetAreaTagKey={onSetTodayAreaTagKey}
      />
      <RoutinesPanel
        routines={routines}
        lifeWheelTags={lifeWheelTags}
        onToggle={(routineId, done) => onToggleRoutine(routineId, done)}
        onCreate={onCreateRoutine}
        onUpdate={onUpdateRoutine}
        onDelete={onDeleteRoutine}
        onReorder={onReorderRoutines}
        onOpenTracking={onOpenRoutineTracking}
        onSetKind={onSetRoutineKind}
        onSetAreaTagKey={onSetRoutineAreaTagKey}
      />
    </div>
  );
}
