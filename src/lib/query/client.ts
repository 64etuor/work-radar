import { QueryCache, QueryClient, useQueryClient } from "@tanstack/react-query";

import { type AppError, type Weekday, type WorkSignal } from "@/bindings";
import { useToastStore } from "@/lib/toast";

/**
 * IPC 정본 에러 래퍼. unwrap이 backend `AppError`를 throw할 때 쓰는 Error 서브클래스.
 * `message`는 표면용으로 super에 넘기고, 분류/traceId/action 일체는 `app`에 보존한다
 * (스펙 §6 — string 대신 AppError surfacing). 토스트/ErrorBoundary가 `instanceof`로 구분.
 */
export class IpcError extends Error {
  readonly app: AppError;
  constructor(app: AppError) {
    super(app.message);
    this.name = "IpcError";
    this.app = app;
  }
}

/** 전역 쿼리 클라이언트. 읽기는 로컬 SQLite라 빠르므로 짧은 staleTime + bounded retry. */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      // 핸들되지 않은 query 에러를 전역 토스트로 — getState()로 React 외부에서 접근.
      // IpcError면 backend AppError 그대로(traceId/retryable/action 보존, 재로그 금지).
      // transient(retryable)면 그 query를 다시 fetch하는 onRetry를 주입 → 토스트 "재시도" 버튼.
      const store = useToastStore.getState();
      if (err instanceof IpcError) {
        store.pushError(
          "query",
          err.app,
          err.app.retryable ? { onRetry: () => void query.fetch() } : undefined,
        );
      } else {
        store.pushError("query", err instanceof Error ? err.message : String(err));
      }
    },
  }),
  // mutation은 전역 onError를 두지 않는다: RQ v5에서 per-call mutate(vars,{onError})는
  // MutationCache에 안 보여(private #mutateOptions) 전역 폴백을 두면 컴포넌트 onError와 중복 토스트가 된다.
  // 컴포넌트가 컨텍스트별 메시지로 직접 처리(pushError) → trace id+로그+영속 토스트 일원화.
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // gcTime은 disk-persist maxAge(24h)와 맞춘다 — 복원된 ambient 캐시가 GC로 먼저 사라지지
      // 않도록(persist는 표시 가속 전용, 결정 큐는 persist.ts allowlist에서 제외 — INVARIANT).
      gcTime: 1000 * 60 * 60 * 24,
      retry: 1, // bounded retry only — 무한 retry 금지 (INVARIANT)
      refetchOnWindowFocus: false,
    },
  },
});

// ── IPC 결과 언랩 (terminal failure를 그대로 노출 — INVARIANT, 삼키지 않음) ──────
// IPC 에러는 정본 AppError(분류/traceId/action 보유)를 IpcError로 throw — 분류/traceId가
// 호출부·전역 핸들러까지 보존된다(스펙 §6).
type IpcResult<T> = { status: "ok"; data: T } | { status: "error"; error: AppError };

export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new IpcError(res.error);
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

export function useInvalidate() {
  const qc = useQueryClient();
  // todayOverview는 signals/today의 파생 집계라, 그 둘이 바뀌면 함께 무효화한다
  // (모든 mutation 콜사이트가 signals()/today()를 부르므로 누락 없이 콕핏이 최신화됨).
  const overview = () => qc.invalidateQueries({ queryKey: ["todayOverview"] });
  return {
    signals: () => {
      void overview();
      return qc.invalidateQueries({ queryKey: ["signals"] });
    },
    today: () => {
      void overview();
      return qc.invalidateQueries({ queryKey: ["today"] });
    },
    routines: () => {
      void qc.invalidateQueries({ queryKey: ["routine-tracking"] });
      return qc.invalidateQueries({ queryKey: ["routines"] });
    },
  };
}
