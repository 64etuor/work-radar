# 거버넌스 ADR (Boule 하네스 전용)

Boule 거버넌스 하네스의 architecture decision records. **포맷·라이프사이클·불변 규칙은
repo-root `docs/adr/README.md`가 정본** — 여기에 중복하지 않는다.

- **ID는 repo 전역에서 유일하다.** 앱 ADR은 `docs/adr/`(0001–0006), 거버넌스 ADR은 여기(0007–).
  같은 `adr-id`를 두 디렉터리에 두지 않는다(인덱스 빌드가 충돌을 hard-error로 거부 — `governance/src/index/build.ts`).
- 명명 = `{NNNN}-{kebab}.md`(`docs/adr/README.md` 규칙 동일).
- 인덱스 어댑터(`build.ts`)는 `docs/adr/`와 `governance/docs/adr/`를 **둘 다** 읽는다(additive,
  `DEFAULT_INDEX_SOURCES`). `decision-rails.md`·repo 전역 `docs/decisions.md`는 repo-root 잔류.
- 거버넌스 결정 로그(Phase 트레이드오프/breadcrumb)는 `../decisions.md`(이 디렉터리 옆).

현재 거버넌스 ADR:

- `0007-governance-approval-via-hermes-native-acp.md`
- `0008-orchestrator-dispatch-decision-rail.md`
- `0009-live-autonomy-executor-and-readiness.md`
