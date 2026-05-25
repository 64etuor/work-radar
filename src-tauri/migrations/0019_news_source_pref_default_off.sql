-- 신규 소스(D-Expand)는 default OFF로 시드 — 사용자가 설정에서 켜야 노출.
-- 기존 hn/geeknews/lobsters는 건드리지 않음(이미 default ON 동작).
-- ON CONFLICT DO NOTHING → 사용자가 이미 켰다면 그 상태 보존(멱등 재실행 안전).

INSERT INTO news_source_pref(source, enabled) VALUES
    ('reddit_programming', 0),
    ('devto', 0),
    ('naver_d2', 0),
    ('kakao_tech', 0),
    ('woowahan_tech', 0),
    ('toss_tech', 0),
    ('line_engineering', 0),
    ('yozm_it', 0),
    ('arxiv_cs_lg', 0),
    ('arxiv_cs_ai', 0)
ON CONFLICT(source) DO NOTHING;

-- 성능: list_recent의 ORDER BY n.posted_at + 필터 JOIN.
-- 7일 TTL × 13 소스 × ~30/소스 = ~2700 rows 예상이지만 인덱스로 안전 마진.
CREATE INDEX IF NOT EXISTS idx_news_items_source_posted
    ON news_items(source, posted_at DESC);
