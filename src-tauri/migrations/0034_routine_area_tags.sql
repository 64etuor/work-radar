-- 루틴에 Life Wheel 태그 부착(signals 0026 패턴 미러링).
-- area_tags: 사용자정의 tag key JSON 배열(예: ["health"] 또는 ["custom-id"]).
-- 기존 area(닫힌 AreaTag) 컬럼은 builtin tag key가 선택됐을 때만 primary로 동기화한다.
ALTER TABLE routines ADD COLUMN area_tags TEXT;
