import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type PrRadarItem, type PrRadarSettings } from "@/bindings";

import { unwrap } from "./client";

/** PR Radar 주기 폴링 간격. INVARIANT #5: bounded(무한 tight loop 아님 — 고정 cadence). */
export const PR_RADAR_POLL_MS = 10 * 60_000;

/**
 * PR Radar 한 cycle 실행(언랩만). escalate/dedup/auto-resolve는 Rust가 수행한다.
 * 매트릭스(signals) invalidate는 호출부(useQueries queryFn)가 한다 — 프로젝트별 폴링이라 코어는 순수 fetch.
 * 토큰은 인자에 없다(keychain에서만 Rust가 읽음 — INVARIANT: 렌더러 미노출).
 */
export function fetchPrRadar(projectId: string): Promise<PrRadarItem[]> {
  return unwrap(commands.refreshPrRadar(projectId));
}

export function usePrRadarSettings() {
  return useQuery<PrRadarSettings>({
    queryKey: ["prRadarSettings"],
    queryFn: () => unwrap(commands.getPrRadarSettings()),
  });
}

export function fetchPrRadarSettings(): Promise<PrRadarSettings> {
  return unwrap(commands.getPrRadarSettings());
}

export function useSetPrRadarSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: PrRadarSettings) => unwrap(commands.setPrRadarSettings(settings)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["prRadarSettings"] });
      void qc.invalidateQueries({ queryKey: ["prRadar"] });
    },
  });
}

/** 수동 self-check 토글(로컬 상태). 성공 시 radar 갱신. */
export function useSetPrSelfCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      repoFullName,
      prNumber,
      checked,
    }: {
      repoFullName: string;
      prNumber: number;
      checked: boolean;
    }) => unwrap(commands.setPrSelfCheck(repoFullName, prNumber, checked)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prRadar"] }),
  });
}

// ── Phase 5: Worktree & Branch Diff (read-only) ─────────────────────────────────
//
// ambient — 매 호출 git에서 fresh 도출(영속 없음). 로컬·on-demand라 폴링 없음(뷰 진입+수동 새로고침).
// 토큰 무관(로컬 git). 대용량 비차단 = 파일목록 먼저 + 파일별 diff 지연 로드(enabled).
