// 외부 뉴스 페처(HN/GeekNews/Lobsters 등) 표시 전용 훅 (PR C + D-Tune).
//
// INVARIANT #1: 뉴스 데이터는 화면 표시 전용 — 큐/매트릭스/결정에 어떤 입력으로도 쓰지 않는다.
// 백엔드 fetcher는 사용자 설정 주기(news/fetcher.rs). 프런트는 매 5분 refetch로
// 사용자가 앱에 머무는 동안 신선도 보장(빠른 토글에도 즉시 invalidate).

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import type { FilterMode, NewsItem, NewsOptions } from "@/bindings";
import { commands } from "@/bindings";
import { mergeNewsTickerItems } from "@/lib/newsTicker";

import { unwrap } from "./client";

/** 프런트 폴 주기 — 백엔드가 설정 주기에 한 번 갱신하므로 5분이면 평균 stale 이내 보장. */
const NEWS_POLL_MS = 5 * 60 * 1000;

/** 활성 소스 합본의 최근 N개(opts에서 결정). 비활성 소스는 서버에서 이미 제외. */
export function useNewsList() {
  const qc = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void listen("news_items_updated", () => {
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      // Tauri 이벤트 브릿지가 없는 Vite preview/테스트형 실행에서는 5분 폴링 폴백만 유지.
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [qc]);

  return useQuery({
    queryKey: ["newsList"],
    queryFn: () => unwrap(commands.newsListRecent()),
    refetchInterval: NEWS_POLL_MS,
    // 페치 실패는 빈 티커로 자연 graceful — 토스트 띄울 필요 없음.
    retry: false,
    // 토글/refetch 사이에 isLoading flicker(빈 티커→"불러오는 중…"→다시 채움) 방지.
    placeholderData: keepPreviousData,
    structuralSharing: (previous, incoming) =>
      mergeNewsTickerItems((previous as NewsItem[] | undefined) ?? [], incoming as NewsItem[]),
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

/** 현재 키워드 필터 목록. */
export function useNewsFilters() {
  return useQuery({
    queryKey: ["newsFilters"],
    queryFn: () => unwrap(commands.newsListFilters()),
    retry: false,
  });
}

/** 키워드 필터 추가. 성공 시 filters + list 둘 다 invalidate. */
export function useAddNewsFilter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keyword, mode }: { keyword: string; mode: FilterMode }) =>
      unwrap(commands.newsAddFilter(keyword, mode)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsFilters"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}

/** 키워드 필터 제거. 성공 시 filters + list 둘 다 invalidate. */
export function useRemoveNewsFilter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => unwrap(commands.newsRemoveFilter(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsFilters"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}

/** 글로벌 뉴스 옵션 (총 한도/소스당 한도/정렬/갱신 주기). */
export function useNewsOptions() {
  return useQuery({
    queryKey: ["newsOptions"],
    queryFn: () => unwrap(commands.newsGetOptions()),
    retry: false,
  });
}

/** 옵션 저장 + fetcher 즉시 깨움(Notify). 성공 시 newsOptions + newsList invalidate. */
export function useSetNewsOptions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: NewsOptions) => unwrap(commands.newsSetOptions(opts)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsOptions"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}
