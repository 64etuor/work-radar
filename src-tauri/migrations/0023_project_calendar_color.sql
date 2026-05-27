-- 프로젝트별 캘린더 표시 배경색. NULL이면 앱이 project id 기반 기본 팔레트를 계산한다.
-- 텍스트색은 저장하지 않고 렌더/DTO 생성 시 배경색 대비로 자동 계산한다.
ALTER TABLE projects ADD COLUMN calendar_color TEXT;
