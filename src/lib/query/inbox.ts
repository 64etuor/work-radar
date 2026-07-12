import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type InboxCounts, type InboxItem } from "@/bindings";

import { unwrap } from "./client";
import { snapshotQueries } from "./optimistic";

export function useInboxItems(source: string | null = null, includeDismissed = false) {
  return useQuery<InboxItem[]>({
    queryKey: ["inboxItems", source, includeDismissed],
    queryFn: () => unwrap(commands.listInboxItems(source, includeDismissed)),
    refetchInterval: 60_000,
  });
}

export function useInboxCounts() {
  return useQuery<InboxCounts>({
    queryKey: ["inboxCounts"],
    queryFn: () => unwrap(commands.inboxCounts()),
    refetchInterval: 60_000,
  });
}

// ── 낙관 헬퍼 (읽음/무시가 클릭 즉시 반영되도록 — 60s 폴링/refetch 왕복 대기 제거) ────────

/** 로드된 아무 inboxItems 캐시에서 대상 행을 찾는다 — 카운터 델타는 패치 *전* 값으로 계산. */
function findInboxItem(qc: QueryClient, id: string): InboxItem | undefined {
  for (const [, items] of qc.getQueriesData<InboxItem[]>({ queryKey: ["inboxItems"] })) {
    const hit = items?.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** 벨 배지 카운터 즉시 보정(음수 방지 클램프). 정확한 값은 onSettled invalidate가 수렴. */
function patchInboxCounts(qc: QueryClient, delta: Partial<InboxCounts>): void {
  qc.setQueryData<InboxCounts>(["inboxCounts"], (old) =>
    old
      ? {
          unread: Math.max(0, old.unread + (delta.unread ?? 0)),
          critical: Math.max(0, old.critical + (delta.critical ?? 0)),
          open: Math.max(0, old.open + (delta.open ?? 0)),
        }
      : old,
  );
}

const INBOX_PREFIXES = [["inboxItems"], ["inboxCounts"]] as const;

export function useMarkInboxItemRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.markInboxItemRead(id)),
    onMutate: async (id) => {
      const rollback = await snapshotQueries(qc, INBOX_PREFIXES);
      const prev = findInboxItem(qc, id);
      qc.setQueriesData<InboxItem[]>({ queryKey: ["inboxItems"] }, (old) =>
        old?.map((i) => (i.id === id ? { ...i, unread: false } : i)),
      );
      // 백엔드 집계: unread만 unread 조건 — critical은 비-dismissed 기준이라 읽음 처리로 안 준다.
      if (prev?.unread) patchInboxCounts(qc, { unread: -1 });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["inboxItems"] });
      void qc.invalidateQueries({ queryKey: ["inboxCounts"] });
    },
  });
}

export function useDismissInboxItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.dismissInboxItem(id)),
    onMutate: async (id) => {
      const rollback = await snapshotQueries(qc, INBOX_PREFIXES);
      const prev = findInboxItem(qc, id);
      // includeDismissed=false 리스트에선 행 제거, true 리스트에선 dismissed로 마킹(유지).
      for (const [key, items] of qc.getQueriesData<InboxItem[]>({ queryKey: ["inboxItems"] })) {
        if (!items) continue;
        const includeDismissed = key[2] === true;
        qc.setQueryData<InboxItem[]>(
          key,
          includeDismissed
            ? items.map((i) => (i.id === id ? { ...i, status: "dismissed", unread: false } : i))
            : items.filter((i) => i.id !== id),
        );
      }
      if (prev && prev.status !== "dismissed") {
        // 백엔드 집계 미러: dismiss는 비-dismissed 기준인 critical에서도 빠진다(unread 무관).
        patchInboxCounts(qc, {
          open: -1,
          unread: prev.unread ? -1 : 0,
          critical: prev.severity === "critical" ? -1 : 0,
        });
      }
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["inboxItems"] });
      void qc.invalidateQueries({ queryKey: ["inboxCounts"] });
    },
  });
}
