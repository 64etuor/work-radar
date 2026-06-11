import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { commands, type HermesPanelState } from "@/bindings";
import { unwrap } from "@/lib/query/client";

// 패널 상태 쿼리 키
const QUERY_KEY = ["hermes-panel-state"] as const;

// 로딩 중 기본값 — x/y/w/h=null은 프런트에서 defaultBounds로 초기 배치함을 의미.
export const DEFAULT_PANEL_STATE: HermesPanelState = {
  x: null,
  y: null,
  w: null,
  h: null,
  open: false,
};

const DEBOUNCE_MS = 300;

/** bounds 필드를 부분 업데이트한 새 HermesPanelState를 반환한다. 순수 함수. */
export function mergeBounds(
  state: HermesPanelState,
  bounds: Partial<Pick<HermesPanelState, "x" | "y" | "w" | "h">>,
): HermesPanelState {
  return {
    ...state,
    x: bounds.x ?? state.x,
    y: bounds.y ?? state.y,
    w: bounds.w ?? state.w,
    h: bounds.h ?? state.h,
  };
}

/**
 * Hermes 패널 위치/크기/열림 상태 훅.
 * - mount 시 backend에서 읽고, staleTime Infinity로 캐싱(세션 중 재fetch 없음).
 * - setOpen: 즉시 optimistic 업데이트 + backend write.
 * - setBounds: 300ms debounce로 optimistic 업데이트 → backend write.
 */
export function useHermesPanelState() {
  const qc = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // debounce 타이머를 unmount 시 정리
  useEffect(() => {
    return () => {
      const timer = debounceRef.current;
      if (timer !== null) {
        debounceRef.current = null;
        clearTimeout(timer);
      }
    };
  }, []);

  const { data, isLoading } = useQuery<HermesPanelState>({
    queryKey: QUERY_KEY,
    queryFn: () => unwrap(commands.hermesPanelStateGet()),
    staleTime: Infinity,
    retry: 1,
  });

  const state = data ?? DEFAULT_PANEL_STATE;

  const setOpen = (open: boolean) => {
    const next: HermesPanelState = { ...state, open };
    // optimistic 업데이트
    qc.setQueryData<HermesPanelState>(QUERY_KEY, next);
    // 즉시 backend write (fire-and-forget; 에러는 전역 IpcError 핸들러로)
    void unwrap(commands.hermesPanelStateSet(next));
  };

  const setBounds = (b: Partial<Pick<HermesPanelState, "x" | "y" | "w" | "h">>) => {
    const next = mergeBounds(state, b);
    // 즉시 optimistic 업데이트 (매 호출마다)
    qc.setQueryData<HermesPanelState>(QUERY_KEY, next);
    // debounce 후 backend write
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void unwrap(commands.hermesPanelStateSet(next));
    }, DEBOUNCE_MS);
  };

  return { state, setOpen, setBounds, isLoading };
}
