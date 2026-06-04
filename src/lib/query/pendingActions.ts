import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type PendingAction } from "@/bindings";
import { useToastStore } from "@/lib/toast";

import { IpcError, unwrap } from "./client";

/**
 * 승인 대기 외부 액션 큐. 외부 에이전트(MCP/codex/hermes)가 비동기로 enqueue하므로
 * 새 제안이 반응적으로 떠야 한다 → inbox와 동일한 60s 폴링으로 자동 refresh.
 */
export function usePendingActions() {
  return useQuery<PendingAction[]>({
    queryKey: ["pendingActions"],
    queryFn: () => unwrap(commands.listPendingActions()),
    refetchInterval: 60_000,
  });
}

export function useApproveExternalAction() {
  const qc = useQueryClient();
  const pushError = useToastStore((s) => s.pushError);
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.approveExternalAction(id)),
    // approve는 상태머신을 진행시키므로 커넥터 실행 실패도 Ok("failed")로 반환된다(IPC 에러 아님).
    // 그 "failed"를 삼키면 액션이 큐에서 사라지기만 해 사용자가 실패를 모른다 → 명시 노출.
    onSuccess: (status) => {
      void qc.invalidateQueries({ queryKey: ["pendingActions"] });
      if (status === "failed") {
        pushError("external-action", "외부 액션 실행에 실패했습니다 — 감사 로그를 확인하세요.");
      }
    },
    // terminal failure 노출(INVARIANT) — 승인 IPC 자체 실패도 삼키지 않는다.
    onError: (e) =>
      pushError("external-action", e instanceof IpcError ? e.app : `승인 실패: ${String(e)}`),
  });
}

export function useRejectExternalAction() {
  const qc = useQueryClient();
  const pushError = useToastStore((s) => s.pushError);
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.rejectExternalAction(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pendingActions"] });
    },
    // terminal failure 노출(INVARIANT) — 거절 실패를 삼키지 않는다.
    onError: (e) =>
      pushError("external-action", e instanceof IpcError ? e.app : `거절 실패: ${String(e)}`),
  });
}
