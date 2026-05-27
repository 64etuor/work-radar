import { Repeat } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { LayoutBox } from "@/lib/timelineLayout";

type Props = {
  box: LayoutBox;
  onClick: (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => void;
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 시간축 위 단일 블록(스펙 §D8 카드 정본).
 * 위치/높이는 호출부의 `LayoutBox`가 산출 — 본 컴포넌트는 순수 렌더.
 * 클릭은 EventPopover 트리거(드래그/리사이즈는 PR 5).
 */
export function TimelineBlock({ box, onClick }: Props) {
  const { block, topPx, heightPx, leftPct, widthPct } = box;
  return (
    <button
      type="button"
      className={`tl-block tl-block-${block.kind}`}
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        // 60px 라벨 거터 안쪽 영역에서 leftPct/widthPct를 백분율로 적용.
        left: `calc(60px + ((100% - 60px) * ${leftPct} / 100))`,
        width: `calc(((100% - 60px) * ${widthPct} / 100) - 4px)`,
        borderLeftColor: block.color,
      }}
      onClick={(e) => onClick(box, e)}
      title={block.title}
    >
      <div className="tl-block-time">
        {hhmm(block.startISO)}–{hhmm(block.endISO)}
      </div>
      <div className="tl-block-title">
        {block.kind === "routine" && (
          <Repeat className="tl-block-icon" aria-hidden />
        )}
        {block.title}
      </div>
    </button>
  );
}
