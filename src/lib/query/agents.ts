import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  type BatchEnrichProposal,
  type CiTriageProposal,
  commands,
  type OkrImportDraft,
  type PrSelfCheckProposal,
  type TriageOutcome,
  type TriggerCiTriageInput,
  type TriggerCodexInput,
  type TriggerEchoInput,
  type TriggerEnrichAllInput,
  type TriggerOkrImportInput,
  type TriggerPrSelfCheckInput,
} from "@/bindings";

import { unwrap } from "./client";

/** Jobs 뷰 폴링 주기 — 실행 중 잡 상태 전이를 따라잡되 과한 부하 없이. */
const JOBS_POLL_MS = 2_000;

/** 잡 상태 중 terminal — 도달하면 폴링 중단(INVARIANT #5: 무한 폴링 금지). */
const AGENT_TERMINAL_STATUSES = new Set(["awaiting_approval", "succeeded", "failed", "cancelled"]);

/**
 * 미분류 배치 enrich 잡(`enrich_batch`)이 현재 활성인지 — `useAgentRuns()`에서 직접 파생.
 * 별도 store id 없이 SSOT(agent_runs)만으로 판정 (lift-to-Provider, INVARIANT #1 표시 전용).
 * 결과 표시는 사용자가 에이전트 바 박스를 클릭해 `AgentRunModal`로 봐야 한다 — 자동 오픈 없음.
 */
export function useEnrichAllRunning(): boolean {
  const runs = useAgentRuns();
  return (runs.data ?? []).some(
    (r) => r.kind === "enrich_batch" && !AGENT_TERMINAL_STATUSES.has(r.status),
  );
}

/**
 * claude/codex 사용량 한도(5h/주간 게이지) — Control Room 헤더.
 * 외부 호출 빈도는 백엔드 TTL 캐시가 묶으므로 폴링은 고정 30s(snapshot 4s 패턴과 동일한 always-on).
 */
export function useAgentUsageStatus() {
  return useQuery({
    queryKey: ["agentUsageStatus"],
    queryFn: () => unwrap(commands.agentUsageStatus()),
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false, // 실패는 unavailable 표시로 — 다음 폴링이 자연 재시도.
  });
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

/**
 * 결과 모달 close 시 "확인 완료" 마킹(SQLite SSOT — `agent_runs.acked_at`).
 * 활성 잡에 호출돼도 무해 — 표시 로직이 활성 상태 우선이라 종료될 때 자동으로 바에서 사라진다.
 */
export function useAckAgentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => unwrap(commands.ackAgentRun(runId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/**
 * 여러 잡 로그 tail. JobsView가 log-open state와 query ownership을 함께 소유한다.
 * `activeRunIds`에 없는(=terminal) runId는 폴링 중단 — `useAgentRuns`와 동일한 가드
 * 패턴(INVARIANT #5: 무한 폴링 금지). 생략 시 이전 동작(전부 폴링)을 보존한다.
 */
export function useAgentLogs(runIds: string[], activeRunIds?: ReadonlySet<string>) {
  const qc = useQueryClient();
  const results = useQueries({
    queries: runIds.map((runId) => ({
      queryKey: ["agentLog", runId],
      queryFn: () => unwrap(commands.readAgentLog(runId)),
      refetchInterval: (activeRunIds?.has(runId) ?? true) ? JOBS_POLL_MS : (false as const),
    })),
  });

  // terminal 전환 시 마지막 tail 1회 보장 — runs 폴과 로그 폴이 같은 주기(2s)라 종료 감지가
  // 로그 폴보다 먼저 오면 대기 중 타이머가 취소돼 최종 출력 구간을 놓친다. active→inactive로
  // 떨어진 runId는 로그를 한 번 강제 재조회한다(1회성 — 폴링 재개 아님, INVARIANT #5 유지).
  const prevActiveRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!activeRunIds) return; // 레거시(생략) 경로 — 전부 폴링 중이라 최종 tail 레이스 없음.
    const prev = prevActiveRef.current;
    if (prev) {
      for (const runId of prev) {
        if (!activeRunIds.has(runId)) {
          void qc.invalidateQueries({ queryKey: ["agentLog", runId] });
        }
      }
    }
    prevActiveRef.current = new Set(activeRunIds);
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

// ── OKR 받아쓰기 (자유 텍스트 → OKR 초안, Acceptance 게이트) ──────────────────────────

/** OKR 받아쓰기 잡 트리거. 초안은 awaiting_approval로 멈추고 사람이 검토·적용해야 생성된다. */
export function useTriggerOkrImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerOkrImportInput) => unwrap(commands.triggerOkrImport(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** awaiting_approval OKR 받아쓰기 잡의 초안(항목 검증 + skipped 집계). 펼친 잡에 대해서만 enabled. */
export function useOkrImportProposal(runId: string | null, ready: boolean) {
  return useQuery({
    queryKey: ["okrImportProposal", runId],
    queryFn: () => unwrap(commands.okrImportProposal(runId as string)),
    enabled: !!runId && ready,
    retry: false, // 파싱 실패(raw/형식 밖)는 즉시 노출.
  });
}

/** OKR 받아쓰기 accept(INVARIANT #1/#2 게이트) — 사람 적용 시 mission/horizon/objective/KR 생성. */
export function useAcceptOkrImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, accepted }: { runId: string; accepted: OkrImportDraft }) =>
      unwrap(commands.acceptOkrImport(runId, accepted)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agentRuns"] });
      void qc.invalidateQueries({ queryKey: ["okr"] }); // mission/objectives/checkIns 갱신.
      void qc.invalidateQueries({ queryKey: ["lifeOs"] }); // horizon 셸프 갱신.
    },
  });
}

/** 진행 중(비-terminal) OKR 받아쓰기 잡 — MissionView 버튼 상태/중복 트리거 방지용. */
export function useOkrImportActiveRun() {
  const runs = useAgentRuns();
  return (
    (runs.data ?? []).find(
      (r) => r.kind === "okr_import" && !AGENT_TERMINAL_STATUSES.has(r.status),
    ) ?? null
  );
}

/** 검토 대기(awaiting_approval) 상태의 최신 OKR 받아쓰기 잡. */
export function useOkrImportAwaitingRun() {
  const runs = useAgentRuns();
  return (
    (runs.data ?? []).find((r) => r.kind === "okr_import" && r.status === "awaiting_approval") ??
    null
  );
}
