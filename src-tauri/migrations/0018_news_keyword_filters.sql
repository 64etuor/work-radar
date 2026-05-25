-- 키워드 필터. include 행이 하나라도 있으면 그 중 적어도 하나가 제목에 들어가야 표시(OR).
-- exclude 행은 제목에 들어가면 숨김(AND). 비교는 NOCASE.

CREATE TABLE news_keyword_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('include','exclude')),
    UNIQUE (keyword, mode)
) STRICT;
