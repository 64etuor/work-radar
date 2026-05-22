import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands } from "@/bindings";

/**
 * 회고(retro) 완료 todo 타임라인 (Phase 17). [start,end] 로컬 날짜 inclusive.
 * 전부 로컬 read — today_done_at 범위. 외부 변경 없음(INVARIANT #2).
 */
export function useCompleted(start: string, end: string) {
  return useQuery({
    queryKey: ["completed", start, end],
    queryFn: () => unwrap(commands.listCompleted(start, end)),
  });
}

/** 회고 쿼리 무효화(태깅 후 갱신). completed/archive 둘 다. */
function useInvalidateRetro() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["completed"] });
    void qc.invalidateQueries({ queryKey: ["archivedSnoozed"] });
  };
}

/** 고임팩트 ⭐ 태그 토글 (사람 결정 — INVARIANT #1). */
export function useSetSignalImpact() {
  const inv = useInvalidateRetro();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      unwrap(commands.setSignalImpact(id, value)),
    onSuccess: inv,
  });
}

/** 후회 ⚠️ (하지말걸) 태그 토글 (사람 결정 — INVARIANT #1). */
export function useSetSignalRegret() {
  const inv = useInvalidateRetro();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      unwrap(commands.setSignalRegret(id, value)),
    onSuccess: inv,
  });
}

/** 보관함: archived + snoozed 열람 (Phase 17). 새 status 없음(snooze/archive 재사용). */
export function useArchivedSnoozed() {
  return useQuery({
    queryKey: ["archivedSnoozed"],
    queryFn: () => unwrap(commands.listArchivedSnoozed()),
  });
}

/** 신호 복원 (archived→미분류, snoozed→원 사분면). 로컬 액션(외부 변경 0). */
export function useRestoreSignal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.restoreSignal(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["archivedSnoozed"] });
      void qc.invalidateQueries({ queryKey: ["signals"] });
    },
  });
}
