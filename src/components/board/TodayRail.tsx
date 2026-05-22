import type { WorkSignal } from "@/bindings";
import { CheckIcon } from "@/components/board/CheckIcon";
import {
  kindChipClass,
  kindLabel,
  quadrantToZone,
  type ZoneKey,
} from "@/components/board/board-utils";
import { ageFromForDate, isTodayDone, localToday } from "@/lib/query";
import { useListReorder } from "@/lib/useListReorder";

type Props = {
  items: WorkSignal[];
  panelRef: React.RefObject<HTMLDivElement | null>;
  onToggleDone: (id: string, done: boolean) => void;
  onUnpromote: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
};

const Q_BADGE: Record<Exclude<ZoneKey, "unclassified">, string> = {
  q1: "Q1",
  q2: "Q2",
  q3: "Q3",
  q4: "Q4",
};

/** 우측 상단 Today 레일 — 오늘 집중 항목 큐레이션. 드래그 핸들(⠿)로 재정렬(공용 dnd, spec §1.C). */
export function TodayRail({ items, panelRef, onToggleDone, onUnpromote, onReorder }: Props) {
  const today = localToday();
  const d = new Date();
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()} 오늘`;
  const dnd = useListReorder(
    items.map((s) => s.id),
    onReorder,
  );

  return (
    <div className="panelbox" data-drop="today" ref={panelRef}>
      <div className="pb-head">
        <span className="lbl">Today</span>
        <span className="sub">{dateLabel}</span>
      </div>
      <div className="pb-body">
        {items.length === 0 ? (
          <div className="empty">매트릭스 카드를 여기로 드래그하거나 ⋯ → Today 추가</div>
        ) : (
          items.map((s) => {
            const done = isTodayDone(s, today);
            const zone = quadrantToZone(s.quadrant);
            const age = s.todayForDate ? ageFromForDate(s.todayForDate) : 1;
            return (
              <div key={s.id} className={`item${done ? " done" : ""}`} {...dnd.itemProps(s.id)}>
                <span className="grip" title="드래그로 정렬" {...dnd.handleProps(s.id)}>
                  ⠿
                </span>
                <div
                  className="cb-check"
                  role="checkbox"
                  aria-checked={done}
                  onClick={() => onToggleDone(s.id, !done)}
                >
                  <CheckIcon />
                </div>
                <div className="body">
                  <div className="ttl">{s.title}</div>
                  <div className="meta">
                    {zone !== "unclassified" && (
                      <span className={`badge b-${zone}`}>{Q_BADGE[zone]}</span>
                    )}
                    <span className={`badge b-age${age >= 3 ? " old" : ""}`}>+{age}</span>
                    {s.kind && (
                      <span className={`b-tag ${kindChipClass(s.kind)}`}>{kindLabel(s.kind)}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="ret"
                  title="매트릭스로 되돌리기"
                  onClick={() => onUnpromote(s.id)}
                >
                  ↩
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
