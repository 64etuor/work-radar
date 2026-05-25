-- 외부 뉴스 소스(HN/GeekNews/Lobsters) 캐시.
-- (source, external_id)로 dedup upsert(signal_store 패턴 동일).
-- fetched_at 인덱스로 최근순 정렬 + 7일 만료 cleanup 효율.

CREATE TABLE news_items (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    comments_url TEXT,
    comment_count INTEGER,
    posted_at TEXT NOT NULL,   -- RFC3339
    fetched_at TEXT NOT NULL,  -- RFC3339
    PRIMARY KEY (source, external_id)
) STRICT;

CREATE INDEX news_items_fetched_at ON news_items(fetched_at DESC);
CREATE INDEX news_items_posted_at ON news_items(posted_at DESC);
