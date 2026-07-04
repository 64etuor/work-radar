import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type SprintConfig, type SprintSaveResult, type SprintStatus } from "@/bindings";

import { unwrap } from "./client";

/**
 * 스프린트 타이머 설정 훅 (P11). 단일 글로벌 스프린트를 app_config(SQLite)에서 읽고 쓴다.
 * INVARIANT #7: per-machine 설정 — 상태 SSOT(signals) 무관. 비밀 아님(keychain 불필요).
 * 모델 = 길이(interval_days) + 경계 앵커(요일 + 시각). 다음 경계는 프런트 순수함수로 계산한다.
 */

export type { SprintConfig, SprintSaveResult, SprintStatus };

/** 저장된 스프린트 설정(미설정 시 null → 헤더 empty "스프린트 설정" 링크). */
export function useSprintConfig() {
  return useQuery<SprintConfig | null>({
    queryKey: ["sprintConfig"],
    queryFn: () => unwrap(commands.getSprintConfig()),
    staleTime: 60_000,
  });
}

/**
 * 다음 경계 + 남은 초(SSOT = Rust `next_boundary` 직접 구현). 미설정 시 null.
 * 경계는 절대시각이 아니라 anchor+interval로 매번 계산되므로 drift 없음 — 헤더는 이 경계 문자열로
 * 로컬 1s tick 표시만 한다. 분 단위로 재조회(경계 도달 시 다음 주기 자동 반영).
 */
export function useSprintStatus(enabled = true) {
  return useQuery<SprintStatus | null>({
    queryKey: ["sprintStatus"],
    queryFn: () => unwrap(commands.sprintStatus()),
    staleTime: 60_000,
    refetchInterval: 60_000,
    enabled,
  });
}

/** 스프린트 설정 저장(검증은 Rust). 성공 시 설정 무효화 → 헤더 즉시 반영. */
export function useSetSprintConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: SprintConfig) => unwrap(commands.setSprintConfig(config)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sprintConfig"] });
      qc.invalidateQueries({ queryKey: ["sprintStatus"] });
      qc.invalidateQueries({ queryKey: ["lifeOs"] });
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["weeklyReview"] });
    },
  });
}

/** 스프린트 설정 삭제(미설정 상태로 복원). */
export function useClearSprintConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.clearSprintConfig()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sprintConfig"] });
      qc.invalidateQueries({ queryKey: ["sprintStatus"] });
      qc.invalidateQueries({ queryKey: ["lifeOs"] });
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["weeklyReview"] });
    },
  });
}
