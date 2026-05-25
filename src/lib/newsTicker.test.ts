import { describe, expect, it } from "vitest";

import type { NewsItem } from "@/bindings";
import { isHotTrendingNews, newsSourceClass, newsSourceLabel } from "./newsTicker";

function item(source: string, id: string, commentCount: number | null): NewsItem {
  return {
    source,
    externalId: id,
    title: id,
    url: "https://example.com",
    commentsUrl: null,
    commentCount,
    postedAt: "2026-05-25T00:00:00Z",
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

  it("marks only high-comment top-quartile items as hot trending", () => {
    const items = [item("hn", "hot", 80), item("hn", "warm", 20), item("hn", "low", 5)];
    expect(isHotTrendingNews(items[0], items)).toBe(true);
    expect(isHotTrendingNews(items[1], items)).toBe(false);
    expect(isHotTrendingNews(items[2], items)).toBe(false);
    expect(isHotTrendingNews(item("geeknews", "none", null), items)).toBe(false);
  });
});
