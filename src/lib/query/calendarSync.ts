/**
 * Today×Timeline pending_calendar_writes 큐 관찰/제어 hooks(PR 5 Task 5).
 *
 * - `usePendingWrites`: 큐 스냅샷(이벤트+invalidate가 주 경로, 15s 폴링은 safety-net).
 * - `useCommitStagedWrites`: cross-cal Acceptance 게이트(staged=true 행을 풀어 워커가 즉시 가져감).
 * - `useCancelPendingWrites`: staged 행 취소(외부 호출 없음 — cross-cal 이동 롤백).
 *
 * INVARIANT: 외부 네트워크 호출은 워커에만 — 본 hooks는 큐 SQL과 이벤트만 본다.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { commands, type PendingWrite } from "@/bindings";
import { unwrap } from "@/lib/query/client";

/** pending_calendar_writes 폴링 — staged "변경 N건" 카운트를 산출하는 단일 소스. */
export function usePendingWrites() {
  const qc = useQueryClient();

  // CalendarSyncFlushed / CalendarSyncFailed 이벤트가 오면 즉시 재조회(폴링 보강).
  useEffect(() => {
    // listen()은 async — cleanup이 resolve 전에 돌면 unlisten 미호출로 리스너 누적.
    let cancelled = false;
    let dispose1: (() => void) | undefined;
    let dispose2: (() => void) | undefined;
    void listen("CalendarSyncFlushed", () => {
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
    }).then((u) => {
      if (cancelled) u();
      else dispose1 = u;
    });
    void listen("CalendarSyncFailed", () => {
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
    }).then((u) => {
      if (cancelled) u();
      else dispose2 = u;
    });
    return () => {
      cancelled = true;
      dispose1?.();
      dispose2?.();
    };
  }, [qc]);

  return useQuery<PendingWrite[]>({
    queryKey: ["pendingWrites"],
    queryFn: () => unwrap(commands.listPendingWrites()),
    // 이벤트(위 CalendarSyncFlushed/Failed)+드래그 액션의 직접 invalidate가 주 freshness 경로 —
    // 폴링은 그 둘이 못 잡는 경우를 위한 safety-net이라 15s로 완화.
    refetchInterval: 15_000,
  });
}

/** staged=true 행들에서 staged 플래그 제거 + 워커 깨우기(Acceptance). */
export function useCommitStagedWrites() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => unwrap(commands.commitStagedWrites(ids)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pendingWrites"] }),
  });
}

/** staged=true 행들을 큐에서 제거(외부 호출 없음 — cross-cal 이동 롤백, Acceptance 반대편). */
export function useCancelPendingWrites() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) =>
      Promise.all(ids.map((id) => unwrap(commands.cancelPendingWrite(id)))).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pendingWrites"] }),
  });
}

/** payload_json이 `"staged":true`를 담는지(워커가 skip하는 cross-cal 게이트 표식). */
export function isStaged(p: PendingWrite): boolean {
  // build_queue_row의 moveCalendar는 `serde_json::json!({..., "staged": true})`로 직렬화.
  // 큰 payload여도 검사 비용은 미미 — 폴링 빈도와 큐 규모(소수) 감안.
  return p.payload_json.includes('"staged":true');
}
