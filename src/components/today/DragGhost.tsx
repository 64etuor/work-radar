import type { DragData } from "@/components/today/useTimelineDnd";

/**
 * 드래그 중 cursor를 따라다니는 ghost. dnd-kit `DragOverlay`는 Portal 렌더,
 * pointer 이벤트 무시 — Notion/Linear 류 "옮기는 느낌" 제공.
 * 캔버스 블록을 트레이 위로 끌면 인박스 카드 형태로 ghost를 전환해 unschedule 의도를 시각화.
 */
export function DragGhost({ data, isOverTray }: { data: DragData; isOverTray: boolean }) {
  // canvas-resize: 인플레이스 preview(블록 리사이즈 + 시각 pill)가 정본 — 따라오는 막대 ghost는 중복.
  if (data.from === "canvas-resize") return null;
  if (data.from === "canvas") {
    if (!isOverTray) return null;
    // 캔버스→트레이 드래그: 인박스 카드 비주얼로 전환(unschedule 미리보기).
    return (
      <div className="today-drag-ghost today-drag-ghost--card">
        <div className="today-drag-ghost-card-title">{data.title}</div>
      </div>
    );
  }
  // 여기까지 오면 from은 tray | routine (canvas, canvas-resize는 위에서 처리됨).
  return (
    <div className="today-drag-ghost">
      <span className="today-drag-ghost-grip" aria-hidden>
        ⠿
      </span>
      <span className="today-drag-ghost-title">{data.title}</span>
    </div>
  );
}
