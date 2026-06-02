# orchestrator/ — Orchestrator 정책·상태머신 (Phase E에서 채움)

오케스트레이터의 **사람-저술** 운영 정의. 코드가 아니라 SSOT의 일부(에이전트 명세처럼).
Phase E(observe/suggest only) 착수 시 다음을 채운다:

- `policies.md` — Policy Evaluator 규칙 (allow / suggest / deny 판정 근거)
- `state-machines.md` — Task/Plan/Session/Handoff 전이표 + 가드 (정본 서술)
- `routing.md` — Scheduler: ready task → role 매칭, parallelism limit, dependency
- `safety-rails.md` — Safety Gate: Type 1 / 권한 / 경로 / 외부영향 / destructive 차단 목록
- `session-templates/` — role별 세션 부트스트랩 (implementer / reviewer / tester / researcher / debugger)

**불변(`../HARNESS.md` §4):** 오케스트레이터는 propose-only. 어떤 정책도 `decision_*` verdict
write-path를 부여하지 않는다. "auto"는 task dispatch 속성이지 decision approval 속성이 아니다.
