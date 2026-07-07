import type { CSSProperties, ReactNode } from "react";

import type { RoutineToday } from "@/bindings";
import { RoutineForm } from "@/components/board/RoutineForm";
import { type RoutineDraft } from "@/components/board/routineSchedule";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type RoutineModalState =
  | {
      mode: "create";
      nonce: number;
      anchor: RoutineModalAnchor;
      defaults?: RoutineFormDefaults;
    }
  | {
      mode: "edit";
      routine: RoutineToday;
      anchor: RoutineModalAnchor;
    };

export type RoutineModalAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type RoutineFormDefaults = {
  title?: string;
  startDate?: string | null;
  endDate?: string | null;
};

type Props = {
  state: RoutineModalState | null;
  onOpenChange: (open: boolean) => void;
  title?: string;
  beforeForm?: ReactNode;
  widthPx?: number;
  maxHeightPx?: number;
  onSubmit: (draft: RoutineDraft) => void | Promise<void>;
};

export function RoutineModal({
  state,
  onOpenChange,
  title,
  beforeForm,
  widthPx = MODAL_DEFAULT_WIDTH,
  maxHeightPx = MODAL_DEFAULT_MAX_HEIGHT,
  onSubmit,
}: Props) {
  const open = state !== null;
  const isEdit = state?.mode === "edit";
  const initial = state?.mode === "edit" ? state.routine : null;
  const defaults = state?.mode === "create" ? state.defaults : undefined;
  const dialogTitle = title ?? (isEdit ? "루틴 수정" : "루틴 추가");
  const position = state ? routineModalPosition(state.anchor, widthPx) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        data-routine-modal-content
        className="cb cb-routine-modal top-[var(--routine-modal-top)] left-[var(--routine-modal-left)] max-h-[min(var(--routine-modal-max-height),calc(100vh-var(--routine-modal-top)-12px))] w-[var(--routine-modal-width)] max-w-[calc(100vw-24px)] translate-x-0 translate-y-0 gap-2 overflow-y-auto p-3"
        showClose
        showOverlay={false}
        style={
          position
            ? ({
                "--routine-modal-left": `${position.left}px`,
                "--routine-modal-top": `${position.top}px`,
                "--routine-modal-width": `${widthPx}px`,
                "--routine-modal-max-height": `${maxHeightPx}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <DialogTitle className="typo-title-sm">{dialogTitle}</DialogTitle>
        {beforeForm}
        {state && (
          <RoutineForm
            key={
              state.mode === "edit"
                ? `edit:${state.routine.id}`
                : `create:${state.nonce}:${defaults?.title ?? ""}:${defaults?.startDate ?? ""}:${
                    defaults?.endDate ?? ""
                  }`
            }
            initial={initial}
            defaults={defaults}
            isEdit={isEdit}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const MODAL_DEFAULT_WIDTH = 360;
const MODAL_DEFAULT_MAX_HEIGHT = 620;
const MODAL_MIN_USABLE_HEIGHT = 240;
const MODAL_MARGIN = 12;
const ANCHOR_GAP = 8;

function routineModalPosition(anchor: RoutineModalAnchor, widthPx: number) {
  if (typeof window === "undefined") {
    return {
      left: anchor.left,
      top: anchor.bottom + ANCHOR_GAP,
    };
  }
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(MODAL_MARGIN, viewportWidth - widthPx - MODAL_MARGIN);
  const left = clamp(anchor.left, MODAL_MARGIN, maxLeft);
  const maxTop = Math.max(MODAL_MARGIN, viewportHeight - MODAL_MIN_USABLE_HEIGHT - MODAL_MARGIN);
  const top = clamp(anchor.bottom + ANCHOR_GAP, MODAL_MARGIN, maxTop);

  return {
    left,
    top,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
