import { describe, expect, it } from "vitest";

import type { NewsItem } from "@/bindings";

import {
  isHotTrendingNews,
  mergeNewsTickerItems,
  newsSourceClass,
  newsSourceLabel,
  newsTickerItemKey,
} from "./newsTicker";

function item(
  source: string,
  id: string,
  commentCount: number | null,
  title = id,
  postedAt = "2026-05-25T00:00:00Z",
): NewsItem {
  return {
    source,
    externalId: id,
    title,
    url: "https://example.com",
    commentsUrl: null,
    commentCount,
    postedAt,
  };
}

describe("news ticker display helpers", () => {
  it("uses short labels for long source ids", () => {
    expect(newsSourceLabel("reddit_programming")).toBe("REDDIT");
    expect(newsSourceLabel("arxiv_cs_ai")).toBe("ARXIV AI");
    expect(newsSourceLabel("unknown_source")).toBe("UNKNOWN SOURCE");
  });

  it("sanitizes source class modifiers", () => {
    expect(newsSourceClass("reddit_programming")).toBe("news-src-reddit_programming");
    expect(newsSourceClass("bad/source")).toBe("news-src-bad-source");
  });

  it("uses a stable item key for marquee list identity", () => {
    expect(newsTickerItemKey(item("hn", "42", null))).toBe("hn:42");
  });

  it("keeps marquee order stable on polling and appends new items to the tail", () => {
    const previous = [item("hn", "old", 10), item("hn", "older", 1)];
    const incoming = [
      item("hn", "new", 20),
      item("hn", "old", 11, "old-updated"),
      item("hn", "older", 2),
    ];

    expect(mergeNewsTickerItems(previous, incoming).map((it) => it.externalId)).toEqual([
      "old",
      "older",
      "new",
    ]);
    expect(mergeNewsTickerItems(previous, incoming)[0].title).toBe("old-updated");
  });

  it("replaces the marquee pool when filters or sources produce a disjoint result", () => {
    expect(
      mergeNewsTickerItems([item("hn", "old", null)], [item("geeknews", "fresh", null)]).map(
        (it) => it.externalId,
      ),
    ).toEqual(["fresh"]);
  });

  it("marks composite top-quartile items as hot — engagement breaks ties at equal recency", () => {
    // 동일 시각(recency 동률) → engagement(commentCount)가 hotness 순서를 가른다.
    const items = [item("hn", "hot", 80), item("hn", "warm", 20), item("hn", "low", 5)];
    expect(isHotTrendingNews(items[0], items)).toBe(true);
    expect(isHotTrendingNews(items[1], items)).toBe(false);
    expect(isHotTrendingNews(items[2], items)).toBe(false);
  });

  it("treats a much fresher item as hot even with zero engagement (recency-driven)", () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const items = [
      item("geeknews", "fresh", null, "fresh", now),
      item("hn", "stale1", null, "stale1", old),
      item("hn", "stale2", null, "stale2", old),
      item("hn", "stale3", null, "stale3", old),
    ];
    // 댓글 수가 전혀 없어도 가장 신선한 항목이 상위 분위에 들어 🔥.
    expect(isHotTrendingNews(items[0], items)).toBe(true);
    expect(isHotTrendingNews(items[3], items)).toBe(false);
  });
});
