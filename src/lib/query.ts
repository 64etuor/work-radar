import { QueryClient, useQuery } from "@tanstack/react-query";

import { commands } from "@/bindings";

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

/** 프로젝트 목록 훅. specta가 생성한 타입드 IPC 바인딩을 통해 호출. */
export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const res = await commands.listProjects();
      if (res.status === "error") {
        // terminal failure를 그대로 노출 (삼키지 않음 — INVARIANT)
        throw new Error(res.error);
      }
      return res.data;
    },
  });
}
