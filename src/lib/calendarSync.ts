/**
 * Today×Timeline 드래그/리사이즈 → PR 2의 `stage_calendar_write` 큐로 보내는 단일 dispatcher.
 *
 * - 외부 호출은 워커가 한다(스펙 §6.1·§6.4). 이 함수는 SQL UPSERT만 트리거.
 * - SQLite mirror는 Rust가 즉시 반영하고, Google API sync 디바운스는 Rust 큐가 보장한다.
 * - cross-cal `moveCalendar`는 staged=true로 들어가 사용자 Acceptance(`commit_staged_writes`)
 *   까지 워커가 skip한다(INVARIANT #2).
 * - Resize는 bindings상 `at`도 필수(워커 단순화 — patch는 start+duration 묶음).
 */
import { commands, type StageWriteRequest, type WriteOp, type WriteTarget } from "@/bindings";
import { unwrap } from "@/lib/query/client";

export type StageInput =
  | {
      kind: "schedule";
      targetSignalId: string;
      at: string;
      durationMin: number;
      calendarId: string;
      title: string;
    }
  | {
      kind: "reschedule";
      targetSignalId: string;
      at: string;
      durationMin: number;
      /** 이동 출발 블록의 날짜(YYYY-MM-DD) — 날짜를 넘는 이동 시 그 날의 placement 행 삭제. */
      fromDate?: string;
    }
  | {
      kind: "resize";
      targetSignalId: string;
      at: string;
      durationMin: number;
      /** 리사이즈 출발 블록의 날짜(YYYY-MM-DD) — top-핸들 리사이즈가 날짜를 넘을 수 있다. */
      fromDate?: string;
    }
  | {
      kind: "eventReschedule";
      eventId: string;
      calendarId: string;
      at: string;
      durationMin: number;
      /** 동기화된 루틴의 이벤트 블록이면 루틴 id — Rust가 time_override를 같은 IPC에서 미러. */
      routineId?: string;
      /** 위 루틴의 occurrence 날짜(YYYY-MM-DD). routineId와 쌍. */
      routineDate?: string;
    }
  | {
      kind: "eventResize";
      eventId: string;
      calendarId: string;
      at: string;
      durationMin: number;
      routineId?: string;
      routineDate?: string;
    }
  | { kind: "eventUnschedule"; eventId: string; calendarId: string }
  | {
      kind: "unschedule";
      targetSignalId: string;
      /** 트레이로 복귀시키는 블록의 날짜(YYYY-MM-DD) — 그 날의 placement 행 삭제. */
      fromDate?: string;
    }
  | {
      kind: "moveCalendar";
      targetSignalId: string;
      calendarId: string;
      at: string;
      durationMin: number;
      title: string;
    }
  | {
      kind: "createBlank";
      title: string;
      at: string;
      durationMin: number;
      calendarId: string;
      placeholderTargetId: string;
    }
  | {
      kind: "routineSchedule";
      routineId: string;
      date: string;
      at: string;
      durationMin: number;
      calendarId: string;
      title: string;
    }
  | {
      kind: "routineReschedule";
      routineId: string;
      date: string;
      at: string;
      durationMin: number;
    }
  | {
      kind: "routineResize";
      routineId: string;
      date: string;
      at: string;
      durationMin: number;
    }
  | { kind: "routineUnschedule"; routineId: string; date: string };

function newIdempotencyKey(): string {
  // crypto.randomUUID는 secure context에서 사용 가능. Tauri renderer 항상 secure.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 보수 fallback — Tauri 렌더러에선 도달 안 함.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** StageInput → bindings `StageWriteRequest` 변환 + IPC 호출. */
export async function stage(input: StageInput): Promise<void> {
  const req = toRequest(input);
  await unwrap(commands.stageCalendarWrite(req));
}

function toRequest(i: StageInput): StageWriteRequest {
  const idempotency_key = newIdempotencyKey();
  switch (i.kind) {
    case "schedule": {
      const target: WriteTarget = { kind: "signal", id: i.targetSignalId };
      const op: WriteOp = {
        op: "schedule",
        at: i.at,
        duration_min: i.durationMin,
        calendar_id: i.calendarId,
        title: i.title,
      };
      return { target, op, idempotency_key };
    }
    case "reschedule": {
      const target: WriteTarget = { kind: "signal", id: i.targetSignalId };
      const op: WriteOp = {
        op: "reschedule",
        at: i.at,
        duration_min: i.durationMin,
        from_date: i.fromDate ?? null,
      };
      return { target, op, idempotency_key };
    }
    case "resize": {
      const target: WriteTarget = { kind: "signal", id: i.targetSignalId };
      const op: WriteOp = {
        op: "resize",
        at: i.at,
        duration_min: i.durationMin,
        from_date: i.fromDate ?? null,
      };
      return { target, op, idempotency_key };
    }
    case "eventReschedule": {
      const target: WriteTarget = {
        kind: "event",
        calendar_id: i.calendarId,
        event_id: i.eventId,
        routine_id: i.routineId ?? null,
        routine_date: i.routineDate ?? null,
      };
      const op: WriteOp = {
        op: "reschedule",
        at: i.at,
        duration_min: i.durationMin,
        from_date: null,
      };
      return { target, op, idempotency_key };
    }
    case "eventResize": {
      const target: WriteTarget = {
        kind: "event",
        calendar_id: i.calendarId,
        event_id: i.eventId,
        routine_id: i.routineId ?? null,
        routine_date: i.routineDate ?? null,
      };
      const op: WriteOp = {
        op: "resize",
        at: i.at,
        duration_min: i.durationMin,
        from_date: null,
      };
      return { target, op, idempotency_key };
    }
    case "eventUnschedule": {
      const target: WriteTarget = {
        kind: "event",
        calendar_id: i.calendarId,
        event_id: i.eventId,
        routine_id: null,
        routine_date: null,
      };
      const op: WriteOp = { op: "unschedule", from_date: null };
      return { target, op, idempotency_key };
    }
    case "unschedule": {
      const target: WriteTarget = { kind: "signal", id: i.targetSignalId };
      const op: WriteOp = { op: "unschedule", from_date: i.fromDate ?? null };
      return { target, op, idempotency_key };
    }
    case "moveCalendar": {
      const target: WriteTarget = { kind: "signal", id: i.targetSignalId };
      const op: WriteOp = {
        op: "move_calendar",
        calendar_id: i.calendarId,
        at: i.at,
        duration_min: i.durationMin,
        title: i.title,
      };
      return { target, op, idempotency_key };
    }
    case "createBlank": {
      // createBlank은 카드 미연결 신규 — placeholderTargetId(UUID 등)로 멱등키 구분.
      const target: WriteTarget = { kind: "signal", id: i.placeholderTargetId };
      const op: WriteOp = {
        op: "create_blank",
        title: i.title,
        at: i.at,
        duration_min: i.durationMin,
        calendar_id: i.calendarId,
      };
      return { target, op, idempotency_key };
    }
    case "routineSchedule": {
      const target: WriteTarget = {
        kind: "routine_check",
        routine_id: i.routineId,
        date: i.date,
      };
      const op: WriteOp = {
        op: "schedule",
        at: i.at,
        duration_min: i.durationMin,
        calendar_id: i.calendarId,
        title: i.title,
      };
      return { target, op, idempotency_key };
    }
    case "routineUnschedule": {
      const target: WriteTarget = {
        kind: "routine_check",
        routine_id: i.routineId,
        date: i.date,
      };
      const op: WriteOp = { op: "unschedule", from_date: null };
      return { target, op, idempotency_key };
    }
    case "routineReschedule": {
      const target: WriteTarget = {
        kind: "routine_check",
        routine_id: i.routineId,
        date: i.date,
      };
      const op: WriteOp = {
        op: "reschedule",
        at: i.at,
        duration_min: i.durationMin,
        from_date: null,
      };
      return { target, op, idempotency_key };
    }
    case "routineResize": {
      const target: WriteTarget = {
        kind: "routine_check",
        routine_id: i.routineId,
        date: i.date,
      };
      const op: WriteOp = {
        op: "resize",
        at: i.at,
        duration_min: i.durationMin,
        from_date: null,
      };
      return { target, op, idempotency_key };
    }
  }
}
