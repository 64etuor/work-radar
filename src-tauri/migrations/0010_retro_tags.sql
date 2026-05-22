-- Phase 17 — 회고(retro) 태깅 컬럼. 완료한 todo에 사람이 impact/regret를 단다.
-- INVARIANT #1: 사람 태깅 전용(자동 분류 0). INVARIANT #7: 로컬 SQLite SSOT.
-- bool은 SQLite 관례대로 INTEGER 0/1. 기존 행은 NULL(미태깅)로 진입한다.
ALTER TABLE signals ADD COLUMN impact_high INTEGER;
ALTER TABLE signals ADD COLUMN regret INTEGER;
