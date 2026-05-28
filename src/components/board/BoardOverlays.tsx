import { CalendarEventModal, type CalendarModalState } from "@/components/board/CalendarEventModal";
import { CardMenu, type CardMenuAction, type CardMenuState } from "@/components/board/CardMenu";
import { ProjectPickerModal, type ProjectPickerState } from "@/components/board/ProjectPickerModal";

export function BoardOverlays({
  menu,
  calendarModal,
  projectPicker,
  onMenuAction,
  onMenuClose,
  onCalendarClose,
  onProjectPickerClose,
  onProjectPick,
}: {
  menu: CardMenuState | null;
  calendarModal: CalendarModalState | null;
  projectPicker: ProjectPickerState | null;
  onMenuAction: (action: CardMenuAction, signalId: string) => void;
  onMenuClose: () => void;
  onCalendarClose: () => void;
  onProjectPickerClose: () => void;
  onProjectPick: (projectId: string) => void;
}) {
  return (
    <>
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
