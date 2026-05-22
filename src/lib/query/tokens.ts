import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { unwrap } from "./client";
import {
  commands,
  type TokenKind,
} from "@/bindings";

/** 토큰 존재 여부만(본문 미노출 — INVARIANT). 마스킹 표시용. */
export function useProjectTokenStatus(projectId: string) {
  return useQuery({
    queryKey: ["tokenStatus", projectId],
    queryFn: () => unwrap(commands.projectTokenStatus(projectId)),
    enabled: !!projectId,
  });
}

/**
 * 토큰 저장. 토큰은 IPC 인자로만 전달되고 캐시에 저장하지 않는다(INVARIANT: 렌더러 미노출).
 * 성공 후 token status만 무효화한다(본문 아님).
 */
export function useSetProjectToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      kind,
      token,
    }: {
      projectId: string;
      kind: TokenKind;
      token: string;
    }) => unwrap(commands.setProjectToken(projectId, kind, token)),
    onSuccess: (_data, v) =>
      qc.invalidateQueries({ queryKey: ["tokenStatus", v.projectId] }),
  });
}

/** 토큰 삭제(클리어). */
export function useDeleteProjectToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, kind }: { projectId: string; kind: TokenKind }) =>
      unwrap(commands.deleteProjectToken(projectId, kind)),
    onSuccess: (_data, v) =>
      qc.invalidateQueries({ queryKey: ["tokenStatus", v.projectId] }),
  });
}

/** 토큰으로 외부 API ping(read-only). 결과(PingResult)를 호출부가 표시. */
export function usePingProjectToken() {
  return useMutation({
    mutationFn: ({ projectId, kind }: { projectId: string; kind: TokenKind }) =>
      unwrap(commands.pingProjectToken(projectId, kind)),
  });
}
