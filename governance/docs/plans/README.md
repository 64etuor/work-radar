# plans/ — 읽는 법

**plan 문서는 착수 시점의 스냅샷이다. todo 리스트로 읽지 말 것.**

- "지금 무엇이 어디까지"의 진실 = `../STATUS.md`(유일한 moving ledger) + `docs/decisions.md`(DL
  breadcrumb) + git 히스토리. plan 본문의 체크박스/큐는 작성 시점 기준이며 사후 갱신 의무가 없다.
- plan이 추월당하면 본문 머리에 **SUPERSEDED 배너**(날짜 + 후속 문서)를 단다 — 본문을 다시 쓰지
  않는다(예: `2026-06-04-governance-continuation-master-plan.md`).
- INDEX/STATUS가 plan의 상태를 중복 기록하다 썩는 것을 막기 위해, plan별 상태는 **STATUS.md 한
  곳에만** 둔다(`../conventions.md` §3).

(이 규약은 `docs/superpowers/plans/README.md`의 snapshot 규약을 거버넌스 버킷에 채택한 것 —
2026-06-12 정합 패스 P0.)
