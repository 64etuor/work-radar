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
  type PromotionTarget,
  type Quadrant,
  type SignalStatus,
  type TokenKind,
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
