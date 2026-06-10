# Step Worktree Chaining — plan 브랜치로 step 산출물 연결

Status: implementing
Date: 2026-06-10
Driver: 라이브 자율 루프 감사 (plan evt_20260610_075405_4553, Weekly Review Life Wheel)

## 문제 (라이브 실증)

`adapter.ts createWorktree`가 매 step `git worktree add --detach <path> HEAD`로
워크트리를 만든다 → **각 step이 이전 step의 산출물을 전혀 보지 못한다.**

2026-06-10 라이브 런에서 관측된 결과:

- step1이 `src/lib/weeklyLifeWheel.ts`(7축, on-spec)를 만들었으나 step2 워크트리에 없음
  → step2가 `src/lib/lifeWheelRadar.ts`(off-spec WorkSignal 소스)로 **재구현**
- step3가 step2의 의존성-프리 SVG 라더를 못 본 채 recharts로 **세 번째 재구현**
- step5(테스트)는 테스트할 코드가 워크트리에 없어 escalate —
  "3 uncommitted, UNINTEGRATED, COMPETING helpers" (decision_blocked evt_20260610_085217_ae6d)
- 산출물 전부 각 워크트리에 미커밋 고아 상태. plan이 "완주"해도 dev에 아무것도 남지 않음.

## 설계

**Plan 브랜치 체이닝.** plan마다 로컬 브랜치 `boule/<planId>` 하나:

1. **step 완료 통과 시 커밋** — `completeReportedDone`에서 completion gate가 `pass`로
   판정한 직후, step 워크트리의 변경을 detached HEAD에 커밋하고(`--no-verify`,
   husky/장시간 훅 회피) `boule/<planId>` 브랜치를 그 커밋으로 `branch -f` 갱신.
   클린 트리(변경 0)면 커밋 생략(브랜치 갱신도 생략). 이후 `completeTask`는 기존과 동일.
2. **워크트리 base 해석** — `createWorktree`가 `refs/heads/boule/<planId>`를
   `rev-parse --verify --quiet`로 확인: 존재하면 그것을 base로, 없으면(첫 step) `HEAD`.
   재시도(attemptIndex>0)도 같은 규칙 — 실패한 attempt는 커밋된 적이 없으므로 자연히
   직전 성공 step 위에서 재시작한다.
3. **merge-back은 human 게이트 유지** — plan 종료 시 `boule/<planId>`가 통합 산출물.
   dev 반영은 사람이 브랜치를 merge(파일 복사 금지 — parallel-agent-safety "브랜치 salvage" 규칙).
   자동 merge/push는 이 변경의 범위 밖(INVARIANT #1 보존: 외부 반영 자동화 없음).

## 왜 이 설계인가 (대안 비교)

- **단일 plan 워크트리 공유(대안 B)**: node_modules 1회 설치 장점이 있으나 attempt/재시도
  semantics가 깨지고(실패 attempt가 트리를 오염) 워크트리 수명 관리가 침습적으로 바뀜.
  per-step 워크트리 + 브랜치 base 전환이 기존 구조(worktreePathFor, attempt suffix)를 보존하는
  최소 변경.
- 커밋 시점을 session close(wrapper)가 아닌 completion gate pass 직후로 둔 이유:
  (a) evaluator가 보는 worktreeDiff가 커밋으로 비워지기 전에 평가가 끝나야 하고,
  (b) needs_human/fail 산출물이 브랜치에 들어가면 안 되기 때문(통과한 것만 체인).

## 안전 성질

- `.boule/`(mcp.json, step-prompt.md)·`node_modules`는 gitignored → `git add -A`에 안 잡힘.
- 커밋은 gitignored 워크트리 + 로컬 브랜치 ref에만 발생. push 없음, 외부 mutation 없음.
- `boule/<planId>` 브랜치는 어떤 워크트리에도 checked-out 되지 않으므로(전부 detached)
  `branch -f`가 항상 안전.
- 사용자 워킹트리 무손상(INVARIANT #6): 모든 git op는 `-C <worktree>` 또는 `-C <repoRoot>`.
- 잔여 브랜치는 housekeep follow-up(기존 `boule housekeep` CLI 확장)으로 정리 — 이 PR 범위 밖.
- **운영 직렬화 전제**: tick은 외부 heartbeat 1개가 직렬로 돈다(in_flight 가드 + 데몬 아님).
  동시 tick 2개가 같은 plan의 commit/branch -f를 경합하는 구성은 지원하지 않는다 — cron 와이어링
  시 단일 인스턴스(lock 또는 단일 스케줄)로 유지할 것. 사람이 `boule/<planId>`를 checkout한 채면
  (merge-back 중) `branch -f`가 실패하고 needs_human으로 fail-closed.

## 변경 지점

- `src/conductor/completion.ts` — `CompletionDeps`에 `commitStepOutput(worktreePath, planId,
  stepIndex)` 추가(+node 구현: add -A → diff --cached --quiet로 dirty 판정 → commit --no-verify
  → branch -f). pass 직후 호출. 실패는 needs_human으로 강등(fail-closed: 체인이 끊긴 채
  완료로 처리하지 않는다).
- `src/conductor/adapter.ts` — `createWorktree`: plan 브랜치 존재 시 base 교체.
- 테스트: `test/conductor/completion.test.ts`(pass에서만 commit 호출·실패 시 needs_human),
  `test/conductor/handlers.test.ts` 또는 adapter 테스트(base 해석 양 갈래 spawn 시퀀스).

## Done criteria

- governance vitest 전체 green (기존 715+신규).
- tsc 0.
- 별도 opus critic 패스 ACCEPT(self-approve 금지).
- 기존 plan(체인 없는 과거 이벤트)에 대해 무해: 브랜치 없으면 기존 HEAD 동작과 동일.
