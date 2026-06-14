import type { DragMoveEvent } from "@dnd-kit/core";
import { useState } from "react";

import { activeDragLabel } from "@/components/today/timelinePreview";
import type { DragData } from "@/components/today/useTimelineDnd";
import type { LayoutBox } from "@/lib/timelineLayout";

/**
 * 키보드 드래그 중 새 시각을 polite live-region 텍스트로 노출 — 포인터 드래그는 시각 pill이 담당하므로
 * activator가 KeyboardEvent일 때만 갱신한다(매 pointer-move setState 회피). 반환 `announce`를 sr-only
 * `aria-live="polite"` 리전에 렌더하고, 드래그 종료/취소 시 `clear()`로 비운다. snap된 시각은
 * `activeDragLabel`(= preview 정본)에서 유도해 안내가 실제 착지 위치와 일치한다.
 */
export function useKeyboardDragAnnounce(ctx: {
  boxes: LayoutBox[];
  anchorDate: string;
  days: number;
}) {
  const [announce, setAnnounce] = useState("");
  const announceKeyboardMove = (ev: DragMoveEvent, startData: DragData | null) => {
    if (!(ev.activatorEvent instanceof KeyboardEvent)) return;
    const label = activeDragLabel({
      boxes: ctx.boxes,
      activeDrag: startData,
      delta: ev.delta,
      anchorDate: ctx.anchorDate,
      days: ctx.days,
    });
    if (!label) return;
    setAnnounce(
      label.kind === "resize"
        ? `${label.startHHMM}부터 ${label.endHHMM}까지, ${label.durationLabel}`
        : `${label.startHHMM}로 이동`,
    );
  };
  const clear = () => setAnnounce("");
  return { announce, announceKeyboardMove, clear };
}
