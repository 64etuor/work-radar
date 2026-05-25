CREATE TABLE news_options (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_limit INTEGER NOT NULL DEFAULT 30,
    per_source_limit INTEGER NOT NULL DEFAULT 10,
    sort_mode TEXT NOT NULL DEFAULT 'recent'
        CHECK (sort_mode IN ('recent','comments','mixed')),
    fetch_interval_minutes INTEGER NOT NULL DEFAULT 15
        CHECK (fetch_interval_minutes IN (0, 5, 10, 15, 30, 60))
) STRICT;

INSERT INTO news_options(id) VALUES (1) ON CONFLICT DO NOTHING;
