/**
 * CalendarSyncFailed/Flushed 이벤트 구독(PR 5 Task 6, 스펙 §6.4).
 *
 * Rust 워커가 실패 시 `CalendarSyncFailed { pendingId, error }`를 emit한다(terminal 또는
 * transient 예산 소진 후). 프런트는 토스트로 노출 + signals/today/calendarEvents 캐시 무효화로
 * SSOT(SQLite)에서 재로드 = optimistic 패치의 롤백 효과.
 *
 * Flushed는 성공 알림 — toast 없이 큐만 갱신(usePendingWrites도 같은 이벤트를 본다).
 * 성공 시 calendarEvents는 무효화하지 않는다. Rust fetch TTL이 방금 PATCH 전 이벤트를
 * 돌려줄 수 있어 optimistic 위치/길이를 원위치로 되돌리는 원인이 된다.
 */
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { useToastStore } from "@/lib/toast";

type FailedPayload = {
  pendingId?: number;
  error?: string;
};

export function useCalendarSyncEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    let disposeFailed: (() => void) | undefined;
    let disposeFlushed: (() => void) | undefined;

    void listen<FailedPayload>("CalendarSyncFailed", (ev) => {
      const detail = ev.payload?.error ?? "원인 미상";
      // 프런트-originated 메시지 — pushError(string) 경로로 trace id 자동 생성.
      useToastStore.getState().pushError("calendar.sync", `캘린더 동기화 실패: ${detail}`, {
        onRetry: () => {
          void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
        },
      });
      // 실패 = optimistic 패치 롤백: SSOT에서 재로드.
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
    }).then((u) => {
      disposeFailed = u;
    });

    void listen("CalendarSyncFlushed", () => {
      // 성공 — 토스트 없음. signal/routine mirror와 큐만 갱신한다.
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
    }).then((u) => {
      disposeFlushed = u;
    });

    return () => {
      disposeFailed?.();
      disposeFlushed?.();
    };
  }, [qc]);
}
