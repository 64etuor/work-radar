import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { openExternal } from "@/lib/query";
import type { LayoutBox } from "@/lib/timelineLayout";
import { useUIStore } from "@/store";

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
  const goTo = useUIStore((s) => s.goTo);
  if (!open || !box || !anchor) return null;
  // narrowed local: closure capture는 LayoutBox(null 제외) 보장.
  const currentBox = box;
  const { block } = currentBox;
  const isRoutine = block.kind === "routine";
  const isSignal = block.kind === "signal";
  const isEvent = block.kind === "event";

  /**
   * 더보기 동작 분기 (PR 7, 이전엔 disabled stub):
   *  - signal: 보드 화면으로 이동 — 카드 정본이라 board에서 편집.
   *  - event: linkedEventId가 있으면 Google에서 열기, 아니면 onOpenFullModal로 위임.
   *  - 그 외(routine): onOpenFullModal로 호출자 위임.
   * 단순 wiring — 풀 모달(편집)은 v2 follow-up(area doc 참조).
   */
  const handleMore = () => {
    if (isSignal) {
      goTo("board");
      onClose();
      return;
    }
    if (isEvent && block.linkedEventId) {
      void openExternal(`https://calendar.google.com/calendar/event?eid=${block.linkedEventId}`);
      onClose();
      return;
    }
    onOpenFullModal(currentBox);
  };

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
          <div className="text-muted-foreground text-xs">
            {hhmm(block.startISO)}–{hhmm(block.endISO)} ·{" "}
            {block.calendarLabel || block.calendarId || block.kind}
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
              onClick={handleMore}
              aria-label={
                isSignal
                  ? "보드에서 카드 열기"
                  : isEvent && block.linkedEventId
                    ? "Google에서 이벤트 열기"
                    : "더보기"
              }
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
