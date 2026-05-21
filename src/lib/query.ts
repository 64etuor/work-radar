import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  commands,
  type CreateProjectInput,
  type CreateRepoInput,
  type CreateRoutineInput,
  type CreateSignalInput,
  type DiffMode,
  type MismatchItem,
  type PrRadarItem,
  type PromotionTarget,
  type PrSelfCheckProposal,
  type Quadrant,
  type SignalStatus,
  type TokenKind,
  type TriggerCodexInput,
  type TriggerEchoInput,
  type TriggerPrSelfCheckInput,
  type Weekday,
  type WorkSignal,
} from "@/bindings";

/** 전역 쿼리 클라이언트. 읽기는 로컬 SQLite라 빠르므로 짧은 staleTime + bounded retry. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1, // bounded retry only — 무한 retry 금지 (INVARIANT)
      refetchOnWindowFocus: false,
    },
  },
});

// ── IPC 결과 언랩 (terminal failure를 그대로 노출 — INVARIANT, 삼키지 않음) ──────
type IpcResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

// ── 날짜/요일 헬퍼 (로컬 날짜 기준 — SQLite UTC와 분리, architecture.md) ─────────

/** Date → 로컬 YYYY-MM-DD. */
function fmtLocalDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 로컬 오늘 날짜 (YYYY-MM-DD). Today 스코프·승격·완료의 기준. */
export function localToday(): string {
  return fmtLocalDate(new Date());
}

/** 내일 로컬 날짜 (YYYY-MM-DD). snooze 기본 복귀일. */
export function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return fmtLocalDate(d);
}

/** 로컬 오늘 요일 (루틴 매칭용). JS getDay: 0=일 → Weekday. */
export function localWeekday(): Weekday {
  const map: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[new Date().getDay()];
}

/** 경과일 카운터 +N = (오늘 − forDate) + 1. 옮긴 날 +1, 매일 +1 증가. */
export function ageFromForDate(forDate: string): number {
  const [y, m, d] = forDate.split("-").map(Number);
  const from = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - from.getTime()) / 86_400_000);
  return diffDays + 1;
}

/** Today 항목이 (해당 날짜에) 완료 표시됐는지. */
export function isTodayDone(sig: WorkSignal, today: string): boolean {
  return sig.todayDoneAt === today;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** 프로젝트 목록 (Phase 0). */
export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => unwrap(commands.listProjects()),
  });
}

/** 매트릭스 + 미분류 카드 (Today로 승격되지 않은 active 신호). */
export function useSignals() {
  return useQuery({
    queryKey: ["signals"],
    queryFn: () => unwrap(commands.listSignals()),
  });
}

/** 오늘의 Today 레일 항목. */
export function useToday(today: string) {
  return useQuery({
    queryKey: ["today", today],
    queryFn: () => unwrap(commands.listToday(today)),
  });
}

/** 오늘 해당하는 루틴 + 날짜별 완료 상태. */
export function useTodayRoutines(date: string, weekday: Weekday) {
  return useQuery({
    queryKey: ["routines", date],
    queryFn: () => unwrap(commands.listTodayRoutines(date, weekday)),
  });
}

// ── Mutations (관련 쿼리 invalidate) ───────────────────────────────────────────

function useInvalidate() {
  const qc = useQueryClient();
  return {
    signals: () => qc.invalidateQueries({ queryKey: ["signals"] }),
    today: () => qc.invalidateQueries({ queryKey: ["today"] }),
    routines: () => qc.invalidateQueries({ queryKey: ["routines"] }),
  };
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

/** Today 승격 (로컬, Acceptance 불요). 매트릭스에서 빠지고 Today에만 표시. */
export function usePromoteToday() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) =>
      unwrap(commands.promoteToday(id, date)),
    onSuccess: () => {
      inv.signals();
      inv.today();
    },
  });
}

/** Today 승격 취소 → 원 사분면 복귀. */
export function useUnpromoteToday() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.unpromoteToday(id)),
    onSuccess: () => {
      inv.signals();
      inv.today();
    },
  });
}

/** Today 항목 완료 토글 (날짜별, 미완료는 rollover). */
export function useToggleTodayDone() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, date, done }: { id: string; date: string; done: boolean }) =>
      unwrap(commands.toggleTodayDone(id, date, done)),
    onSuccess: () => inv.today(),
  });
}

/** Today 레일 재정렬. */
export function useReorderToday() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (orderedIds: string[]) => unwrap(commands.reorderToday(orderedIds)),
    onSuccess: () => inv.today(),
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

/** 외부 URL(생성된 Notion 페이지)을 브라우저/Notion 앱에서 연다("Notion에서 열기"). */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

/**
 * 카드 → Notion 백로그/안건 즉시 승격(write 레일, Phase 3). 사람 클릭이 곧 결정/accept(INVARIANT #2).
 * 결과 status로 created(성공·pageUrl) / draft(오프라인 큐잉) / failed(영구 실패)를 구분한다.
 * created 시 signal status=linked가 되므로 signals를 invalidate한다.
 */
export function usePromoteToNotion() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ signalId, target }: { signalId: string; target: PromotionTarget }) =>
      unwrap(commands.promoteToNotion(signalId, target)),
    onSuccess: (outcome) => {
      if (outcome.status === "created") inv.signals();
    },
  });
}

/** 오프라인 큐(draft) flush — 복구 시 호출. created>0면 signals 갱신. */
export function useFlushPromotions() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: () => unwrap(commands.flushPromotions()),
    onSuccess: (summary) => {
      if (summary.created > 0) inv.signals();
    },
  });
}

/** 루틴 추가. */
export function useCreateRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateRoutineInput) => unwrap(commands.createRoutine(input)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 완료 토글 (날짜별, 다음날 리셋). */
export function useToggleRoutineCheck() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({
      routineId,
      date,
      done,
    }: {
      routineId: string;
      date: string;
      done: boolean;
    }) => unwrap(commands.toggleRoutineCheck(routineId, date, done)),
    onSuccess: () => inv.routines(),
  });
}

// ── Phase 2: Projects / Repos / 토큰 ────────────────────────────────────────────

/** project별 레포 목록. */
export function useRepos(projectId: string) {
  return useQuery({
    queryKey: ["repos", projectId],
    queryFn: () => unwrap(commands.listRepos(projectId)),
    enabled: !!projectId,
  });
}

/** 토큰 존재 여부만(본문 미노출 — INVARIANT). 마스킹 표시용. */
export function useProjectTokenStatus(projectId: string) {
  return useQuery({
    queryKey: ["tokenStatus", projectId],
    queryFn: () => unwrap(commands.projectTokenStatus(projectId)),
    enabled: !!projectId,
  });
}

/** 프로젝트 생성 (개인/업무). */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => unwrap(commands.createProject(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/** 레포 추가. */
export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepoInput) => unwrap(commands.createRepo(input)),
    onSuccess: (repo) =>
      qc.invalidateQueries({ queryKey: ["repos", repo.projectId] }),
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

/** 미태깅 신호를 kind→매칭 프로젝트로 reconcile. 태깅된 건수 반환. */
export function useReconcileSignalProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(commands.reconcileSignalProjects()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
}

// ── Phase 4: PR Radar (read 레일) ───────────────────────────────────────────────

/** PR Radar 주기 폴링 간격. INVARIANT #5: bounded(무한 tight loop 아님 — 고정 cadence). */
export const PR_RADAR_POLL_MS = 3 * 60_000;

/**
 * PR Radar 한 cycle 실행(언랩만). escalate/dedup/auto-resolve는 Rust가 수행한다.
 * 매트릭스(signals) invalidate는 호출부(useQueries queryFn)가 한다 — 프로젝트별 폴링이라 코어는 순수 fetch.
 * 토큰은 인자에 없다(keychain에서만 Rust가 읽음 — INVARIANT: 렌더러 미노출).
 */
export function fetchPrRadar(projectId: string): Promise<PrRadarItem[]> {
  return unwrap(commands.refreshPrRadar(projectId));
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

// ── Phase 6: Status mismatch (Notion↔PR drift) ──────────────────────────────────

/** mismatch 주기 폴링 간격. PR + Notion 둘 다 fetch라 PR Radar보다 느슨하게(INVARIANT #5: bounded). */
export const MISMATCH_POLL_MS = 5 * 60_000;

/**
 * mismatch 한 cycle 실행(언랩만). drift 감지/dedup/auto-resolve는 Rust가 수행한다.
 * 매트릭스(signals) invalidate는 호출부(useQueries queryFn)가 한다. 토큰은 keychain에서만(렌더러 미노출).
 */
export function fetchMismatch(projectId: string): Promise<MismatchItem[]> {
  return unwrap(commands.refreshMismatch(projectId));
}

/** done으로 볼 Notion 상태 이름 목록 설정(프로젝트별). 성공 시 프로젝트 갱신. */
export function useSetNotionDoneStatuses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, statuses }: { projectId: string; statuses: string[] }) =>
      unwrap(commands.setNotionDoneStatuses(projectId, statuses)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

// ── Phase 5: Worktree & Branch Diff (read-only) ─────────────────────────────────
//
// ambient — 매 호출 git에서 fresh 도출(영속 없음). 로컬·on-demand라 폴링 없음(뷰 진입+수동 새로고침).
// 토큰 무관(로컬 git). 대용량 비차단 = 파일목록 먼저 + 파일별 diff 지연 로드(enabled).

/** repo별 worktree 목록 (projectId=null이면 멀티 repo 전체). */
export function useWorktrees(projectId: string | null) {
  return useQuery({
    queryKey: ["worktrees", projectId],
    queryFn: () => unwrap(commands.listWorktrees(projectId)),
    staleTime: 10_000,
  });
}

/** worktree의 로컬+원격추적 브랜치 (branch↔branch picker용). 경로 있을 때만. */
export function useWorktreeBranches(worktreePath: string | null) {
  return useQuery({
    queryKey: ["worktreeBranches", worktreePath],
    queryFn: () => unwrap(commands.listWorktreeBranches(worktreePath as string)),
    enabled: !!worktreePath,
  });
}

/** 비교 모드의 변경 파일 목록(통계). ready=false면 비활성(ref 미선택 모드 대기). */
export function useWorktreeDiffFiles(args: {
  worktreePath: string | null;
  mode: DiffMode;
  baseRef: string | null;
  headRef: string | null;
  ready: boolean;
}) {
  const { worktreePath, mode, baseRef, headRef, ready } = args;
  return useQuery({
    queryKey: ["worktreeDiffFiles", worktreePath, mode, baseRef, headRef],
    queryFn: () =>
      unwrap(
        commands.worktreeDiffFiles(worktreePath as string, mode, baseRef, headRef),
      ),
    enabled: !!worktreePath && ready,
  });
}

/** 선택한 한 파일의 unified diff 텍스트 (지연 로드 — 파일 선택 시에만). */
export function useWorktreeFileDiff(args: {
  worktreePath: string | null;
  mode: DiffMode;
  baseRef: string | null;
  headRef: string | null;
  path: string | null;
  ready: boolean;
}) {
  const { worktreePath, mode, baseRef, headRef, path, ready } = args;
  return useQuery({
    queryKey: ["worktreeFileDiff", worktreePath, mode, baseRef, headRef, path],
    queryFn: () =>
      unwrap(
        commands.worktreeFileDiff(
          worktreePath as string,
          mode,
          baseRef,
          headRef,
          path as string,
        ),
      ),
    enabled: !!worktreePath && !!path && ready,
  });
}

// ── Agent 잡 큐 (Phase 7) ──────────────────────────────────────────────────────
//
// 잡은 agent_runs에 영속(INVARIANT #7). Jobs 뷰가 주기 폴링으로 상태 전이를 따라간다.
// codex 미설치/미인증이면 자동화 트리거 UI 비활성(graceful degrade).

/** Jobs 뷰 폴링 주기 — 실행 중 잡 상태 전이를 따라잡되 과한 부하 없이. */
export const JOBS_POLL_MS = 2_000;

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
      const active = runs.some(
        (r) => r.status === "running" || r.status === "proposed",
      );
      return active ? JOBS_POLL_MS : false;
    },
  });
}

/** echo 테스트 잡 트리거(codex 없이 bound/kill/로그 검증). */
export function useTriggerEchoJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerEchoInput) =>
      unwrap(commands.triggerEchoJob(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentRuns"] }),
  });
}

/** codex 잡 트리거(read_only 샌드박스). 미설치/미인증이면 백엔드가 Err로 막는다. */
export function useTriggerCodexJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerCodexInput) =>
      unwrap(commands.triggerCodexJob(input)),
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

/** 잡 로그 tail(최대 16KB). 펼친 잡에 대해서만 enabled. */
export function useAgentLog(runId: string | null, ready: boolean) {
  return useQuery({
    queryKey: ["agentLog", runId],
    queryFn: () => unwrap(commands.readAgentLog(runId as string)),
    enabled: !!runId && ready,
    refetchInterval: ready ? JOBS_POLL_MS : false,
  });
}

// ── Phase 8: PR self-check 자동 초안 (제안 레일 + Acceptance 게이트) ──────────────────
//
// 트리거(PR Radar 카드)→codex 잡(read_only·worktree)→Proposal(awaiting_approval)→사람 accept(로컬 반영).
// accept 전 GitHub 무변경(INVARIANT #2). 제출은 사람 수동.

/** PR self-check 초안 잡 트리거(PR Radar 카드). 성공 시 잡 목록 갱신. */
export function useTriggerPrSelfcheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TriggerPrSelfCheckInput) =>
      unwrap(commands.triggerPrSelfcheck(input)),
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
