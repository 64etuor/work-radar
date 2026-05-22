import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands } from "@/bindings";

/**
 * Codex 에이전트 설정 훅 (B2). 모델 선택을 app_config(SQLite)에서 읽고 쓴다.
 * 비밀이 아닌 설정값이므로 keychain 없이 app_config upsert.
 */

/** 저장된 Codex 모델(미설정 시 None → codex 기본 동작). */
export function useCodexModel() {
  return useQuery<string | null>({
    queryKey: ["codexModel"],
    queryFn: () => unwrap(commands.getCodexModel()),
    staleTime: 60_000,
  });
}

/** Codex 모델 설정(None 또는 빈 문자열이면 삭제 → 기본값으로 복원). */
export function useSetCodexModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (model: string | null) => unwrap(commands.setCodexModel(model)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["codexModel"] }),
  });
}
