/**
 * 낙관 업데이트 공용 헬퍼 (선례: useToggleRoutineCheck의 snapshot/rollback 확장).
 *
 * 규율:
 * - **사용자 발동 로컬 SQLite 뮤테이션만** 낙관 패치한다. 외부 네트워크(staged) 작업은
 *   낙관 확정 금지 — INVARIANT #2 (`optimisticSchedule.ts` 참조).
 * - **파생 집계는 손으로 재계산하지 않는다** — todayOverview/weeklyReview/completedHistory
 *   (InfiniteData)는 패치 대상이 아니고, 정합은 onSettled invalidate가 맡는다.
 * - 표준 배선: `onMutate`에서 `snapshotQueries`(cancel+스냅샷) 후 패치, `onError`에서 롤백,
 *   `onSettled`에서 기존 invalidate 헬퍼로 서버 상태와 수렴.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { WorkSignal } from "@/bindings";

/**
 * WorkSignal[] 평면 리스트를 들고 있는 쿼리 키 prefix 전부 — 같은 카드가 여러 표면
 * (매트릭스/Today 레일/검색/회고)에 동시에 보이므로 필드 패치는 전 표면에 일관 반영한다.
 * ["completedHistory"]는 InfiniteData라 제외(invalidate로만 수렴).
 */
export const SIGNAL_LIST_PREFIXES: readonly QueryKey[] = [
  ["signals"],
  ["signalSearch"],
  ["today"],
  ["completed"],
  ["archivedSnoozed"],
];

/**
 * 진행 중 refetch 취소 + 현재 캐시 스냅샷 캡처. 반환값은 onError 롤백 함수.
 * cancel 없이 패치하면 in-flight 응답이 낙관 상태를 덮어쓸 수 있다.
 */
export async function snapshotQueries(
  qc: QueryClient,
  prefixes: readonly QueryKey[],
): Promise<() => void> {
  await Promise.all(prefixes.map((queryKey) => qc.cancelQueries({ queryKey })));
  const snapshots = prefixes.flatMap((queryKey) => qc.getQueriesData({ queryKey }));
  return () => {
    for (const [key, data] of snapshots) qc.setQueryData(key, data);
  };
}

/** 해당 id 카드의 필드를 모든 WorkSignal[] 캐시에서 즉시 갱신 (멤버십 불변). */
export function patchSignalInLists(qc: QueryClient, id: string, patch: Partial<WorkSignal>): void {
  for (const queryKey of SIGNAL_LIST_PREFIXES) {
    qc.setQueriesData<WorkSignal[]>({ queryKey }, (old) =>
      old?.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }
}

/** 해당 id 카드를 주어진 리스트 캐시들에서 즉시 제거 (완료/보관/스누즈/삭제). */
export function removeSignalFromLists(
  qc: QueryClient,
  id: string,
  prefixes: readonly QueryKey[] = SIGNAL_LIST_PREFIXES,
): void {
  for (const queryKey of prefixes) {
    qc.setQueriesData<WorkSignal[]>({ queryKey }, (old) =>
      old?.some((s) => s.id === id) ? old.filter((s) => s.id !== id) : old,
    );
  }
}

/**
 * Today 승격 낙관 이동: 매트릭스(["signals"])에서 빼고 ["today", date] 끝에 붙인다.
 * (보드 규약 — 카드는 매트릭스에서 *이동*, 원 quadrant는 배지로 유지.)
 */
export function moveSignalToToday(qc: QueryClient, id: string, date: string): void {
  let moved: WorkSignal | undefined;
  qc.setQueriesData<WorkSignal[]>({ queryKey: ["signals"] }, (old) => {
    if (!old) return old;
    moved = old.find((s) => s.id === id) ?? moved;
    return old.filter((s) => s.id !== id);
  });
  if (!moved) return;
  const promoted: WorkSignal = { ...moved, todayForDate: date, todayDoneAt: null };
  qc.setQueriesData<WorkSignal[]>({ queryKey: ["today", date] }, (old) =>
    old ? [...old, promoted] : old,
  );
}

/** 승격 취소 낙관 이동: 모든 ["today", *]에서 빼고 매트릭스로 복귀(원 quadrant 필드 그대로). */
export function moveSignalFromToday(qc: QueryClient, id: string): void {
  let moved: WorkSignal | undefined;
  qc.setQueriesData<WorkSignal[]>({ queryKey: ["today"] }, (old) => {
    if (!old) return old;
    moved = old.find((s) => s.id === id) ?? moved;
    return old.filter((s) => s.id !== id);
  });
  if (!moved) return;
  const restored: WorkSignal = { ...moved, todayForDate: null, todayDoneAt: null };
  qc.setQueriesData<WorkSignal[]>({ queryKey: ["signals"] }, (old) =>
    old ? [...old, restored] : old,
  );
}

/**
 * 드래그 리오더 낙관 반영. orderedIds와 멤버십이 정확히 일치하는 캐시만 재정렬한다
 * (다른 날짜의 부분 겹침 리스트를 오염시키지 않도록). rank 영속은 invalidate가 수렴.
 */
export function reorderListCache<T extends { id: string }>(
  qc: QueryClient,
  prefix: QueryKey,
  orderedIds: string[],
): void {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  qc.setQueriesData<T[]>({ queryKey: prefix }, (old) => {
    if (!old || old.length !== orderedIds.length) return old;
    if (!old.every((item) => pos.has(item.id))) return old;
    return [...old].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  });
}

/** Life Wheel 단일 태그 선택의 표시 필드 패치 — 칩은 parseAreaTagKeys(areaTags, area)로 읽는다. */
export function areaTagPatch(
  tagKey: string | null,
): { areaTags: string | null; area: null } | { areaTags: string } {
  return tagKey ? { areaTags: JSON.stringify([tagKey]) } : { areaTags: null, area: null };
}
