import { CalendarEventModal, type CalendarModalState } from "@/components/board/CalendarEventModal";
import { CardMenu, type CardMenuAction, type CardMenuState } from "@/components/board/CardMenu";
import { EnrichModal } from "@/components/board/EnrichModal";
import { EnrichReviewPanel } from "@/components/board/EnrichReviewPanel";
import { ProjectPickerModal, type ProjectPickerState } from "@/components/board/ProjectPickerModal";

export function BoardOverlays({
  menu,
  calendarModal,
  projectPicker,
  enrichRunId,
  enrichAllRunId,
  codexReady,
  onMenuAction,
  onMenuClose,
  onCalendarClose,
  onProjectPickerClose,
  onProjectPick,
  onEnrichClose,
  onEnrichAllClose,
}: {
  menu: CardMenuState | null;
  calendarModal: CalendarModalState | null;
  projectPicker: ProjectPickerState | null;
  enrichRunId: string | null;
  enrichAllRunId: string | null;
  codexReady: boolean;
  onMenuAction: (action: CardMenuAction, signalId: string) => void;
  onMenuClose: () => void;
  onCalendarClose: () => void;
  onProjectPickerClose: () => void;
  onProjectPick: (projectId: string) => void;
  onEnrichClose: () => void;
  onEnrichAllClose: () => void;
}) {
  return (
    <>
      {enrichAllRunId && <EnrichReviewPanel runId={enrichAllRunId} onClose={onEnrichAllClose} />}
      <CardMenu state={menu} onAct={onMenuAction} onClose={onMenuClose} codexReady={codexReady} />
      <CalendarEventModal state={calendarModal} onClose={onCalendarClose} />
      <ProjectPickerModal
        state={projectPicker}
        onClose={onProjectPickerClose}
        onPick={onProjectPick}
      />
      {enrichRunId && <EnrichModal runId={enrichRunId} onClose={onEnrichClose} />}
    </>
  );
}
