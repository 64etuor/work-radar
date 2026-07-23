-- Reading domain foundation (docs/plans/2026-07-23-reading-domain.md).
-- Scope: local SQLite SSOT for the personal book log — bibliographic records, status
-- tracking (to_read/reading/finished/abandoned), reading sessions (progress facts),
-- quotes, and yearly goals. Bibliographic fields mirror the user's Obsidian book
-- frontmatter (title/author/total_page/cover_url/my_rate 0..10/start·finish dates).

-- 서지 + 상태. authors/categories는 JSON 배열 TEXT(개인용 — 조인 테이블은 YAGNI).
-- rating은 옵시디언 my_rate 호환 0..10 스케일(명예의 전당 티어 S/A/B/C/D 규칙 유지).
CREATE TABLE books (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  subtitle       TEXT,
  authors        TEXT NOT NULL DEFAULT '[]',
  publisher      TEXT,
  published_date TEXT,
  isbn13         TEXT,
  isbn10         TEXT,
  page_count     INTEGER CHECK (page_count > 0),
  cover_url      TEXT,
  description    TEXT,
  categories     TEXT NOT NULL DEFAULT '[]',
  language       TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',
  source_ref     TEXT,
  status         TEXT NOT NULL DEFAULT 'to_read'
                 CHECK (status IN ('to_read','reading','finished','abandoned')),
  rating         REAL CHECK (rating >= 0 AND rating <= 10),
  review         TEXT,
  started_on     TEXT,
  finished_on    TEXT,
  current_page   INTEGER NOT NULL DEFAULT 0 CHECK (current_page >= 0),
  favorite       INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

-- 같은 책 재등록 방지(dedup upsert 대상 — add_book이 기존 행을 반환).
CREATE UNIQUE INDEX idx_books_isbn13 ON books(isbn13) WHERE isbn13 IS NOT NULL;
CREATE INDEX idx_books_status ON books(status, updated_at DESC);
CREATE INDEX idx_books_finished_on ON books(finished_on) WHERE finished_on IS NOT NULL;

-- 독서 세션 = 날짜별 사실 로그(히트맵/스트릭/진행률 SSOT).
-- end_page = 세션 종료 시점 현재 위치(페이지 수가 아님). 기록 시 books.current_page를
-- 전진시키되 후퇴는 시키지 않는다(정정은 update_book으로).
CREATE TABLE reading_sessions (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  end_page   INTEGER CHECK (end_page >= 0),
  minutes    INTEGER CHECK (minutes > 0),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_reading_sessions_book ON reading_sessions(book_id, date);
CREATE INDEX idx_reading_sessions_date ON reading_sessions(date);

-- 발췌/인용 + 내 생각.
CREATE TABLE book_quotes (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  quote      TEXT NOT NULL,
  page       INTEGER CHECK (page >= 0),
  thought    TEXT,
  favorite   INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_book_quotes_book ON book_quotes(book_id, created_at);

-- 연간 목표(옵시디언 대시보드의 GOAL=52 하드코딩을 테이블로). 페이스 계산은 프런트.
CREATE TABLE reading_goals (
  year         INTEGER PRIMARY KEY CHECK (year BETWEEN 2000 AND 2100),
  target_books INTEGER NOT NULL CHECK (target_books > 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
