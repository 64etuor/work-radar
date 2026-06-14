import type { DragDelta } from "@/components/today/timelinePreview";
import type { DragData } from "@/components/today/useTimelineDnd";

export type GuidePoint = { x: number; y: number };

/**
 * Notion-스타일 드래그 ghost + 크로스헤어 가이드 상태. TodayView의 DndContext 콜백에서 dispatch.
 * pointerGrid = 라이브 드래그 포인터(그리드 로컬) — 크로스헤어 가이드가 커서를 정확히 따르게 한다.
 */
export type DragGhostState = {
  activeDrag: DragData | null;
  activeDelta: DragDelta | null;
  isOverTray: boolean;
  pointerGrid: GuidePoint | null;
};

export type DragGhostAction =
  | { type: "start"; data: DragData | null }
  | { type: "move"; delta: DragDelta; pointerGrid?: GuidePoint | null }
  | { type: "over"; isOverTray: boolean }
  | { type: "reset" };

export const INITIAL_DRAG_GHOST_STATE: DragGhostState = {
  activeDrag: null,
  activeDelta: null,
  isOverTray: false,
  pointerGrid: null,
};

export function dragGhostReducer(state: DragGhostState, action: DragGhostAction): DragGhostState {
  switch (action.type) {
    case "start":
      return {
        activeDrag: action.data,
        activeDelta: { x: 0, y: 0 },
        isOverTray: false,
        pointerGrid: null,
      };
    case "move":
      return {
        ...state,
        activeDelta: action.delta,
        // 키보드 드래그(activator에 client 좌표 없음)는 pointerGrid를 안 보내므로 이전 값 유지.
        pointerGrid: action.pointerGrid ?? state.pointerGrid,
      };
    case "over":
      return { ...state, isOverTray: action.isOverTray };
    case "reset":
      return INITIAL_DRAG_GHOST_STATE;
  }
}
