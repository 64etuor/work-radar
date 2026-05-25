-- 소스별 on/off. 기본 enabled=1 — fetcher가 처음 페치할 때 registry로부터 누락 행 upsert.

CREATE TABLE news_source_pref (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
) STRICT;
