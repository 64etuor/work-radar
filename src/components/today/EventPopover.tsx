import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { openExternal } from "@/lib/query";
import type { LayoutBox } from "@/lib/timelineLayout";

type Props = {
  open: boolean;
  box: LayoutBox | null;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  onOpenFullModal: (box: LayoutBox) => void;
  /**
   * 루틴 블록 popover에서 완료/미완료 토글. 호출자(TodayView)가 date+useToggleRoutineCheck로
   * 묶어 전달한다. routine 외 kind는 무시.
   */
  onToggleRoutineDone?: (routineId: string, done: boolean) => void;
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 시간축 블록 클릭 시 뜨는 인라인 popover(스펙 §7-row6).
 * 읽기 전용 + 액션 2개:
 *   - "더보기" → 풀 모달(존재 시) 위임. PR 4에선 자리표시(추후 PR에서 정련).
 *   - linkedEventId가 있으면 "Google에서 열기" — `openExternal` 사용(렌더러 토큰 없음).
 * 트리거는 클릭 좌표 기반 anchor span으로 위치 고정(fixed).
 */
export function EventPopover({
  open,
  box,
  anchor,
  onClose,
  onOpenFullModal,
  onToggleRoutineDone,
}: Props) {
  if (!open || !box || !anchor) return null;
  const { block } = box;
  const isRoutine = block.kind === "routine";

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>
        <span
          style={{
            position: "fixed",
            left: anchor.x,
            top: anchor.y,
            width: 1,
            height: 1,
          }}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent className="w-[280px]" align="start">
        <div className="space-y-2">
          <div className="text-sm font-semibold">{block.title}</div>
          <div className="text-xs text-muted-foreground">
            {hhmm(block.startISO)}–{hhmm(block.endISO)} ·{" "}
            {block.calendarId || block.kind}
          </div>
          <div className="flex gap-2 pt-2">
            {isRoutine && block.routineId && onToggleRoutineDone && (
              <Button
                size="sm"
                variant={block.done ? "secondary" : "default"}
                onClick={() => {
                  onToggleRoutineDone(block.routineId!, !block.done);
                  onClose();
                }}
              >
                {block.done ? "미완료로" : "완료"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled
              title="PR 7 예정"
              onClick={() => onOpenFullModal(box)}
            >
              더보기
            </Button>
            {block.linkedEventId && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void openExternal(
                    `https://calendar.google.com/calendar/event?eid=${block.linkedEventId}`,
                  )
                }
              >
                Google에서 열기
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
