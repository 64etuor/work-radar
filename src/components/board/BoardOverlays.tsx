import { CalendarEventModal, type CalendarModalState } from "@/components/board/CalendarEventModal";
import { CardMenu, type CardMenuAction, type CardMenuState } from "@/components/board/CardMenu";
import { EnrichReviewPanel } from "@/components/board/EnrichReviewPanel";
import { ProjectPickerModal, type ProjectPickerState } from "@/components/board/ProjectPickerModal";

export function BoardOverlays({
  menu,
  calendarModal,
  projectPicker,
  enrichAllRunId,
  onMenuAction,
  onMenuClose,
  onCalendarClose,
  onProjectPickerClose,
  onProjectPick,
  onEnrichAllClose,
}: {
  menu: CardMenuState | null;
  calendarModal: CalendarModalState | null;
  projectPicker: ProjectPickerState | null;
  enrichAllRunId: string | null;
  onMenuAction: (action: CardMenuAction, signalId: string) => void;
  onMenuClose: () => void;
  onCalendarClose: () => void;
  onProjectPickerClose: () => void;
  onProjectPick: (projectId: string) => void;
  onEnrichAllClose: () => void;
}) {
  return (
    <>
      {enrichAllRunId && <EnrichReviewPanel runId={enrichAllRunId} onClose={onEnrichAllClose} />}
      <CardMenu state={menu} onAct={onMenuAction} onClose={onMenuClose} />
      <CalendarEventModal state={calendarModal} onClose={onCalendarClose} />
      <ProjectPickerModal
        state={projectPicker}
        onClose={onProjectPickerClose}
        onPick={onProjectPick}
      />
    </>
  );
}
