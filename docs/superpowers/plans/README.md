# superpowers plans — status convention

이 디렉터리의 plan 문서는 **착수 시점의 실행 계획 스냅샷**이다. 머지 후에는 갱신하지
않으며, landed 여부·실제 결과의 정본은 `docs/decisions.md`(+ git 히스토리)다.

읽는 에이전트 규칙:

- 여기 있는 plan을 "현재 해야 할 일"로 읽지 말 것 — 대부분 이미 출하된 이력이다.
- 진행 중 작업의 진입점은 `PLAN.md` 상태 노트와 `docs/decisions.md` 최신 항목.
- 새 plan을 추가할 때는 본문 상단에 Date를 명시하고, 출하되면 `docs/decisions.md`에
  한 줄 breadcrumb을 남긴다(이 디렉터리의 파일은 그대로 둔다 — 이동/rename 금지,
  기존 참조 링크 보존).
