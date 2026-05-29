import type { RefObject } from "react";

import type { Kind, LifeWheelTagConfig, Project, RoutineToday, WorkSignal } from "@/bindings";
import { type RoutineDraft, RoutinesPanel } from "@/components/board/RoutinesPanel";
import { TodayRail } from "@/components/board/TodayRail";

export function ExecutionRail({
  todayItems,
  routines,
  lifeWheelTags,
  projects,
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
  onEnableRoutineSync,
  onDisableRoutineSync,
  onMoveRoutineSync,
  routineSyncBusy,
}: {
  todayItems: WorkSignal[];
  routines: RoutineToday[];
  lifeWheelTags: LifeWheelTagConfig[];
  projects: Project[];
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
  onEnableRoutineSync: (routineId: string, projectId: string, calendarId: string) => void;
  onDisableRoutineSync: (routineId: string) => void;
  onMoveRoutineSync: (routineId: string, projectId: string, calendarId: string) => void;
  routineSyncBusy?: boolean;
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
        projects={projects}
        onToggle={(routineId, done) => onToggleRoutine(routineId, done)}
        onCreate={onCreateRoutine}
        onUpdate={onUpdateRoutine}
        onDelete={onDeleteRoutine}
        onReorder={onReorderRoutines}
        onOpenTracking={onOpenRoutineTracking}
        onSetKind={onSetRoutineKind}
        onSetAreaTagKey={onSetRoutineAreaTagKey}
        onEnableSync={onEnableRoutineSync}
        onDisableSync={onDisableRoutineSync}
        onMoveSync={onMoveRoutineSync}
        syncBusy={routineSyncBusy}
      />
    </div>
  );
}
