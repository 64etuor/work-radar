// 외부 뉴스 페처(HN/GeekNews/Lobsters) 표시 전용 훅 (PR C).
//
// INVARIANT #1: 뉴스 데이터는 화면 표시 전용 — 큐/매트릭스/결정에 어떤 입력으로도 쓰지 않는다.
// 백엔드 fetcher는 15분 주기(news/fetcher.rs). 프런트는 매 5분 refetch로
// 사용자가 앱에 머무는 동안 신선도 보장(빠른 토글에도 즉시 invalidate).

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { unwrap } from "./client";
import { commands } from "@/bindings";

/** 티커 표시 한도. 30개면 30s linear 마퀴에서 ~2.5건/초로 자연스럽게 흐름. */
const TICKER_LIMIT = 30;

/** 프런트 폴 주기 — 백엔드가 15분에 한 번 갱신하므로 5분이면 평균 7.5분 stale 이내 보장. */
const NEWS_POLL_MS = 5 * 60 * 1000;

/** 활성 소스 합본의 최근 N개(posted_at DESC). 비활성 소스는 서버에서 이미 제외. */
export function useNewsList() {
  return useQuery({
    queryKey: ["newsList", TICKER_LIMIT],
    queryFn: () => unwrap(commands.newsListRecent(TICKER_LIMIT)),
    refetchInterval: NEWS_POLL_MS,
    // 페치 실패는 빈 티커로 자연 graceful — 토스트 띄울 필요 없음.
    retry: false,
    // 토글/refetch 사이에 isLoading flicker(빈 티커→"불러오는 중…"→다시 채움) 방지.
    // 마퀴는 중단 없이 이전 콘텐츠를 그대로 보여주다 invalidate 응답이 도착하면 부드럽게 교체.
    placeholderData: keepPreviousData,
  });
}

/** 등록된 모든 소스 + 현재 enabled. 설정 다이얼로그의 토글 리스트. */
export function useNewsSources() {
  return useQuery({
    queryKey: ["newsSources"],
    queryFn: () => unwrap(commands.newsSourcesAvailable()),
    retry: false,
  });
}

/** 소스 on/off 즉시 반영. 성공 시 sources + list 둘 다 invalidate(티커 갱신). */
export function useSetNewsSourceEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, enabled }: { source: string; enabled: boolean }) =>
      unwrap(commands.newsSourcesSetEnabled(source, enabled)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsSources"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}
