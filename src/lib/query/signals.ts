import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { unwrap, useInvalidate } from "./client";
import {
  commands,
  type AreaTag,
  type CreateSignalInput,
  type Quadrant,
  type SignalStatus,
} from "@/bindings";

/** 매트릭스 + 미분류 카드 (Today로 승격되지 않은 active 신호). */
export function useSignals() {
  return useQuery({
    queryKey: ["signals"],
    queryFn: () => unwrap(commands.listSignals()),
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
    onSuccess: () => {
      inv.signals();
      inv.today();
    },
  });
}

/** 미루기 (snooze). */
export function useSnoozeSignal() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, until }: { id: string; until: string }) =>
      unwrap(commands.snoozeSignal(id, until)),
    onSuccess: () => inv.signals(),
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

/** 라이프 도메인 area 확정/수정(사람 결정, 별개 축 — quadrant 결정 레일과 무관). */
export function useSetSignalArea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, area }: { id: string; area: AreaTag | null }) =>
      unwrap(commands.setSignalArea(id, area)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
}
