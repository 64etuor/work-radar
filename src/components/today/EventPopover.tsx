import { useEffect, useMemo, useRef, useState } from "react";

import type { TimelineNoteTarget } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { IpcError, openExternal, useTimelineNote, useUpsertTimelineNote } from "@/lib/query";
import type { LayoutBox } from "@/lib/timelineLayout";
import { useToastStore } from "@/lib/toast";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";
import { useUIStore } from "@/store";

type Props = {
  open: boolean;
  box: LayoutBox | null;
  /** 현재 보고 있는 날짜(YYYY-MM-DD 로컬). 메모의 (target, date) 스코프 결정. */
  date: string;
  /** 블록 top-center 좌표(viewport). Popover는 side="top" align="center"로 이 위에 띄운다. */
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  /** 시간 배치 삭제(+연결 Google 일정). caller가 block.kind에 따라 stage 분기. */
  onDeleteSchedule: (box: LayoutBox) => void;
  /**
   * signal/routine 완료 토글. event는 done 개념이 없어 caller가 무시.
   * TodayView의 handleBlockToggleDone과 직접 연결되므로 popover는 분기 책임 0.
   */
  onToggleDone: (box: LayoutBox, done: boolean) => void;
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
 * 시간축 블록 클릭 시 뜨는 인라인 popover. 블록 **위 중앙**에 띄움(side="top" align="center").
 *
 * 단층 구조 — 계층/펼침 없음:
 *   1. 헤더(제목 + 시각·캘린더)
 *   2. 메모 textarea (디바운스 자동저장 — 별도 저장 버튼 없음)
 *   3. 액션 row: 완료/미완료 · 보드 열기(signal) · Google 열기(linkedEventId) · 삭제
 *
 * 자동저장은 HistoryRail과 동일 패턴(useDebouncedCallback 500ms + onBlur flush) — 사용자가
 * 저장 버튼 누르는 마찰 제거. 침묵 실패는 onError 토스트로 가시화(client.ts:39 글로벌 onError 없음).
 */
export function EventPopover({
  open,
  box,
  date,
  anchor,
  onClose,
  onDeleteSchedule,
  onToggleDone,
}: Props) {
  const goTo = useUIStore((s) => s.goTo);
  const memoKey = useMemo(() => (box ? memoKeyFor(box.block, date) : null), [box, date]);
  const noteQ = useTimelineNote(memoKey);
  const upsert = useUpsertTimelineNote();
  const [draft, setDraft] = useState("");
  const dirtyRef = useRef(false);

  /*
   * 키별 1회만 sync — data 변화에 의존하면 사용자가 타이핑한 draft가 fetch/refetch 결과로 덮인다.
   * 저장 onSuccess에서 dirty=false 복귀 → 서버값과 draft가 일치할 때만 외부 동기화 허용.
   */
  const syncedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !memoKey) {
      syncedKeyRef.current = null;
      dirtyRef.current = false;
      return;
    }
    const key = `${memoKey.targetKind}:${memoKey.targetId}:${memoKey.date}`;
    if (syncedKeyRef.current === key) return;
    if (noteQ.data === undefined && noteQ.isLoading) return;
    setDraft(noteQ.data?.body ?? "");
    syncedKeyRef.current = key;
    dirtyRef.current = false;
  }, [open, memoKey, noteQ.data, noteQ.isLoading]);

  const debouncedSave = useDebouncedCallback((next: string) => {
    if (!memoKey) return;
    upsert.mutate(
      {
        targetKind: memoKey.targetKind,
        targetId: memoKey.targetId,
        date: memoKey.date,
        body: next,
      },
      {
        onSuccess: () => {
          dirtyRef.current = false;
        },
        onError: (err) =>
          useToastStore
            .getState()
            .pushError("memo.save", err instanceof IpcError ? err.app : String(err)),
      },
    );
  }, 500);

  if (!open || !box || !anchor) return null;
  const currentBox = box;
  const { block } = currentBox;
  const isSignal = block.kind === "signal";
  const isCheckable = isSignal || block.kind === "routine";
  /*
   * 타임라인 배치 삭제는 모든 kind에서 가능 —
   *   signal/routine: stage(unschedule)로 시간 배치만 제거(카드는 Today에 남음).
   *   event: Google Calendar에서 이벤트 삭제.
   * 이전엔 linkedEventId 없으면 숨겼는데, Google 미동기화 signal도 unschedule이 정상 동작하므로 항상 노출.
   */
  const isDone = isCheckable && block.done === true;

  const handleDelete = () => {
    const message =
      block.kind === "event"
        ? `"${block.title}" 일정을 Google Calendar에서 삭제합니다. 계속할까요?`
        : isSignal
          ? `"${block.title}"의 시간 배치를 삭제하고 연결된 Google 일정을 지웁니다. 카드는 Today에 남습니다. 계속할까요?`
          : `"${block.title}" 루틴의 오늘 시간 배치를 삭제하고 연결된 Google 일정을 지웁니다. 계속할까요?`;
    if (!window.confirm(message)) return;
    onDeleteSchedule(currentBox);
    onClose();
  };

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>
        <span
          style={{ position: "fixed", left: anchor.x, top: anchor.y, width: 1, height: 1 }}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent className="w-[300px] space-y-2" side="top" align="center" sideOffset={8}>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{block.title}</div>
          <div className="text-muted-foreground text-xs">
            {hhmm(block.startISO)}–{hhmm(block.endISO)} ·{" "}
            {block.calendarLabel || block.calendarId || block.kind}
          </div>
        </div>

        {memoKey && (
          <Textarea
            className="min-h-0 resize-none px-2 py-1.5 text-xs"
            rows={3}
            placeholder="메모"
            value={draft}
            aria-label="블록 메모"
            onChange={(e) => {
              dirtyRef.current = true;
              setDraft(e.target.value);
              debouncedSave.run(e.target.value);
            }}
            onBlur={() => debouncedSave.flushNow(draft)}
          />
        )}

        <div className="flex flex-wrap gap-1.5">
          {isCheckable && (
            <Button
              size="sm"
              variant={isDone ? "outline" : "default"}
              onClick={() => {
                onToggleDone(currentBox, !isDone);
                onClose();
              }}
            >
              {isDone ? "미완료로" : "완료"}
            </Button>
          )}
          {isSignal && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                goTo("board");
                onClose();
              }}
            >
              보드에서 열기
            </Button>
          )}
          {block.linkedEventId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void openExternal(
                  `https://calendar.google.com/calendar/event?eid=${block.linkedEventId}`,
                );
              }}
            >
              Google에서 열기
            </Button>
          )}
          <Button
            size="sm"
            variant="destructiveOutline"
            onClick={handleDelete}
            aria-label="타임라인 일정 삭제"
          >
            삭제
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
