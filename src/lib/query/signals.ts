import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateSignalInput,
  type Kind,
  type LifeWheelTagConfig,
  type Quadrant,
  type SignalStatus,
  type WorkSignal,
} from "@/bindings";

import { unwrap, useInvalidate } from "./client";
import {
  areaTagPatch,
  OPTIMISTIC_SIGNAL_PREFIX,
  patchSignalInLists,
  removeSignalFromLists,
  SIGNAL_LIST_PREFIXES,
  snapshotQueries,
} from "./optimistic";

/** 매트릭스 + 미분류 카드 (Today로 승격되지 않은 active 신호). */
export function useSignals() {
  return useQuery({
    queryKey: ["signals"],
    queryFn: () => unwrap(commands.listSignals()),
  });
}

/**
 * FTS5 전역 시그널 검색(제목/본문). 백엔드가 빈 쿼리에 빈 결과를 주므로, 2자 미만은 아예
 * 비활성(불필요한 fetch 회피). 읽기 전용 — 팔레트 검색 결과 그룹이 소비한다.
 */
export function useSearchSignals(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["signalSearch", q],
    queryFn: () => unwrap(commands.searchSignals(q)),
    enabled: q.length >= 2,
    staleTime: 5_000,
  });
}

/** 한 줄 braindump → 미분류 카드 생성 (항상 unclassified, dedup).
 *  캡처는 앱의 테제 표면이라 optimistic — Enter 즉시 임시 카드가 보드에 붙고, 서버 행 도착 시
 *  스왑된다. dedup upsert가 기존 행(이미 분류/Today/완료)을 돌려줄 수 있어 무조건 스왑하지 않고
 *  매트릭스 멤버십 조건(fetch_signals 미러: today 미승격 + active 상태)을 확인한다. */
export function useCreateSignal() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateSignalInput) => unwrap(commands.createSignal(input)),
    onMutate: async (input) => {
      const rollback = await snapshotQueries(qc, [["signals"]]);
      const tempId = `${OPTIMISTIC_SIGNAL_PREFIX}${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const temp: WorkSignal = {
        id: tempId,
        projectId: input.projectId,
        title: input.title,
        body: null,
        source: "braindump",
        type: "thought",
        quadrant: "unclassified",
        suggestedQuadrant: null,
        kind: input.kind,
        area: null,
        areaTags: null,
        suggestedArea: null,
        status: "new",
        snoozeUntil: null,
        todayForDate: null,
        todayDoneAt: null,
        todayRank: null,
        impactHigh: null,
        regret: null,
        scheduledAt: null,
        scheduledDuration: null,
        linkedEventId: null,
        linkedCalendarId: null,
        createdAt: now,
        updatedAt: now,
      };
      // 서버 정렬(created_at ASC)과 같은 꼬리 위치에 붙인다 — 실제 행 도착 시 위치가 안 튄다.
      qc.setQueriesData<WorkSignal[]>({ queryKey: ["signals"] }, (old) =>
        old ? [...old, temp] : old,
      );
      return { rollback, tempId };
    },
    onSuccess: (created, _input, ctx) => {
      if (!ctx) return;
      qc.setQueriesData<WorkSignal[]>({ queryKey: ["signals"] }, (old) => {
        if (!old) return old;
        const without = old.filter((s) => s.id !== ctx.tempId);
        const active =
          created.status !== "done" &&
          created.status !== "archived" &&
          created.status !== "snoozed";
        const belongs = created.todayForDate == null && active;
        if (!belongs || without.some((s) => s.id === created.id)) return without;
        return [...without, created];
      });
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.signals(),
  });
}

/** 사분면 분류 (사람 결정 레일 — INVARIANT #1). 드래그 직후 zone 배지가 즉시 갱신되도록
 *  optimistic — 사람이 내린 결정을 화면에 먼저 반영할 뿐, 결정 주체는 그대로 사람이다. */
export function useClassifySignal() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, quadrant }: { id: string; quadrant: Quadrant }) =>
      unwrap(commands.classifySignal(id, quadrant)),
    onMutate: async ({ id, quadrant }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, { quadrant });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.signals(),
  });
}

/** 완료/보관 등 상태 변경 — 카드가 즉시 리스트에서 빠지도록 optimistic 제거.
 *  completed/archivedSnoozed 편입은 invalidate가 수렴(파생 리스트 손계산 금지). */
export function useSetSignalStatus() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: SignalStatus }) =>
      unwrap(commands.setSignalStatus(id, status)),
    onMutate: async ({ id, status }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      if (status === "done" || status === "archived" || status === "snoozed") {
        removeSignalFromLists(qc, id, [["signals"], ["signalSearch"], ["today"]]);
      } else {
        patchSignalInLists(qc, id, { status });
      }
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: (_data, _err, { status }) => {
      void inv.boardAndToday();
      if (status === "done") void inv.completedHistory();
      if (status === "archived" || status === "snoozed") void inv.archivedSnoozed();
    },
  });
}

/** 미루기 (snooze) — 카드가 즉시 매트릭스에서 빠지도록 optimistic 제거. */
export function useSnoozeSignal() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, until }: { id: string; until: string }) =>
      unwrap(commands.snoozeSignal(id, until)),
    onMutate: async ({ id }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      removeSignalFromLists(qc, id, [["signals"], ["signalSearch"]]);
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => {
      void inv.signals();
      void inv.archivedSnoozed();
    },
  });
}

/** 브레인덤프 카드 제목 인라인 편집 (dedup 키 갱신, Phase 15 #5) — 커밋 직후 구 제목
 *  플래시 방지 optimistic. */
export function useUpdateSignalTitle() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      unwrap(commands.updateSignalTitle(id, title)),
    onMutate: async ({ id, title }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, { title });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.signals(),
  });
}

/** 카드 하드 삭제 (영구 — archive와 구분, Phase 15 #5) — 즉시 제거 optimistic. */
export function useDeleteSignal() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteSignal(id)),
    onMutate: async (id) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      removeSignalFromLists(qc, id);
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.signals(),
  });
}

/** Life Wheel 팔레트 설정. 기본 enum + 사용자 커스텀 태그/색/노출. */
export function useLifeWheelTags() {
  return useQuery({
    queryKey: ["lifeWheelTags"],
    queryFn: () => unwrap(commands.getLifeWheelTags()),
    staleTime: 60_000,
  });
}

export function useSetLifeWheelTags() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (tags: LifeWheelTagConfig[]) => unwrap(commands.setLifeWheelTags(tags)),
    onSuccess: () => inv.boardAndToday({ withLifeWheelTags: true }),
  });
}

/** Life Wheel 단일 선택. 커스텀 tag key도 허용 — 칩 색/라벨 즉시 반영 optimistic. */
export function useSetSignalAreaTagKey() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, tagKey }: { id: string; tagKey: string | null }) =>
      unwrap(commands.setSignalAreaTagKey(id, tagKey)),
    onMutate: async ({ id, tagKey }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, areaTagPatch(tagKey));
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.boardAndToday(),
  });
}

/** 개인/업무 kind manual override — 칩 즉시 반영 optimistic. */
export function useSetSignalKind() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: Kind | null }) =>
      unwrap(commands.setSignalKind(id, kind)),
    onMutate: async ({ id, kind }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, { kind });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.boardAndToday(),
  });
}
