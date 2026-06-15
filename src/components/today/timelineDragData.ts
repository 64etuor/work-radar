import type { DragData } from "@/components/today/useTimelineDnd";
import type { LayoutBox } from "@/lib/timelineLayout";
import { eventBlockApiId } from "@/lib/todayBlocks";

/** 블록 id에서 kind 접두사 제거 — signalId/routineId 폴백 추출용. */
function stripBlockPrefix(id: string, kind: "signal" | "event" | "routine"): string {
  return id.replace(new RegExp(`^${kind}:`), "");
}

/**
 * 캔버스 블록 → 이동(reschedule) DragData.
 *
 * 동기화 루틴(`kind:"routine"` + per-instance `linkedEventId`)은 **event-backed**로 라우팅한다 —
 * `eventReschedule`가 Google 인스턴스를 patch하고 routine_checks 링크를 adopt해 write-back/스냅백
 * 방지가 보존된다. `linkedEventId`는 todayBlocks가 per-instance id로만 채우므로(master 아님) 시리즈
 * 전체 이동 위험이 없다. 링크가 없으면 routine path(로컬 미러).
 */
export function dragDataForBox(box: LayoutBox, durationMin: number): DragData {
  const { block } = box;
  // event 블록과 동기화 루틴(per-instance 미러 id)은 같은 event-backed 이동 데이터를 만든다 —
  // eventReschedule가 Google 인스턴스를 patch(루틴이면 time_override도 미러/adopt).
  if (block.kind === "event" || (block.kind === "routine" && block.linkedEventId)) {
    return {
      from: "canvas",
      blockKind: "event",
      blockId: block.id,
      eventId: eventBlockApiId(block),
      title: block.title,
      startISO: block.startISO,
      durationMin,
      calendarId: block.calendarId,
      routineId:
        block.kind === "routine"
          ? (block.routineId ?? stripBlockPrefix(block.id, "routine"))
          : block.routineId,
    };
  }
  if (block.kind === "routine") {
    return {
      from: "canvas",
      blockKind: "routine",
      blockId: block.id,
      routineId: block.routineId ?? stripBlockPrefix(block.id, "routine"),
      title: block.title,
      startISO: block.startISO,
      durationMin,
      calendarId: block.calendarId,
    };
  }
  return {
    from: "canvas",
    blockKind: "signal",
    blockId: block.id,
    signalId: block.signalId ?? stripBlockPrefix(block.id, "signal"),
    title: block.title,
    startISO: block.startISO,
    durationMin,
    calendarId: block.calendarId,
  };
}

/**
 * 캔버스 블록 → 리사이즈 DragData. 동기화 루틴 리사이즈도 event-backed(`eventResize`가 Google
 * 인스턴스 길이를 patch — per-day 길이는 routine_checks에 없어 Google이 정본). master 아님.
 */
export function resizeDataForBox(
  box: LayoutBox,
  edge: "top" | "bottom",
  durationMin: number,
): DragData {
  const { block } = box;
  // event 블록과 동기화 루틴(per-instance 미러 id)은 같은 event-backed 리사이즈 데이터 — eventResize가
  // Google 인스턴스 길이를 patch(per-day 길이는 routine_checks에 없어 Google이 정본).
  if (block.kind === "event" || (block.kind === "routine" && block.linkedEventId)) {
    return {
      from: "canvas-resize",
      edge,
      blockKind: "event",
      blockId: block.id,
      eventId: eventBlockApiId(block),
      calendarId: block.calendarId,
      startISO: block.startISO,
      durationMin,
      routineId:
        block.kind === "routine"
          ? (block.routineId ?? stripBlockPrefix(block.id, "routine"))
          : block.routineId,
    };
  }
  if (block.kind === "routine") {
    return {
      from: "canvas-resize",
      edge,
      blockKind: "routine",
      blockId: block.id,
      routineId: block.routineId ?? stripBlockPrefix(block.id, "routine"),
      startISO: block.startISO,
      durationMin,
    };
  }
  return {
    from: "canvas-resize",
    edge,
    blockKind: "signal",
    blockId: block.id,
    signalId: block.signalId ?? stripBlockPrefix(block.id, "signal"),
    startISO: block.startISO,
    durationMin,
  };
}
