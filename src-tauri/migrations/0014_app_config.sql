-- Work Radar — schema v14 (Phase 18: 네비게이션 설정 — keymap + 글로벌 창 핫키)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 왜 필요한가:
--   Phase 18은 (1) 메뉴별 키보드 단축키(view→shortcut)와 (2) 글로벌 창 토글 핫키를
--   사용자가 편집·영속할 수 있게 한다. 둘 다 per-machine UI 환경설정(동기 대상 아님)이라
--   key-value 한 테이블에 둔다. 글로벌 핫키는 Rust setup()에서 읽어 재등록하므로(렌더러 무관)
--   SQLite SSOT에 두는 게 파일 IO 별도 경로 도입보다 단순하다(INVARIANT #7 정신 — 로컬 상태).
--
-- 설계 선택(JSON config vs migration): migration을 택함.
--   - Rust setup()에 이미 DB 풀이 있어 startup 핫키 read에 추가 파일 경로 해석이 불필요.
--   - 모든 영속 상태를 SQLite로 통일(scheduler/notification 패턴과 일관).
--   - keymap은 단일 JSON 값 행(`nav.keymap`)으로, 핫키는 문자열 행(`nav.global_hotkey`)으로 둔다.
--
-- 토큰/외부 무관 — 민감정보 아님(키 조합 문자열뿐). keychain 대상 아님.

PRAGMA foreign_keys = ON;

CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,            -- 'nav.global_hotkey' | 'nav.keymap' …
  value      TEXT NOT NULL,               -- 스칼라 문자열 또는 JSON 직렬화 값
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
