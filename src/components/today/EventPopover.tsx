import { Check, Clock, ExternalLink, LayoutGrid, Trash2, Undo2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import type { TimelineNoteTarget } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { IpcError, openExternal, useTimelineNote, useUpsertTimelineNote } from "@/lib/query";
import type { LayoutBox } from "@/lib/timelineLayout";
import { useToastStore } from "@/lib/toast";
import { blockNoteTarget } from "@/lib/todayBlocks";
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

/** 블록 kind → 한글 배지 라벨. */
function kindLabel(kind: LayoutBox["block"]["kind"]): string {
  return kind === "routine" ? "루틴" : kind === "event" ? "일정" : "신호";
}

/** 메모 자동확장 최대 높이(px). 그 이상은 내부 스크롤. HistoryRail(50px)보다 팝오버가 여유 있음. */
const MEMO_MAX_PX = 132;

/** 블록 → 메모 키. 공유 `blockNoteTarget`(표시·편집 단일 정본) + 보는 날짜 스코프. */
function memoKeyFor(
  block: LayoutBox["block"],
  fallbackDate: string,
): { targetKind: TimelineNoteTarget; targetId: string; date: string } | null {
  const target = blockNoteTarget(block);
  if (!target) return null;
  return { ...target, date: localDateOf(block.startISO) || fallbackDate };
}

/**
 * 시간축 블록 클릭 시 뜨는 인라인 메모 카드(side="top" align="center" — 블록 위 중앙).
 *
 * 리치 카드 구조:
 *   1. 헤더 — kind 컬러 액센트 바 + 제목 + kind 배지, 그 아래 시각·캘린더 메타(Clock 아이콘).
 *   2. 메모 — 라벨 + 저장 상태("저장 중…/저장됨") + 자동확장 textarea(디바운스 자동저장).
 *   3. 액션 — 완료/미완료 · 보드 열기(signal) · Google 열기(linkedEventId) · 삭제(우측 분리).
 *
 * 자동저장은 HistoryRail과 동일 패턴(useDebouncedCallback 500ms + onBlur flush). 침묵 실패는
 * onError 토스트로 가시화. 메모 textarea는 scrollHeight 측정으로 내용 따라 자동확장(WKWebView
 * `field-sizing` 미지원 대비 — HistoryRail 선례).
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
  const memoKey = box ? memoKeyFor(box.block, date) : null;
  const noteQ = useTimelineNote(memoKey);

  if (!open || !box || !anchor) return null;
  const currentBox = box;
  const { block } = currentBox;
  const isSignal = block.kind === "signal";
  const isCheckable = isSignal || block.kind === "routine" || Boolean(block.routineId);
  /*
   * 타임라인 배치 삭제는 모든 kind에서 가능 —
   *   signal/routine: stage(unschedule)로 시간 배치만 제거(카드는 Today에 남음).
   *   event: Google Calendar에서 이벤트 삭제.
   */
  const isDone = isCheckable && block.done === true;
  const isRoutine = block.kind === "routine";
  const calLabel = block.calendarLabel || block.calendarId;

  const handleDelete = () => {
    // 루틴 "오늘 빼기"는 EXDATE(되돌리기 토스트로 복구 가능)라 confirm 없이 즉시 실행.
    // signal/event 삭제는 비가역(Google 이벤트 삭제 포함)이라 confirm 유지.
    if (!isRoutine) {
      const message =
        block.kind === "event"
          ? `"${block.title}" 일정을 Google Calendar에서 삭제합니다. 계속할까요?`
          : `"${block.title}"의 시간 배치를 삭제하고 연결된 Google 일정을 지웁니다. 카드는 Today에 남습니다. 계속할까요?`;
      if (!window.confirm(message)) return;
    }
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
      <PopoverContent
        className="w-[320px] overflow-hidden p-0"
        side="top"
        align="center"
        sideOffset={8}
      >
        {/* 1. 헤더 — 컬러 액센트 + 제목 + kind 배지 + 시각·캘린더 메타. */}
        <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
          <span
            className="mt-0.5 h-8 w-1 shrink-0 rounded-full"
            style={{ background: block.color }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 truncate text-sm leading-snug font-semibold">
                {block.title}
              </div>
              <Badge variant="outline" className="shrink-0 font-normal">
                {kindLabel(block.kind)}
              </Badge>
            </div>
            <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
              <Clock className="size-3 shrink-0" aria-hidden />
              <span className="font-mono">
                {hhmm(block.startISO)}–{hhmm(block.endISO)}
              </span>
              {calLabel && (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{calLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 2. 메모 — 라벨 + 저장 상태 + 자동확장 textarea. 쿼리 도착 전엔 동일 지오메트리의
            비활성 셸(시딩 전 입력 방지), 도착 후 memoKey 단위 keyed 에디터로 리마운트 시딩. */}
        {memoKey &&
          (noteQ.data === undefined && noteQ.isLoading ? (
            <div className="border-border border-t px-3.5 py-2.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  메모
                </span>
              </div>
              <Textarea
                className="min-h-0 resize-none overflow-y-auto px-2 py-1.5 text-xs leading-relaxed"
                rows={2}
                placeholder="이 일정에 대한 메모…"
                value=""
                aria-label="블록 메모"
                readOnly
                disabled
              />
            </div>
          ) : (
            <MemoEditor
              key={`${memoKey.targetKind}:${memoKey.targetId}:${memoKey.date}`}
              memoKey={memoKey}
              initialBody={noteQ.data?.body ?? ""}
              savedBody={noteQ.data?.body ?? ""}
            />
          ))}

        {/* 3. 액션 — 완료/보드/Google은 좌측, 삭제는 우측 분리. */}
        <div className="border-border flex items-center gap-1 border-t px-2.5 py-2">
          {isCheckable && (
            <Button
              size="sm"
              variant={isDone ? "outline" : "default"}
              className="gap-1.5"
              onClick={() => {
                onToggleDone(currentBox, !isDone);
                onClose();
              }}
            >
              {isDone ? (
                <Undo2 className="size-3.5" aria-hidden />
              ) : (
                <Check className="size-3.5" aria-hidden />
              )}
              {isDone ? "미완료로" : "완료"}
            </Button>
          )}
          {isSignal && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => {
                goTo("board");
                onClose();
              }}
            >
              <LayoutGrid className="size-3.5" aria-hidden />
              보드
            </Button>
          )}
          {block.linkedEventId && (
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              title="Google Calendar에서 열기"
              aria-label="Google Calendar에서 열기"
              onClick={() => {
                void openExternal(
                  `https://calendar.google.com/calendar/event?eid=${block.linkedEventId}`,
                );
              }}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          )}
          <span className="flex-1" />
          <Button
            size="sm"
            variant={isRoutine ? "ghost" : "destructiveGhost"}
            className="px-2"
            onClick={handleDelete}
            title={isRoutine ? "오늘 타임라인에서 빼기" : "타임라인 일정 삭제"}
            aria-label={isRoutine ? "오늘 타임라인에서 빼기" : "타임라인 일정 삭제"}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 메모 섹션 — memoKey 단위로 `key=` 리마운트되는 분리 에디터.
 *
 * draft는 mount 시 useState 초기값으로 1회 시딩한다(공식 key-reset 패턴). 키가 바뀌면
 * 리마운트로 리시드되므로 "키별 1회 sync" effect + dirty/syncedKey ref 부기가 필요 없고,
 * refetch가 와도 mount 뒤엔 draft를 덮지 않는 기존 계약이 구조적으로 보장된다.
 * 닫힘/키 전환 unmount 시 useDebouncedCallback이 pending 입력을 flush한다(유실 0).
 */
function MemoEditor({
  memoKey,
  initialBody,
  savedBody,
}: {
  memoKey: { targetKind: TimelineNoteTarget; targetId: string; date: string };
  initialBody: string;
  /** 서버 저장본(쿼리 최신값) — "저장됨" 라벨 비교 전용. */
  savedBody: string;
}) {
  const upsert = useUpsertTimelineNote();
  const [draft, setDraft] = useState(initialBody);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // 내용 따라 자동 확장(최대 MEMO_MAX_PX). 넘치면 내부 스크롤. draft 변화마다 재측정.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MEMO_MAX_PX)}px`;
  }, [draft]);

  const debouncedSave = useDebouncedCallback((next: string) => {
    upsert.mutate(
      {
        targetKind: memoKey.targetKind,
        targetId: memoKey.targetId,
        date: memoKey.date,
        body: next,
      },
      {
        onError: (err) =>
          useToastStore
            .getState()
            .pushError("memo.save", err instanceof IpcError ? err.app : String(err)),
      },
    );
  }, 500);

  // 저장 상태 라벨 — pending이면 "저장 중…", draft가 서버 저장본과 일치하고 비어있지 않으면 "저장됨".
  const savedLabel = upsert.isPending
    ? "저장 중…"
    : draft.trim() && draft === savedBody
      ? "저장됨"
      : "";

  return (
    <div className="border-border border-t px-3.5 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          메모
        </span>
        {savedLabel && (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {savedLabel}
          </span>
        )}
      </div>
      <Textarea
        ref={taRef}
        className="min-h-0 resize-none overflow-y-auto px-2 py-1.5 text-xs leading-relaxed"
        rows={2}
        placeholder="이 일정에 대한 메모…"
        value={draft}
        aria-label="블록 메모"
        onChange={(e) => {
          setDraft(e.target.value);
          debouncedSave.run(e.target.value);
        }}
        onBlur={() => debouncedSave.flushNow(draft)}
      />
    </div>
  );
}
