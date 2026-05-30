-- Work Radar — schema v38 (Phase 3 #12: 스킬 태그 + 필터)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 왜 필요한가:
--   인앱 프롬프트(DB 행)와 외부 스킬(디스크 SSOT)을 사용자 태그로 분류/필터한다. 외부 스킬은
--   `skills` 테이블에 행이 없으므로(디스크가 SSOT) FK 없는 **독립 매핑**으로 둔다. 키는 프런트가
--   쓰는 **통합 Skill.id**다: 인앱=행 id, 외부='ext:'+SKILL.md 절대경로(= `list_skills` 합성 id와
--   동일). 한 키로 두 종류를 모두 다루므로 합성 컬럼/분기 없이 단일 표로 충분하다.
--
-- INVARIANT #1: 사람 태깅 전용 — 자동 분류 0. 태그는 표시/필터 메타일 뿐 결정 레일과 무관하다.
-- INVARIANT #7: 인앱 태그는 로컬 SQLite SSOT. 외부 태그도 로컬 SQLite에만 영속한다 — **외부 SKILL.md
--   파일은 절대 쓰지 않는다**(외부는 읽기 전용, 파일 무변경). 외부 파일이 옮겨지거나 삭제되면 orphan
--   행이 남을 수 있으나 무해하다(매칭되는 스킬이 없어 표시되지 않음). 인앱 행 삭제 시 그 키의 태그는
--   `delete_skill`에서 함께 정리한다. 토큰/비밀은 담지 않는다.

PRAGMA foreign_keys = ON;

-- 스킬 ↔ 사용자 태그 매핑(다대다). skill_key = 통합 Skill.id(인앱=행 id, 외부='ext:'+source_path).
CREATE TABLE skill_tags (
  skill_key  TEXT NOT NULL,                          -- 통합 Skill.id(FK 아님 — 외부 키는 부모 행이 없음).
  tag        TEXT NOT NULL,                          -- 사용자 태그 라벨(set 시 trim·비어있지 않음·dedup).
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (skill_key, tag)                       -- 같은 스킬에 동일 태그 중복 금지(set 멱등).
);

-- 태그별 필터 핫패스(태그 → 스킬들).
CREATE INDEX idx_skill_tags_tag ON skill_tags (tag);
