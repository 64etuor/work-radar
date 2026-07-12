import { useQueryClient } from "@tanstack/react-query";

import { commands } from "@/bindings";
import { stage } from "@/lib/calendarSync";
import { unwrap } from "@/lib/query/client";
import { localDateOf } from "@/lib/timeAxis";
import { removeEventFromCache } from "@/lib/timelineEventCache";
import { invalidateSignalCaches, invalidateTimelineAll } from "@/lib/timelineInvalidate";
import type { LayoutBox, TimedBlock } from "@/lib/timelineLayout";
import { useToastStore } from "@/lib/toast";

/** 블록이 표시된 날짜(occurrence) — 완료 기록/루틴 EXDATE/메모 키가 블록과 일관되도록. */
export const timelineBlockDate = (block: TimedBlock) => localDateOf(block.startISO);

export function useTimelineScheduleActions() {
  const qc = useQueryClient();

  const handleDeleteSchedule = (box: LayoutBox) => {
    const { block } = box;
    const title = block.title;
    const linkedEventId = block.linkedEventId;
    const calendarId = block.calendarId;
    // 표시된 occurrence의 날짜 — 루틴 EXDATE/복구가 보이는 인스턴스와 일치(연속 타임라인).
    const occDate = timelineBlockDate(block);
    const run = async () => {
      // 모든 kind에서 unschedule 가능 — signal/routine은 linkedEventId 없어도 stage(unschedule)
      // 자체는 동작(타임라인에서만 빼고 카드는 Today 잔류). Google 캐시 제거는 linkedEventId 있을 때만.
      if (block.kind === "signal") {
        const signalId = block.signalId ?? block.id.replace(/^signal:/, "");
        await stage({ kind: "unschedule", targetSignalId: signalId, fromDate: occDate });
        if (linkedEventId && calendarId) removeEventFromCache(qc, calendarId, linkedEventId);
        invalidateSignalCaches(qc);
      } else if (block.kind === "event") {
        const eventId = block.linkedEventId ?? block.id.replace(/^event:/, "");
        await stage({ kind: "eventUnschedule", eventId, calendarId });
        removeEventFromCache(qc, calendarId, eventId);
      } else if (block.kind === "routine" && block.routineId) {
        const routineId = block.routineId;
        // "빼기"는 표시된 occurrence의 날짜(occDate = 블록 startISO의 날짜)를 대상으로
        // EXDATE 한다 — 보던 날짜가 아닌 블록 자신의 날짜라 연속 타임라인에서도 일치.
        // 빼기 = EXDATE: 로컬 skip 행 + 동기화 ON이면 master event EXDATE PATCH.
        await unwrap(commands.unscheduleRoutineToday(routineId, occDate));
        // per-instance Google 이벤트가 있으면(드물게 드래그로 배치됐던 경우) 함께 정리.
        if (linkedEventId && calendarId) {
          await stage({ kind: "routineUnschedule", routineId, date: occDate });
          removeEventFromCache(qc, calendarId, linkedEventId);
          void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
        }
        void qc.invalidateQueries({ queryKey: ["routines"] });
        // 되돌리기 토스트(useTimelineDnd 언스케줄 패턴과 동일 — 자동 dismiss 안에 누르면 복구).
        useToastStore.getState().pushInfo(`타임라인에서 뺐어요: ${title}`, {
          undoLabel: "되돌리기",
          onUndo: () => {
            void unwrap(commands.restoreRoutineToday(routineId, occDate))
              .then(() => qc.invalidateQueries({ queryKey: ["routines"] }))
              .catch((err) => useToastStore.getState().pushError("routine.restore", err));
          },
        });
        return;
      }
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
      useToastStore.getState().pushSuccess(`일정 삭제됨: ${title}`);
    };
    void run().catch((err) => {
      invalidateTimelineAll(qc);
      useToastStore.getState().pushError("calendar.delete", err);
    });
  };

  return { handleDeleteSchedule };
}
