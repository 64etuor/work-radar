import { MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { TimelineNoteTarget } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { openExternal, useTimelineNote, useUpsertTimelineNote } from "@/lib/query";
import type { LayoutBox } from "@/lib/timelineLayout";
import { useUIStore } from "@/store";

type Props = {
  open: boolean;
  box: LayoutBox | null;
  /** 현재 보고 있는 날짜(YYYY-MM-DD 로컬). 메모의 (target, date) 스코프 결정. */
  date: string;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  onOpenFullModal: (box: LayoutBox) => void;
  onDeleteSchedule: (box: LayoutBox) => void;
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

function localDateOf(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 블록 → 메모 키 매핑. signal: id 본체, routine: routineId, event: `{calendarId}:{linkedEventId}`. */
function memoKeyFor(
  block: LayoutBox["block"],
  fallbackDate: string,
): { targetKind: TimelineNoteTarget; targetId: string; date: string } | null {
  const date = localDateOf(block.startISO) || fallbackDate;
  if (block.kind === "signal") {
    return { targetKind: "signal", targetId: block.id.replace(/^signal:/, ""), date };
  }
  if (block.kind === "routine" && block.routineId) {
    return { targetKind: "routine", targetId: block.routineId, date };
  }
  if (block.kind === "event" && block.linkedEventId && block.calendarId) {
    return {
      targetKind: "event",
      targetId: `${block.calendarId}:${block.linkedEventId}`,
      date,
    };
  }
  return null;
}

/**
 * 시간축 블록 클릭 시 뜨는 인라인 popover(스펙 §7-row6).
 *
 * Default(접힘): 제목/시각 + 메모 textarea + ⋯ 버튼.
 * Expand(⋯ 클릭): 더보기/Google에서 열기/삭제/루틴 토글 버튼 노출.
 */
export function EventPopover({
  open,
  box,
  date,
  anchor,
  onClose,
  onOpenFullModal,
  onDeleteSchedule,
  onToggleRoutineDone,
}: Props) {
  const goTo = useUIStore((s) => s.goTo);
  const memoKey = useMemo(() => (box ? memoKeyFor(box.block, date) : null), [box, date]);
  const noteQ = useTimelineNote(memoKey);
  const upsert = useUpsertTimelineNote();
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);

  // popover open 또는 block 전환 시 textarea 초기값을 서버값으로 동기화.
  useEffect(() => {
    if (!open) return;
    setExpanded(false);
    setDraft(noteQ.data?.body ?? "");
  }, [open, noteQ.data?.body, memoKey?.targetId, memoKey?.targetKind, memoKey?.date]);

  if (!open || !box || !anchor) return null;
  // narrowed local: closure capture는 LayoutBox(null 제외) 보장.
  const currentBox = box;
  const { block } = currentBox;
  const isRoutine = block.kind === "routine";
  const isSignal = block.kind === "signal";
  const isEvent = block.kind === "event";
  const canDeleteSchedule = isEvent || Boolean(block.linkedEventId);

  /**
   * 더보기 동작 분기:
   *  - signal: 보드 화면으로 이동 — 카드 정본이라 board에서 편집.
   *  - event: linkedEventId가 있으면 Google에서 열기, 아니면 onOpenFullModal로 위임.
   *  - 그 외(routine): onOpenFullModal로 호출자 위임.
   */
  const handleMore = () => {
    if (isSignal) {
      goTo("board");
      onClose();
      return;
    }
    const googleEventId = block.linkedEventId;
    if (isEvent && googleEventId) {
      void openExternal(`https://calendar.google.com/calendar/event?eid=${googleEventId}`);
      onClose();
      return;
    }
    onOpenFullModal(currentBox);
  };

  const handleDelete = () => {
    const message =
      block.kind === "event"
        ? `"${block.title}" 일정을 Google Calendar에서 삭제합니다. 계속할까요?`
        : block.kind === "signal"
          ? `"${block.title}"의 시간 배치를 삭제하고 연결된 Google 일정을 지웁니다. 카드는 Today에 남습니다. 계속할까요?`
          : `"${block.title}" 루틴의 오늘 시간 배치를 삭제하고 연결된 Google 일정을 지웁니다. 계속할까요?`;
    if (!window.confirm(message)) return;
    onDeleteSchedule(currentBox);
    onClose();
  };

  const handleMemoSave = () => {
    if (!memoKey) return;
    // 변경 없으면 noop.
    if ((noteQ.data?.body ?? "") === draft) return;
    upsert.mutate({
      targetKind: memoKey.targetKind,
      targetId: memoKey.targetId,
      date: memoKey.date,
      body: draft,
    });
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
      <PopoverContent className="w-[300px]" align="start">
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{block.title}</div>
              <div className="text-muted-foreground text-xs">
                {hhmm(block.startISO)}–{hhmm(block.endISO)} ·{" "}
                {block.calendarLabel || block.calendarId || block.kind}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 shrink-0 p-0"
              aria-label={expanded ? "더보기 접기" : "더보기 펼치기"}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </div>

          {memoKey && (
            <div className="space-y-1.5 pt-1">
              <textarea
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full resize-none rounded-md border px-2 py-1.5 text-xs focus-visible:ring-1 focus-visible:outline-none"
                rows={3}
                placeholder="메모 (저장하면 보관)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="블록 메모"
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft(noteQ.data?.body ?? "")}
                  disabled={(noteQ.data?.body ?? "") === draft}
                >
                  되돌리기
                </Button>
                <Button
                  size="sm"
                  onClick={handleMemoSave}
                  disabled={(noteQ.data?.body ?? "") === draft || upsert.isPending}
                >
                  {upsert.isPending ? "저장 중…" : "저장"}
                </Button>
              </div>
            </div>
          )}

          {expanded && (
            <div className="flex flex-wrap gap-2 border-t pt-2">
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
              {canDeleteSchedule && (
                <Button
                  size="sm"
                  variant="destructiveOutline"
                  onClick={handleDelete}
                  aria-label="타임라인 일정 삭제"
                >
                  삭제
                </Button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
