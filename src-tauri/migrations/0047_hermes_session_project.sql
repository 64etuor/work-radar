-- Hermes 세션 ↔ 프로젝트 바인딩. 바인딩된 프로젝트의 DB-resolved local repo의
-- .boule/mcp.json이 그 세션의 ACP session/new에 boule-governance MCP로 주입된다
-- (레포 경로는 항상 DB가 해석 — 렌더러 제공 금지 INVARIANT, ticker와 동일 원칙).
-- NULL = 바인딩 없음(주입 없음, 기존 동작).
ALTER TABLE hermes_session
  ADD COLUMN project_id TEXT;
