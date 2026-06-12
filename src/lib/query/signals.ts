import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateSignalInput,
  type Kind,
  type LifeWheelTagConfig,
  type Quadrant,
  type SignalStatus,
} from "@/bindings";

import { unwrap, useInvalidate } from "./client";

/** ["signals"] + ["today"] 쌍 무효화 — useSetSignalStatus/useSetSignalAreaTagKey/useSetSignalKind 공통. */
function invalidateBoardAndToday(qc: QueryClient, opts?: { withLifeWheelTags?: boolean }) {
  void qc.invalidateQueries({ queryKey: ["signals"] });
  void qc.invalidateQueries({ queryKey: ["today"] });
  if (opts?.withLifeWheelTags) {
    void qc.invalidateQueries({ queryKey: ["lifeWheelTags"] });
  }
}

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

/** 한 줄 braindump → 미분류 카드 생성 (항상 unclassified, dedup). */
export function useCreateSignal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateSignalInput) => unwrap(commands.createSignal(input)),
    onSuccess: () => inv.signals(),
  });
}

/** 사분면 분류 (사람 결정 레일 — INVARIANT #1). */
export function useClassifySignal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, quadrant }: { id: string; quadrant: Quadrant }) =>
      unwrap(commands.classifySignal(id, quadrant)),
    onSuccess: () => inv.signals(),
  });
}

/** 완료/보관 등 상태 변경. */
export function useSetSignalStatus() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: SignalStatus }) =>
      unwrap(commands.setSignalStatus(id, status)),
    onSuccess: (_data, { status }) => {
      inv.signals();
      inv.today();
      if (status === "done") inv.completedHistory();
      if (status === "archived" || status === "snoozed") inv.archivedSnoozed();
    },
  });
}

/** 미루기 (snooze). */
export function useSnoozeSignal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, until }: { id: string; until: string }) =>
      unwrap(commands.snoozeSignal(id, until)),
    onSuccess: () => {
      inv.signals();
      inv.archivedSnoozed();
    },
  });
}

/** 브레인덤프 카드 제목 인라인 편집 (dedup 키 갱신, Phase 15 #5). */
export function useUpdateSignalTitle() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      unwrap(commands.updateSignalTitle(id, title)),
    onSuccess: () => inv.signals(),
  });
}

/** 카드 하드 삭제 (영구 — archive와 구분, Phase 15 #5). */
export function useDeleteSignal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteSignal(id)),
    onSuccess: () => inv.signals(),
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tags: LifeWheelTagConfig[]) => unwrap(commands.setLifeWheelTags(tags)),
    onSuccess: () => invalidateBoardAndToday(qc, { withLifeWheelTags: true }),
  });
}

/** Life Wheel 단일 선택. 커스텀 tag key도 허용한다. */
export function useSetSignalAreaTagKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tagKey }: { id: string; tagKey: string | null }) =>
      unwrap(commands.setSignalAreaTagKey(id, tagKey)),
    onSuccess: () => invalidateBoardAndToday(qc),
  });
}

/** 개인/업무 kind manual override. */
export function useSetSignalKind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: Kind | null }) =>
      unwrap(commands.setSignalKind(id, kind)),
    onSuccess: () => invalidateBoardAndToday(qc),
  });
}
