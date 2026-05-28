import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BatchEnrichProposal,
  type CiTriageProposal,
  commands,
  type PrSelfCheckProposal,
  type TriageOutcome,
  type TriggerCiTriageInput,
  type TriggerCodexInput,
  type TriggerEchoInput,
  type TriggerEnrichAllInput,
  type TriggerPrSelfCheckInput,
} from "@/bindings";

import { unwrap } from "./client";

/** Jobs 뷰 폴링 주기 — 실행 중 잡 상태 전이를 따라잡되 과한 부하 없이. */
const JOBS_POLL_MS = 2_000;

/** enrich/triage 등 단건 잡 모달 폴링 주기 — 사람이 응답을 기다리는 맥락이라 더 짧게. */
const AGENT_RUN_POLL_MS = 1_000;

/** 잡 상태 중 terminal — 도달하면 폴링 중단(INVARIANT #5: 무한 폴링 금지). */
export const AGENT_TERMINAL_STATUSES = new Set([
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * 잡 단건 상태 폴링 훅. `runId`가 null이면 disabled.
 * terminal 상태에 도달하면 자동으로 폴링 중단(`refetchInterval` 반환값으로 제어).
 * 직접 `setInterval`로 commands.agentRunStatus를 호출하지 말 것 — IPC 호출은 query 레이어를 거친다.
 */
export function useAgentRunStatus(runId: string | null, opts?: { pollMs?: number }) {
  const pollMs = opts?.pollMs ?? AGENT_RUN_POLL_MS;
  return useQuery({
    queryKey: ["agentRunStatus", runId],
    queryFn: () => unwrap(commands.agentRunStatus(runId as string)),
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s) return pollMs;
      return AGENT_TERMINAL_STATUSES.has(s.status) ? false : pollMs;
    },
    retry: false, // 잡 없음/네트워크 실패는 즉시 노출(스피너 유지 방지).
  });
}

/**
 * `useAgentRunStatus` 위에 얹은 파생 boolean — runId가 비어있거나 terminal에 도달하면 false.
 * lift-to-Provider 원칙: `enrich_all` 진행 표시를 useEffect로 부모에 push하지 않고,
 * 같은 query를 구독하는 쪽 모두가 SSOT(agent run status)에서 직접 파생.
 */
export function useEnrichAllRunning(runId: string | null): boolean {
  const status = useAgentRunStatus(runId);
  if (!runId) return false;
  const s = status.data?.status;
  if (!s) return true; // 첫 로드 전엔 generating 가정(스피너 유지).
  return !AGENT_TERMINAL_STATUSES.has(s);
}

/** codex 설치/인증 상태 (자동화 UI 활성/비활성 판정). */
export function useCodexStatus() {
  return useQuery({
    queryKey: ["codexStatus"],
    queryFn: () => unwrap(commands.codexStatus()),
    staleTime: 60_000,
  });
}

/** 최근 잡 목록. 실행 중인 잡이 있으면 짧은 주기로 폴링해 상태/cost를 갱신한다. */
export function useAgentRuns() {
  return useQuery({
    queryKey: ["agentRuns"],
    queryFn: () => unwrap(commands.listAgentRuns()),
    refetchInterval: (q) => {
      const runs = q.state.data ?? [];
      const active = runs.some((r) => r.status === "running" || r.status === "proposed");
      return active ? JOBS_POLL_MS : false;
    },
  });
}

/** echo 테스트 잡 트리거(codex 없이 bound/kill/로그 검증). */
export function useTriggerEchoJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerEchoInput) => unwrap(commands.triggerEchoJob(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** codex 잡 트리거(read_only 샌드박스). 미설치/미인증이면 백엔드가 Err로 막는다. */
export function useTriggerCodexJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerCodexInput) => unwrap(commands.triggerCodexJob(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** 잡 kill switch. */
export function useKillAgentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => unwrap(commands.killAgentRun(runId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** 여러 잡 로그 tail. JobsView가 log-open state와 query ownership을 함께 소유한다. */
export function useAgentLogs(runIds: string[]) {
  const results = useQueries({
    queries: runIds.map((runId) => ({
      queryKey: ["agentLog", runId],
      queryFn: () => unwrap(commands.readAgentLog(runId)),
      refetchInterval: JOBS_POLL_MS,
    })),
  });

  return new Map(runIds.map((runId, index) => [runId, results[index]]));
}

// ── Phase 8: PR self-check 자동 초안 (제안 레일 + Acceptance 게이트) ──────────────────
//
// 트리거(PR Radar 카드)→codex 잡(read_only·worktree)→Proposal(awaiting_approval)→사람 accept(로컬 반영).
// accept 전 GitHub 무변경(INVARIANT #2). 제출은 사람 수동.

/** PR self-check 초안 잡 트리거(PR Radar 카드). 성공 시 잡 목록 갱신. */
export function useTriggerPrSelfcheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerPrSelfCheckInput) => unwrap(commands.triggerPrSelfcheck(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** awaiting_approval 잡의 Proposal(타입 파싱). 펼친 잡에 대해서만 enabled. */
export function usePrProposal(runId: string | null, ready: boolean) {
  return useQuery({
    queryKey: ["prProposal", runId],
    queryFn: () => unwrap(commands.prProposal(runId as string)),
    enabled: !!runId && ready,
    retry: false, // 파싱 실패(raw)는 즉시 노출(재시도 무의미).
  });
}

/** Proposal accept(INVARIANT #2 게이트) — 편집한 self-check/설명을 로컬에 반영하고 잡 succeeded. */
export function useAcceptProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, accepted }: { runId: string; accepted: PrSelfCheckProposal }) =>
      unwrap(commands.acceptProposal(runId, accepted)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agentRuns"] });
      void qc.invalidateQueries({ queryKey: ["prRadar"] }); // 로컬 self-check 표시 반영.
    },
  });
}

/** Proposal reject(폐기) — 잡 cancelled. */
export function useRejectProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => unwrap(commands.rejectProposal(runId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

// ── 미분류 전체 배치 enrich (단일 잡, 부분 실패 격리) ─────────────────────
//
// 제안 레일 + Acceptance 게이트. codex 잡(awaiting_approval)→Proposal→사람 accept(로컬 반영).
// accept 전·후 외부(Notion/GitHub) 무변경(INVARIANT #2). codex는 quadrant를 자동 확정하지 않는다
// (INVARIANT #1 — suggested 힌트만). 단건 enrich 경로(`trigger_enrich`/`enrich_proposal`/
// `accept_enrich`)는 제거됨 — 미분류 카드 분류는 배치 흐름만 유지.
//
// 미분류 영역 "전체 제안 실행" → 모든 미분류 카드를 한 codex 호출로 enrich(awaiting_approval) →
// 사람이 카드별 제안을 검토·수정 후 적용하면 미분류 카드의 quadrant+area를 확정(로컬). codex 자동 확정
// 0 — 적용 클릭이 드래그/키보드 분류와 동일한 사람 결정 레일(INVARIANT #1).

/** 미분류 전체 배치 enrich 잡 트리거(단일 잡). 대상 없으면 백엔드가 Err로 막는다. */
export function useTriggerEnrichAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerEnrichAllInput) => unwrap(commands.triggerEnrichAll(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** awaiting_approval 배치 enrich 잡의 Proposal(카드별 검증 + skipped 집계). 펼친 잡에 대해서만 enabled. */
export function useBatchEnrichProposal(runId: string | null, ready: boolean) {
  return useQuery({
    queryKey: ["batchEnrichProposal", runId],
    queryFn: () => unwrap(commands.batchEnrichProposal(runId as string)),
    enabled: !!runId && ready,
    retry: false, // 파싱 실패(raw/형식 밖)는 즉시 노출.
  });
}

/** 배치 enrich accept(INVARIANT #1/#2 게이트) — 사람 적용 시 미분류 카드의 quadrant+area 확정(codex 자동 확정 0). */
export function useAcceptEnrichAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, accepted }: { runId: string; accepted: BatchEnrichProposal }) =>
      unwrap(commands.acceptEnrichAll(runId, accepted)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agentRuns"] });
      void qc.invalidateQueries({ queryKey: ["signals"] }); // 확정 반영 → 카드 섹션 이동/태그 solid화.
    },
  });
}

/** CI triage 잡 트리거(PR Radar CI Blocked 카드). 캡 초과면 Q1 escalate(escalated=true, run_id 없음). */
export function useTriggerCiTriage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerCiTriageInput): Promise<TriageOutcome> =>
      unwrap(commands.triggerCiTriage(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agentRuns"] });
      void qc.invalidateQueries({ queryKey: ["signals"] }); // escalate 시 Q1 신호 반영.
    },
  });
}

/** awaiting_approval CI triage 잡의 Proposal(타입 파싱). */
export function useTriageProposal(runId: string | null, ready: boolean) {
  return useQuery({
    queryKey: ["triageProposal", runId],
    queryFn: () => unwrap(commands.triageProposal(runId as string)),
    enabled: !!runId && ready,
    retry: false,
  });
}

/** CI triage accept(INVARIANT #2 게이트) — 로컬 기록만(외부 무변경). */
export function useAcceptTriage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, accepted }: { runId: string; accepted: CiTriageProposal }) =>
      unwrap(commands.acceptTriage(runId, accepted)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}
