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

import { commands } from "@/bindings";
import { IpcError, unwrap } from "@/lib/query/client";
import { invalidateTimelineAll } from "@/lib/timelineInvalidate";
import { useToastStore } from "@/lib/toast";

type FailedPayload = {
  pendingId?: number;
  error?: string;
};

export function useCalendarSyncEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    // listen()은 async — cleanup이 resolve 전에 돌면 unlisten이 영영 호출되지 않아
    // remount마다 리스너가 누적된다. cancelled 플래그로 늦게 도착한 unlisten을 즉시 실행.
    let cancelled = false;
    let disposeFailed: (() => void) | undefined;
    let disposeFlushed: (() => void) | undefined;

    void listen<FailedPayload>("CalendarSyncFailed", (ev) => {
      const detail = ev.payload?.error ?? "원인 미상";
      const pendingId = ev.payload?.pendingId;
      // 프런트-originated 메시지 — pushError(string) 경로로 trace id 자동 생성.
      useToastStore.getState().pushError("calendar.sync", `캘린더 동기화 실패: ${detail}`, {
        onRetry: () => {
          if (pendingId == null) {
            void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
            return;
          }
          void unwrap(commands.retryPendingWrite(pendingId))
            .catch((err: unknown) => {
              const store = useToastStore.getState();
              if (err instanceof IpcError) {
                store.pushError("calendar.retry", err.app);
              } else {
                store.pushError("calendar.retry", err instanceof Error ? err.message : String(err));
              }
            })
            .finally(() => {
              void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
            });
        },
      });
      // 실패 = optimistic 패치 롤백: SSOT에서 재로드. 키 콤보는 timelineInvalidate 정본 —
      // reconciler(applyTimelineCommitToCaches)가 쓰는 캐시 전부(placements·totals·routines 포함)와
      // 대칭이어야 실패한 낙관 패치가 남지 않는다(2026-07-12 감사 #5: signalPlacements 누락).
      invalidateTimelineAll(qc);
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
    }).then((u) => {
      if (cancelled) u();
      else disposeFailed = u;
    });

    void listen("CalendarSyncFlushed", () => {
      // 성공 — 토스트 없음. signal/routine mirror와 큐만 갱신한다.
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
    }).then((u) => {
      if (cancelled) u();
      else disposeFlushed = u;
    });

    return () => {
      cancelled = true;
      disposeFailed?.();
      disposeFlushed?.();
    };
  }, [qc]);
}
