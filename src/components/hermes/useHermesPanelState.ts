import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { commands, type HermesPanelState } from "@/bindings";
import { unwrap } from "@/lib/query/client";

// 패널 상태 쿼리 키
const QUERY_KEY = ["hermes-panel-state"] as const;

// 로딩 중 기본값 (null 좌표는 초기 배치로 해석)
export const DEFAULT_PANEL_STATE: HermesPanelState = {
  x: 0,
  y: 0,
  w: 460,
  h: 600,
  open: false,
};

const DEBOUNCE_MS = 300;

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
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
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

  const setOpen = useCallback(
    (open: boolean) => {
      const next: HermesPanelState = { ...state, open };
      // optimistic 업데이트
      qc.setQueryData<HermesPanelState>(QUERY_KEY, next);
      // 즉시 backend write (fire-and-forget; 에러는 전역 IpcError 핸들러로)
      void unwrap(commands.hermesPanelStateSet(next));
    },
    [qc, state],
  );

  const setBounds = useCallback(
    (b: Partial<{ x: number; y: number; w: number; h: number }>) => {
      const next: HermesPanelState = {
        ...state,
        x: b.x ?? state.x,
        y: b.y ?? state.y,
        w: b.w ?? state.w,
        h: b.h ?? state.h,
      };
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
    },
    [qc, state],
  );

  return { state, setOpen, setBounds, isLoading };
}
