import {
  QueryCache,
  QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type Weekday,
  type WorkSignal,
} from "@/bindings";
import { useToastStore } from "@/lib/toast";

/** 전역 쿼리 클라이언트. 읽기는 로컬 SQLite라 빠르므로 짧은 staleTime + bounded retry. */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      // 핸들되지 않은 query 에러를 전역 토스트로 — getState()로 React 외부에서 접근.
      useToastStore
        .getState()
        .pushError("query", err instanceof Error ? err.message : String(err));
    },
  }),
  // mutation은 전역 onError를 두지 않는다: RQ v5에서 per-call mutate(vars,{onError})는
  // MutationCache에 안 보여(private #mutateOptions) 전역 폴백을 두면 컴포넌트 onError와 중복 토스트가 된다.
  // 컴포넌트가 컨텍스트별 메시지로 직접 처리(pushError) → trace id+로그+영속 토스트 일원화.
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

export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
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
