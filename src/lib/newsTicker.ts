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

/** 🔥 badge용 핫 키워드 셋 — 백엔드 `store::hotness`의 HOT_KEYWORDS와 일치. */
const HOT_KEYWORDS = [
  "ai",
  "gpt",
  "llm",
  "rust",
  "security",
  "breach",
  "release",
  "launch",
  "open source",
  "breakthrough",
];

/**
 * 표시 전용 composite "hotness" 점수. 백엔드 `store::hotness`(recency 지수감쇠 + ln engagement +
 * 키워드 부스트)를 클라이언트에서 동일하게 재현한다. 새 백엔드 필드를 추가하지 않는다.
 * - recency: 발행 후 경과 시간 반감기 12h 지수 감쇠(항상 양수).
 * - engagement: commentCount 있으면 ln(1+count), 없으면 0.
 * - keyword: 제목에 핫 키워드 있으면 +0.5.
 */
function newsHotness(item: NewsItem): number {
  const postedMs = Date.parse(item.postedAt);
  const hoursSince = Number.isNaN(postedMs)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, (Date.now() - postedMs) / 3_600_000);
  const recency = Math.pow(0.5, hoursSince / 12);
  const engagement = item.commentCount != null ? Math.log(1 + item.commentCount) : 0;
  const keywordBoost = HOT_KEYWORDS.some((k) => item.title.toLowerCase().includes(k)) ? 0.5 : 0;
  return recency + engagement + keywordBoost;
}

/**
 * 표시 전용 hot/trending 판정. 백엔드와 동일한 composite hotness로, 현재 티커 상위 분위(top-quartile)에
 * 드는 항목을 🔥로 표시한다. 더 이상 commentCount 단독에 의존하지 않는다(대부분의 소스는 댓글 수 없음).
 */
export function isHotTrendingNews(item: NewsItem, allItems: NewsItem[]): boolean {
  if (allItems.length === 0) return false;
  const scores = allItems.map(newsHotness).sort((a, b) => b - a);
  const topQuartileIndex = Math.max(0, Math.floor((scores.length - 1) * 0.25));
  const threshold = scores[topQuartileIndex] ?? 0;
  return newsHotness(item) >= threshold;
}
