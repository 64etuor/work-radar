import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands, type UpdateAgentPromptConfigInput } from "@/bindings";

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

export function useCodexModelCatalog() {
  return useQuery({
    queryKey: ["codexModelCatalog"],
    queryFn: () => unwrap(commands.getCodexModelCatalog()),
    staleTime: Infinity,
    gcTime: Infinity,
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

export function useAgentPromptConfigs() {
  return useQuery({
    queryKey: ["agentPromptConfigs"],
    queryFn: () => unwrap(commands.listAgentPromptConfigs()),
    staleTime: 60_000,
  });
}

export function useUpdateAgentPromptConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentPromptConfigInput) =>
      unwrap(commands.updateAgentPromptConfig(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentPromptConfigs"] }),
  });
}

/**
 * 에이전트 바 박스 이름 (P10b). `agent.name.<sessionKey>` app_config 키에 영속.
 * per-machine 표시 라벨일 뿐 — 결정 레일(#1)/상태 SSOT(signals, #7) 무관.
 */

/** 박스 이름 오버라이드 맵({ sessionKey → name }). 다건 키를 한 번에 폴링하는 단일 쿼리. */
export function useAgentNames(sessionKeys: string[]) {
  // 키 내용으로 안정된 캐시 키 — 박스 집합이 바뀔 때만 재조회.
  const sorted = [...sessionKeys].sort();
  return useQuery<Record<string, string>>({
    queryKey: ["agentNames", sorted],
    queryFn: async () => {
      const entries = await Promise.all(
        sorted.map(async (key) => [key, await unwrap(commands.getAgentName(key))] as const),
      );
      const out: Record<string, string> = {};
      for (const [key, name] of entries) {
        if (name != null && name.trim() !== "") out[key] = name;
      }
      return out;
    },
    staleTime: 60_000,
    enabled: sorted.length > 0,
  });
}

/** 박스 이름 설정(null/빈 문자열 → 삭제 → 기본 라벨 복원). 성공 시 이름 맵 무효화. */
export function useSetAgentName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { sessionKey: string; name: string | null }) =>
      unwrap(commands.setAgentName(args.sessionKey, args.name)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentNames"] }),
  });
}
