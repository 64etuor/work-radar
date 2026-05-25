import { describe, expect, it } from "vitest";

import newsQuerySource from "./query/news.ts?raw";

describe("news ticker refresh", () => {
  it("invalidates the list when the backend fetcher emits updates", () => {
    expect(newsQuerySource).toContain('listen("news_items_updated"');
    expect(newsQuerySource).toContain('invalidateQueries({ queryKey: ["newsList"] })');
  });
});
