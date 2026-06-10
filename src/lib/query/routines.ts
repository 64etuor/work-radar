import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateRoutineInput,
  type Kind,
  type RoutineToday,
  type UpdateRoutineInput,
  type Weekday,
} from "@/bindings";

import { unwrap, useInvalidate } from "./client";

/** 오늘 해당하는 루틴 + 날짜별 완료 상태. */
export function useTodayRoutines(date: string, weekday: Weekday) {
  return useQuery({
    queryKey: ["routines", date],
    queryFn: () => unwrap(commands.listTodayRoutines(date, weekday)),
  });
}

/** 루틴 트래킹(이행률/streak/히스토리) — endDate 기준 지난 days일. */
export function useRoutineTracking(endDate: string, days: number) {
  return useQuery({
    queryKey: ["routine-tracking", endDate, days],
    queryFn: () => unwrap(commands.routineTracking(endDate, days)),
  });
}

// ── Mutations (관련 쿼리 invalidate) ───────────────────────────────────────────

/** 루틴 추가. */
export function useCreateRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateRoutineInput) => unwrap(commands.createRoutine(input)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 수정. 동기화 루틴은 Google PATCH 전파가 실패해도 로컬 변경은 커밋되므로(서버
 *  patch_failed 에러여도), onSettled로 무효화해 화면이 항상 최신 로컬 상태를 반영한다. */
export function useUpdateRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateRoutineInput) => unwrap(commands.updateRoutine(input)),
    onSettled: () => inv.routines(),
  });
}

/** 루틴 삭제. 동기화 ON이면 Google master event를 먼저 지운다(실패 시 delete_remote_failed —
 *  호출부가 "로컬만 삭제" confirm 후 useDeleteRoutineLocalOnly로 진행). onSettled로 무효화해
 *  실패 후에도 화면이 최신 로컬 상태를 반영하게 한다. */
export function useDeleteRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteRoutine(id)),
    onSettled: () => inv.routines(),
  });
}

/** 루틴을 로컬에서만 삭제(Google master event 무시). delete가 Google 삭제에 실패했을 때의
 *  사용자 confirm fallback. */
export function useDeleteRoutineLocalOnly() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteRoutineLocalOnly(id)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 재정렬 (드래그, rank 영속). */
export function useReorderRoutines() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (orderedIds: string[]) => unwrap(commands.reorderRoutines(orderedIds)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 kind 즉시 갱신 (personal/work 토글, signals 패턴 미러). */
export function useSetRoutineKind() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: Kind | null }) =>
      unwrap(commands.setRoutineKind(id, kind)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 Life Wheel tag key 갱신 (커스텀 키 허용, signals 패턴 미러). */
export function useSetRoutineAreaTagKey() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, tagKey }: { id: string; tagKey: string | null }) =>
      unwrap(commands.setRoutineAreaTagKey(id, tagKey)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 Google Calendar 동기화 ON (kind 일치 프로젝트 + 그 캘린더). */
export function useEnableRoutineGoogleSync() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({
      routineId,
      projectId,
      calendarId,
    }: {
      routineId: string;
      projectId: string;
      calendarId: string;
    }) => unwrap(commands.enableRoutineGoogleSync(routineId, projectId, calendarId)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 Google Calendar 동기화 OFF (master event 삭제 + 로컬 mirror 정리). */
export function useDisableRoutineGoogleSync() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (routineId: string) => unwrap(commands.disableRoutineGoogleSync(routineId)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 동기화 캘린더 이동 (옛 master 삭제 + 새 캘린더에 master 생성). Google API가 calendarId
 *  PATCH를 지원하지 않아 DELETE+CREATE. 실패해도 로컬 mirror는 truthful하게 반영되므로 onSettled
 *  무효화. */
export function useMoveRoutineGoogleSync() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({
      routineId,
      projectId,
      calendarId,
    }: {
      routineId: string;
      projectId: string;
      calendarId: string;
    }) => unwrap(commands.moveRoutineGoogleSync(routineId, projectId, calendarId)),
    onSettled: () => inv.routines(),
  });
}

/** 루틴 완료 토글 (날짜별, 다음날 리셋). 최빈 상호작용이라 optimistic — 체크가 즉시 뒤집히고,
 *  실패 시 스냅샷 롤백, settle 시 무효화로 서버 상태와 수렴한다. */
export function useToggleRoutineCheck() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ routineId, date, done }: { routineId: string; date: string; done: boolean }) =>
      unwrap(commands.toggleRoutineCheck(routineId, date, done)),
    onMutate: async ({ routineId, date, done }) => {
      await qc.cancelQueries({ queryKey: ["routines", date] });
      const prev = qc.getQueryData<RoutineToday[]>(["routines", date]);
      qc.setQueryData<RoutineToday[]>(["routines", date], (old) =>
        old?.map((r) => (r.id === routineId ? { ...r, done } : r)),
      );
      return { prev, date };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["routines", ctx.date], ctx.prev);
    },
    onSettled: () => inv.routines(),
  });
}

// ── Phase 2: Projects / Repos / 토큰 ────────────────────────────────────────────
