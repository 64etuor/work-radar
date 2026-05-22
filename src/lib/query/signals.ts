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
  type PromotionTarget,
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

/**
 * 캘린더 승격 = Promotion draft만 (외부 무변경, Acceptance 대기 — INVARIANT #2, 실제 write는 Phase 11).
 * 외부 상태를 바꾸지 않으므로 매트릭스/Today를 invalidate하지 않는다.
 */
export function useCreatePromotionDraft() {
  return useMutation({
    mutationFn: ({ signalId, target }: { signalId: string; target: PromotionTarget }) =>
      unwrap(commands.createPromotionDraft(signalId, target)),
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
