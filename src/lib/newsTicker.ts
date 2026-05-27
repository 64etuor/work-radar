import type { NewsItem } from "@/bindings";

export function newsTickerItemKey(item: Pick<NewsItem, "source" | "externalId">): string {
  return `${item.source}:${item.externalId}`;
}

/**
 * Polling returns the whole list in newest-first order. Reordering the marquee pool on every
 * refresh resets the visual flow, so keep the existing order and append unseen arrivals at the end.
 * A zero-overlap update means filters/sources changed enough that a full replacement is clearer.
 */
export function mergeNewsTickerItems(previous: NewsItem[], incoming: NewsItem[]): NewsItem[] {
  if (previous.length === 0 || incoming.length === 0) return incoming;

  const incomingByKey = new Map(incoming.map((item) => [newsTickerItemKey(item), item]));
  const previousKeys = new Set(previous.map(newsTickerItemKey));
  const hasOverlap = incoming.some((item) => previousKeys.has(newsTickerItemKey(item)));
  if (!hasOverlap) return incoming;

  const kept = previous
    .map((item) => incomingByKey.get(newsTickerItemKey(item)))
    .filter((item): item is NewsItem => item != null);
  const appended = incoming.filter((item) => !previousKeys.has(newsTickerItemKey(item)));

  return [...kept, ...appended];
}

/** 소스별 티커용 짧은 라벨. 긴 registry id를 그대로 노출하면 여러 소스 ON 시 배너가 깨진다. */
const SOURCE_LABEL: Record<string, string> = {
  hn: "HN",
  geeknews: "GEEK",
  lobsters: "LOB",
  reddit_programming: "REDDIT",
  devto: "DEV",
  naver_d2: "D2",
  kakao_tech: "KAKAO",
  woowahan: "WOOWA",
  toss_tech: "TOSS",
  line_tech: "LINE",
  yozm: "YOZM",
  arxiv_cs_ai: "ARXIV AI",
  arxiv_cs_lg: "ARXIV LG",
};

export function newsSourceLabel(id: string): string {
  return SOURCE_LABEL[id] ?? id.replace(/_/g, " ").toUpperCase();
}

/** CSS modifier는 registry id가 늘어나도 안전한 closed-ish class로 정규화한다. */
export function newsSourceClass(id: string): string {
  return `news-src-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * 표시 전용 hot/trending 판정.
 * 댓글 수가 있는 소스(HN/Lobsters 등)에서만, 절대 기준(10+)과 현재 티커 상위권을 동시에 만족하면 🔥.
 */
export function isHotTrendingNews(item: NewsItem, allItems: NewsItem[]): boolean {
  const count = item.commentCount;
  if (count == null || count < 10) return false;
  const counts = allItems
    .map((it) => it.commentCount)
    .filter((v): v is number => v != null)
    .sort((a, b) => b - a);
  if (counts.length === 0) return false;
  const topQuartileIndex = Math.max(0, Math.floor((counts.length - 1) * 0.25));
  const threshold = Math.max(10, counts[topQuartileIndex] ?? 10);
  return count >= threshold;
}
