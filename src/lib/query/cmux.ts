// cmux 워크스페이스 상태 훅 — best-effort, 표시 전용.
//
// INVARIANT #1: cmux 데이터는 화면 표시 전용(display-only)이다.
// 이 훅의 데이터는 어떤 결정(분류·승격·실행)에도 입력으로 쓰이지 않는다.
// cmux 미설치 또는 오류 → available:false → AgentStatusBar에서 칩을 렌더링하지 않음.

import { useQuery } from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands } from "@/bindings";

/** cmux 상태 폴링 주기 — 워크스페이스는 자주 바뀌지 않으므로 15s로 느리게. */
const CMUX_POLL_MS = 15_000;

/**
 * cmux 워크스페이스 목록 (best-effort, display-only).
 * 바이너리 부재·오류 → { available: false, workspaces: [] } (에러 없음).
 */
export function useCmuxStatus() {
  return useQuery({
    queryKey: ["cmuxStatus"],
    queryFn: () => unwrap(commands.cmuxStatus()),
    refetchInterval: CMUX_POLL_MS,
    refetchOnWindowFocus: true,
    // cmux 오류는 표시 전용이라 조용히 처리 — toast 없이.
    retry: false,
  });
}
