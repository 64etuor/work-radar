import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type TimelineNote, type TimelineNoteTarget } from "@/bindings";

import { unwrap } from "./client";

type Key = { targetKind: TimelineNoteTarget; targetId: string; date: string };

/** 단일 메모 조회. backend가 None이면 null 반환.
 *  TodayView가 이미 날짜별 벌크(["timelineNotesForDate"])를 로드하므로, 팝오버 첫 오픈은
 *  그 캐시에서 즉시 시딩(placeholderData) — 비활성 셸 대기 없이 메모가 바로 보인다. */
export function useTimelineNote(key: Key | null) {
  const qc = useQueryClient();
  return useQuery<TimelineNote | null>({
    queryKey: ["timelineNote", key],
    enabled: key !== null,
    placeholderData: () => {
      if (!key) return undefined;
      const bulk = qc.getQueryData<TimelineNote[]>(["timelineNotesForDate", key.date]);
      if (!bulk) return undefined; // 벌크 미로드면 시딩 불가 — 기존 로딩 셸 유지.
      return (
        bulk.find((n) => n.targetKind === key.targetKind && n.targetId === key.targetId) ?? null
      );
    },
    queryFn: async () => {
      if (!key) return null;
      const res = await unwrap(commands.getTimelineNote(key.targetKind, key.targetId, key.date));
      return res ?? null;
    },
  });
}

/** 한 날짜의 모든 메모(signal/routine/event 통합) — N+1 회피용 prefetch. */
export function useTimelineNotesForDate(date: string | null) {
  return useQuery<TimelineNote[]>({
    queryKey: ["timelineNotesForDate", date],
    enabled: date !== null,
    queryFn: () => unwrap(commands.listTimelineNotesForDate(date as string)),
  });
}

/** 연속 타임라인용 — 로드된 날짜들의 메모 통합(useQueries, 키는 단일일 훅과 동일). */
export function useTimelineNotesForDates(dates: string[]) {
  return useQueries({
    queries: dates.map((date) => ({
      queryKey: ["timelineNotesForDate", date] as const,
      queryFn: () => unwrap(commands.listTimelineNotesForDate(date)),
    })),
    combine: (results) => ({ all: results.flatMap((r) => r.data ?? []) }),
  });
}

/** 메모 upsert — body trim 빈문자열이면 backend가 행 삭제 + null 반환. */
export function useUpsertTimelineNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: Key & { body: string }) =>
      unwrap(commands.upsertTimelineNote(args.targetKind, args.targetId, args.date, args.body)),
    onSuccess: (_, vars) => {
      // 개별 키 + 날짜별 리스트(N+1 회피용) 캐시 무효화.
      void qc.invalidateQueries({
        queryKey: [
          "timelineNote",
          { targetKind: vars.targetKind, targetId: vars.targetId, date: vars.date },
        ],
      });
      void qc.invalidateQueries({ queryKey: ["timelineNotesForDate", vars.date] });
    },
  });
}
