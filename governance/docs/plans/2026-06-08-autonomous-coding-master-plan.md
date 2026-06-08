# Autonomous Coding Master Plan — Backend Selection Policy Engine (난이도 라우팅 · 예산 거버넌스 · 완료 권위 · 정족수 체인)

- **Date**: 2026-06-08
- **Author**: claude (Opus) — 2-brain(codex:1 claude:1). codex consult(clean `CODEX_HOME` 격리로 hook hijack 회피, `codex-cli 0.137.0`, exit 0, 98.4k tok)가 **아키텍처·페이징을 재정렬**했다. 모든 "이미 빌드됨" 주장은 `plan/autonomous-orchestration`(`457c1e9`) + dev 소스로 검증(메모리 아님).
- **Status**: SPEC / 마스터플랜. 구현은 페이즈별 별도 슬라이스(TDD + 별도 critic 패스).
- **선행 정본**:
  - `governance/docs/plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` — 라이브 루프 L0–L6(거의 DONE). 이 플랜은 그 위에 **모델-선택 지능**을 얹는다.
  - `governance/docs/plans/2026-06-07-configurable-backends-wiring.md` — backends 배선 RFC(DRAFT). 이 플랜이 그 4개 슬라이스를 **마스터플랜 페이즈로 승격·재정렬**하고 난이도 라우팅 + 예산 거버넌스를 추가한다.
  - `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` — v3 control-plane 설계(상위 아키텍처).
- **이 플랜이 닫는 갭(사용자 요구)**: ① 자율 레벨(✅ 이미 있음) ② 리뷰 정족수(✅ 이미 있음) ③ **토큰에 따른 모델 자동 전환**(🟡 CORE만, 배선 미완) ④ **OMC식 난이도 기반 모델 자동 파견**(❌ 부재). 이 플랜은 ③④를 첫째급으로 명세하고, ①②를 기반으로 참조한다.

---

## 0. 한 줄 요약 / 사용자 확정

**라이브 루프는 닫혔다(이전 마스터플랜). 이제 빠진 건 "어떤 모델이, 얼마의 예산으로, 누가 완료를 판정하느냐"의 지능이다.**

사용자 확정(2026-06-08):
1. **산출물 = 통합 마스터플랜 신규 작성** (L0–L6 라이브 입증 + backends RFC + 난이도 라우팅을 하나로).
2. **난이도 신호 = Planner가 plan-step에 `difficulty` 명시**(heuristic 보완), conductor가 난이도→모델 티어 자동 배정(OMC `model_routing` 패턴 이식).
3. **비용/예산 거버넌스 = 티어 하향 + provider 전환(codex) 둘 다.** codex를 적극 활용하는 정책.
4. **Evaluator-as-completion-authority = 핵심 자율성 페이즈로 포함.**
5. **2-brain = 네이티브 codex consult**(omc-teams CLI는 cmux startup stall 이력).

### 0.1 자율의 경계 (불변 — INVARIANT #1 재확인)

이 플랜은 자율의 **경계를 바꾸지 않는다**. 모델 선택·예산·완료 판정은 전부 **fail-closed**:

> 어떤 degrade/exhaust 경로도 게이트를 *열지* 않는다. 고갈/불명/초과 → 그 역할의 **사람-대기 terminal**(executor=stall / reviewer=blocked / evaluator=needs_human). auto-approve · auto-complete · silent-skip 전부 금지. spawn된 executor 세션은 verdict/완료 권위를 **구조적으로** 가질 수 없다(역할별 MCP 도구 표면 = prompt 아닌 구조).

`accept_spec`/`accept_plan`은 여전히 사람 게이트(autonomyLevel `auto_plan`/`full`은 test/dev 한정 opt-in, 프로덕션 기본 아님). 모델이 싸지거나 예산이 빠듯해도 이 경계는 불변이다.

---

## 1. 통합 아키텍처 — Backend Selection Policy Engine

모든 모델-선택 관심사(난이도·예산·토큰고갈)를 **하나의 순수 resolver + 기존 `runWithFallback`** 로 통일한다. codex 합의: *역할당 단일 resolved 체인 하나*. 난이도는 head를 **고르고**, 예산은 출시 전 후보를 **거르고**, token_exhausted는 런타임에 체인을 **전진**시킨다. 세 관심사가 각자 다른 provider를 부르는 "정책 스파게티 + 숨은 fallback"을 금지한다.

```
plan-step ──┐
            ▼
  난이도(step.difficulty + heuristic)  ──▶  이상적 head 후보 선택
                                              (trivial→cheap/codex·haiku, standard→sonnet/codex-mid, hard→frontier claude)
  예산(BudgetSnapshot + priceTable)    ──▶  출시 전 affordability 필터
                                              (감당 못 할 후보 drop; codex 후보 = 저비용 rung으로 체인에 내재 — 사이드도어 X)
            ▼
   resolveBackendChain(role, step, policy, budgetSnapshot, priceTable)
            │
            ├─▶ ResolvedChain  ──runWithFallback(role, chain, attempt)──▶  런타임 token_exhausted/transient → 다음 rung 전진
            │                                                              (이미 빌드됨: backends/fallback.ts)
            └─▶ Terminal (감당 가능 후보 0)  ──▶  fail-closed halt (role별 terminal)
```

**핵심 불변 (codex A/D):**
- **난이도는 실행하지 않는다 — head를 고를 뿐.** 실행은 항상 `runWithFallback`.
- **예산 압박 ≠ token_exhausted.** 예산은 *출시 전* pre-resolution 필터(사전), token_exhausted는 *런타임* 체인 전진(사후). 둘은 다른 이벤트, 둘 다 같은 한 체인 위에서 일어난다.
- **provider-switch-to-codex = 체인 안의 저비용 후보.** 별도 정책 분기 금지(테스트 불가·숨은 fallback의 원천).
- **`runWithFallback`는 재사용** — 새 실행 경로를 만들지 않는다. resolver는 *어떤 체인을* 넘길지만 정한다.

### 1.1 BackendCandidate (resolver의 단위)

resolver가 다루는 후보 = `{ provider, model, tier, estCostPerStep, capabilityFloor, role }`. `backends/config.ts`의 `BackendSpec`을 priceTable + tier 메타로 확장(또는 resolve 시 조인). priceTable은 비용 불명을 **공짜로 취급하지 않기** 위한 정본(불명 → 보수적 최댓값 또는 terminal).

---

## 2. 스키마 추가 (신규 — 전부 additive·backward-compatible)

생략 시 오늘 동작과 동일(golden test로 고정). 새 필드는 전부 optional.

### 2.1 plan-step 스키마

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `difficulty` | `"trivial" \| "standard" \| "hard"` (optional) | Planner가 명시. resolver의 head 선택 입력. 생략 → heuristic 추정 또는 `standard` 기본. |
| `check` | `{ command?: string; artifact?: string }` (optional) | **deterministic evaluator 계약**. evaluator 체인의 deterministic last-rung은 *오직 이 계약이 있을 때만* 통과 가능(아래 M1). 없으면 deterministic rung은 pass 불가(=fail-closed). |

> ⚠️ codex 경고(채택): "deterministic evaluator last-rung을 안전밸브로 보는 건 위험. step이 구체적 check를 선언할 때만 안전. 일반 deterministic 완료는 '이름만 그럴듯한 auto-complete'." → deterministic rung은 `check` 없으면 **구조적으로 통과 불가**.

### 2.2 boule.config.json (`overrides.*`)

| 필드 | 의미 |
| --- | --- |
| `overrides.backends` | (이미 있음) per-role 체인. evaluator 포함. |
| `overrides.routing` | 난이도→티어 표 + heuristic 가중치. 생략 → backends 체인 순서에서 파생되는 기본 매핑. |
| `overrides.budget` | `{ runTokenCap?, stepTokenCap?, runCostCapUsd?, stepCostCapUsd? }`. cap 도달 시 하향→그래도 초과면 fail-closed halt. |
| `overrides.priceTable` | provider/model→토큰당 비용. 비용 계산·affordability 필터의 정본. (또는 코드 기본 표 + config override.) |

`policyEnv()`는 스칼라만 운반(autonomyLevel/autoMode/reviewQuorum/forbidden/type2). **구조적 config(backends/routing/budget/priceTable)는 env 왕복 없이 in-process resolved policy로 전달**(RFC 원칙 4 = M0 P1). 자율 레벨·정족수는 **이미 있음** — 재정의 금지, 기반으로 참조.

---

## 3. INVARIANT #1 위험 등록부 + Negative Test (codex D 채택 — 리뷰 바)

이 엔진은 "싸게/빠르게"의 압력이 게이트를 몰래 여는 정확한 지점들을 만든다. 각 위험 = 반드시 **negative test**로 고정.

| # | 위험 (silent gate-opening 벡터) | Negative test (assert) |
| --- | --- | --- |
| R1 | 예산 하향이 `reviewQuorum`을 몰래 낮춤 | 예산 압박 하에서도 quorum 불변; 미달 → blocked |
| R2 | 예산 압박이 reviewer를 deterministic으로 스왑 | deterministic은 reviewer 역할에 **구조적 거부**(`assertProviderAllowed`) |
| R3 | 난이도 라우팅이 verdict 쓸 수 있는 싸구려 executor 배정 | executor 역할 MCP 표면에 verdict/완료 도구 0(구조적, prompt 아님) — 어떤 티어든 |
| R4 | token fallback이 reviewer 체인 고갈 → "이의 없음 = 승인" | 고갈된 reviewer 체인 → **절대 승인 안 함**, blocked |
| R5 | evaluator deterministic rung이 `check` 없이 auto-complete | `check` 부재 → deterministic pass 불가 → needs_human |
| R6 | codex 래퍼 / MCP `complete_task`가 계속 `task_completed`를 씀 | executor-side 완료 쓰기 0(M1); conductor가 evaluator 후 유일 writer |
| R7 | provider distinctness를 configured **head**로 카운트(실제 fallback 승자 아님) | quorum = **실제 응답한** provider/model의 distinct 카운트 |
| R8 | command provider가 스키마 미검증으로 우발 승인/pass | command reviewer/evaluator 출력 = 스키마 검증 필수; 미검증 → 미인정 |
| R9 | `auto_plan`/`full` × 예산 fallback이 프로덕션 기본에서 acceptance 게이트 개방 | auto_plan/full = config-only opt-in, 프로덕션 기본 아님; budget terminal은 acceptance와 무관 |

> 종합 negative 묶음: 고갈된 reviewer 체인은 절대 승인 안 함 · 고갈된 evaluator는 절대 완료 안 함 · quorum 절대 안 낮아짐 · executor 역할은 verdict/완료 권위를 mint 못 함 · deterministic reviewer 거부 · completion hint 단독으로는 완료 안 됨.

---

## 4. 페이즈 (M0 → M6) — codex 안전-우선 순서

근거(codex E): *리뷰/완료 게이트가 모델 선택보다 위험하다 → 선택 복잡도(난이도·예산)를 얹기 전에 권위 의미론(완료·정족수)부터 고정한다.* 이 순서가 실제로 사용자 목표("진짜 자율")에 가장 빠르다 — 지금 자율을 막는 최대 장애물은 codex의 ~60% `complete_task` 미준수(루프 행)이고, M1이 그걸 고친다. 난이도 라우팅은 그 위의 품질/비용 최적화다.

각 페이즈 공통 규율(repo durable):
- **TDD: RED → impl → GREEN**, 그다음 `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run`.
- repo 루트 app drift 0: `git diff --stat -- src/bindings.ts src-tauri/migrations`.
- **별도 critic 패스 ACCEPT(self-approve 금지)** 후에만 다음 페이즈.
- 해당 페이즈의 R# negative test 포함.
- **push/merge/deploy/credential은 사용자 명시 요청 시에만.**

---

### Phase M0 — Plumbing (P1): 구조적 policy in-process 전달

**Goal**: `policy.backends`(+ 신규 `routing`/`budget`/`priceTable`)를 env 왕복 없이 adapter·reviewer factory·conductor 완료 경로로 전달. 나머지 모든 페이즈의 전제.

**Deliverables**:
- `makeConductorAdapter({ ..., backends, routing, budget, priceTable })` + `liveReview({ ..., chain })` 시그니처(RFC §2 P1). MCP server + `boule tick`는 이미 resolved policy 보유 → 주입만.
- resolved policy 객체에 신규 필드 추가(`repo/config.ts` `ResolvedPolicy` + `resolvePolicy`), 전부 optional·additive.

**Done**: `overrides` 생략 시 오늘 동작 동일(golden test). 신규 필드가 소비자까지 in-process 도달(env 직렬화 0 — 원칙 4). tsc+vitest green, critic ACCEPT.

**Constraints**: env 스칼라 맵 불변; 구조적 데이터는 env 금지.

---

### Phase M1 — 완료 권위 (Evaluator as completion authority) ⭐ 최고 레버리지

**Goal**: executor가 자기 완료를 **인증하지 못하게** 하고, conductor가 evaluator 체인으로 완료를 판정. codex ~60% `complete_task` 미준수 갭을 닫는다(RFC Slice 4 승격).

**Sub-steps (codex C 채택)**:
1. **executor-side 완료 쓰기 전면 강등**: (a) b125664 exit-code 래퍼 `&& boule complete-task` → `&& boule report-exit`(verdict-free hint, `executor_reported_done`), (b) **MCP `complete_task`도 `task_completed` 쓰기 중단** → 같은 hint 이벤트로. 이 둘 다 demote해야 함 — 래퍼만 고치면 MCP 경로가 남은 bypass(codex 지적).
2. **conductor = `task_completed` 유일 writer**: executor 세션 **terminal 관측 후**(프로세스 종료/세션 crashed 확정) evaluator 체인 실행 → pass면 conductor가 `task_completed` mint.
3. **deterministic last-rung = `check` 계약 전용**: step `check.command` exit 0 / `check.artifact` 존재일 때만 pass. `check` 부재 → deterministic 통과 불가(R5).
4. **멱등키**: 평가 verdict 1개 / `taskId + sessionId + worktreeHead(diffHash)`. 재-dispatch·중복 평가 방지.

**TDD (stub)**: executor가 complete_task 호출 **없이** 종료 + evaluator pass → 완료(codex-adherence 수정) · evaluator 체인 고갈 → needs_human, step open 유지 · deterministic last-rung(`check` 있음) pass → 토큰 0으로 완료 · `check` 없는 deterministic → 통과 불가 · completion hint 단독 → 미완료 · 세션 terminal 전 평가 시도 안 함.

**Done**: executor-side 완료 쓰기 0(grep로 확인). evaluator가 유일 권위. R5/R6 negative green. (라이브 스모크 = 실제 codex가 작업 후 complete_task 안 불러도 evaluator가 루프 닫음 — 사용자/cmux, runbook.) critic ACCEPT.

**왜 먼저**: 권위 버그를 제거해 그 위 모든 라우팅/fallback을 안전하게 만든다. INVARIANT #1 강화(executor는 self-APPROVE 불가에 더해 이제 self-CERTIFY 완료도 불가 — R6/codex C).

---

### Phase M2 — Reviewer 정족수 체인 (quorum)

**Goal**: 각 quorum 멤버 = `backends.reviewers[i].chain`. 멤버별 `runWithFallback("reviewer", chain, attempt)`로 토큰 있는 첫 backend가 verdict. **실제 응답한** distinct provider/model이 `reviewQuorum` 이상이어야 통과(RFC Slice 3).

**Deliverables**:
- `decision/liveReviewer.ts` 멤버별 체인 + `decision/reviewer.ts` quorum 도출이 **configured head가 아니라 실제 응답 backend**로 distinct 카운트(R7; 기존 `deriveDecisionState` distinct-model 카운팅과 정렬).
- 체인 고갈 멤버 = verdict 무기여. distinct 미달 → `Terminal{reviewer:blocked}` → `decision_blocked`(사람). **절대 auto-approve·정족수 silent 하향 금지**(R1/R4).
- codex reviewer는 Slice 1 clean `CODEX_HOME` 적용(이미 있음).

**TDD**: quorum=2, 멤버 `[claude-chain, codex-chain]`, codex 토큰아웃+fallback도 토큰아웃 → distinct 1 → blocked(NOT approved) · 둘 다 성공 → approve · 같은 provider로 resolve되는 두 backend는 distinct 1로 카운트(R7).

**Done**: 고갈 reviewer 체인이 절대 승인 안 함; quorum = 실제 응답 distinct. R1/R4/R7 green. critic ACCEPT.

---

### Phase M3 — 순수 Backend Resolver (예산 없이)

**Goal**: `resolveBackendChain(role, step, policy)` 순수 함수 — 난이도+역할 입력으로 **이상적 head + 정렬된 체인**을 반환(예산 미반영). 이후 budget/difficulty 페이즈가 이 위에 얹힌다.

**Deliverables**:
- `backends/resolve.ts`(pure): `(role, step, policy) → ResolvedChain`. 난이도 → head 선택(routing 표 또는 backends 순서 파생 기본). 결과 체인은 `runWithFallback`가 소비.
- `assertProviderAllowed` 재사용(R2/R3 표면). resolver는 verdict-capable 역할에 deterministic 못 넣음.

**TDD**: trivial→cheap head, hard→frontier head · routing override 적용 · backends 미설정 → 오늘과 동일(단일 head) · deterministic은 executor/reviewer head로 거부.

**Done**: 순수·결정적·테스트 완비. 기존 executor/reviewer 경로가 resolver 경유해도 동작 불변(golden). critic ACCEPT.

---

### Phase M4 — 예산 거버넌스 (budget snapshot + 예약/정산)

**Goal**: run/step 토큰·비용 cap. 예산 압박 시 **출시 전** affordability 필터(티어 하향 + codex 후보로 전환), 그래도 감당 못 하면 **fail-closed halt**. token_exhausted와 별개 이벤트(codex A/B).

**Deliverables (codex B 채택)**:
- **BudgetSnapshot = 이벤트 저널 유도**(데몬 X, INVARIANT #5). 각 tick/conductor 패스에서 재구성. SSOT = events/(append-only) — Boule 기존 event-sourcing과 정렬.
- 순수 resolver 확장: `resolveBackendChain(role, step, policy, budgetSnapshot, priceTable) → chain | Terminal`. 감당 가능 후보만 체인에 남김; 0개 → Terminal.
- **예약-후-정산**: 출시 전 worst-case step cap 예약 → 사후 실제 usage로 정산. **crash-after-reserve-before-charge** = 다음 패스가 보수적 pending 예약을 보거나 run을 사람-대기로(spend "망각" 금지).
- **비용 불명 = 공짜 아님**: usage/cost 데이터 부재 + cap이 의미 있으면 fail-closed.

**TDD (결정적 주입)**: 고정 priceTable + 고정 누적 spend + 고정 추정 토큰 + 고정 provider outcome. 예산 빠듯 → 비싼 head drop, codex 후보로 하향 · 전 후보 초과 → Terminal(halt) · 비용 불명 + cap 활성 → fail-closed · 예약만 되고 charge 전 crash → 다음 패스 보수적.

**Done**: 예산이 모델 선택을 사전 제약하되 절대 게이트를 안 엶. R9(예산×acceptance 무관) green. critic ACCEPT.

---

### Phase M5 — 난이도 라우팅 라이브 (Planner 주석 + heuristic + executor 체인)

**Goal**: Planner가 plan-step `difficulty`를 실제로 명시 + heuristic 보완, executor가 resolved 체인으로 dispatch(RFC Slice 2 흡수), 라이브 입증. = 사용자 헤드라인 "OMC식 난이도 기반 모델 자동 파견".

**Deliverables**:
- **Planner 주석**: plan_proposed 생성 시 각 스텝에 `difficulty` 부여. 사람이 `accept_plan`에서 검토 가능(결정적·감사가능).
- **heuristic 보완 신호**(순수): 닿는 파일 수 · forbidden-class 존재 · scope 태그 등 구조적 신호 → difficulty 미명시/상향 보정.
- **executor 체인 배선(RFC Slice 2)**: conductor가 `resolveBackendChain("executor", step, policy, budget, price)` → `runWithFallback`. token_exhausted/transient → 다음 rung(codex 포함). 체인 고갈 → stall terminal(silent skip 0).
- **라이브 스모크(runbook)**: hard 스텝 → frontier 배정, trivial 스텝 → 저비용/codex 배정 관측. 예산 압박 시 codex로 하향 관측.

**TDD (stub)**: Planner 출력에 difficulty 존재 · heuristic이 미명시 스텝 보정 · 체인 `[codex, claude]` codex 토큰아웃 → claude 전진 후 closure · 전 고갈 → stall.

**Done**: 난이도→티어 자동 배정 + 예산 하향 + provider 전환이 라이브 관측. R3 green. critic ACCEPT. (라이브 = 사용자/cmux.)

---

### Phase M6 — 설정 표면 · Settings UI · ADR/문서

**Goal**: 새 노브를 사용자가 제어 가능하게 + 포스처 확정.

**Deliverables**:
- boule.config 스키마: `routing`/`budget`/`priceTable` + `boule set`(autonomy-level·review-quorum 패턴 재사용) + `boule status` 노출.
- **work-radar Settings UI**: backends/routing/budget 편집(기존 BouleConfig Settings 슬라이스 확장 — 메모리 [[work-radar-dev-followups-1234]]). bindings drift 0(specta 재생성 + CI 게이트), app SQLite/migration 무변경(INVARIANT #4/#6).
- **ADR**: 난이도 라우팅 + 예산 거버넌스 + 완료 권위 포스처. `governance/docs/adr/`(naming = conventions.md §4).
- runbook 통합 + `governance/docs/INDEX.md` 갱신 + `governance/docs/decisions.md` GDL breadcrumb.

**Done**: operator가 런북만으로 난이도/예산 설정 → 자율 실행 재현. push/merge = 사용자 게이트.

---

## 5. 의존 그래프

```
M0 (plumbing P1)
 ├─ M1 (완료 권위 / evaluator) ⭐ 최고 레버리지·먼저
 │    └─ M2 (reviewer 정족수 체인)
 │         └─ M3 (순수 resolver)
 │              └─ M4 (예산 거버넌스)
 │                   └─ M5 (난이도 라우팅 라이브 + executor 체인)
 │                        └─ M6 (config·UI·ADR/문서)
 └─ (M1 후 M2와 병렬 가능 항목 없음 — 권위→정족수→선택은 직렬 안전 순서)
```

codex 권고 순서 그대로: 권위(M1) → 정족수(M2) → resolver(M3) → 예산(M4) → 난이도(M5). 선택 복잡도는 권위 의미론이 고정된 **뒤에만** 얹는다.

---

## 6. INVARIANT 준수 (decision-rails — 리뷰 바)

| # | 이 플랜에서의 posture |
| --- | --- |
| 1 자동화→결정레일 침투 금지 | resolver/budget/evaluator 전부 fail-closed; reviewer/evaluator 고갈 → 사람-대기 terminal; executor 역할 verdict/완료 도구 0(구조적); quorum silent 하향 0(R1); §3 위험 전부 negative test. |
| 2 외부 토큰 keychain | 세션 토큰 미보유; 외부쓰기 External Action Gate(Rust+keychain). |
| 3 외부 네트워크 Rust | 세션 외부 호출 금지(escalate). |
| 4 IPC=specta | governance MCP=stdio(비대상); M6 Settings UI 신규만 specta, drift CI 0. |
| 5 bounded retry | budget snapshot=tick마다 재구성(데몬 X); 체인 유한; runWithFallback bounded. |
| 6 SQLite 마이그레이션만 | governance=별도 PGlite/event journal; app sqlite 무변경. |
| 7 시각 디자인 | M6 Settings UI=shadcn+lucide+Tailwind v4 토큰. |

검증은 **별도 critic 패스**(self-approve 금지).

---

## 7. 검증 (정본 = docs/reference/commands.md)

- governance: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run`(슬라이스마다 증가).
- app(M6만): `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` / `pnpm typecheck`+`pnpm lint`+`pnpm vitest run` / bindings drift 0 / `pnpm tauri dev` 부팅.
- 라이브 스모크는 관측 증거로("could not run" ≠ "passed"), cmux 네이티브 surface 필요 → 사용자/cmux.
- ⚠️ 이 워크트리 rtk 파이프 truncation/SHA confab 이력 → 상태 주장은 셸 등식계산(`git ls-remote`==HEAD)·범위확인으로, agent prose 신뢰 금지.

---

## 8. 분배 / 운영 노트

- **분배**: omc-teams(CLI tmux)는 cmux startup stall 이력 → **네이티브 병렬 에이전트**. 병렬 격리 주의(worktree 교차오염·executor late-writes → 커밋 전 `git status`).
- **codex 활용**: conductor가 spawn하는 codex(executor/reviewer/evaluator)는 **clean `CODEX_HOME`**(Slice 1, `457c1e9`)로 operator OMX/cmux hook hijack 회피 — 이 플랜의 모든 codex backend의 전제. 이 마스터플랜 작성용 codex consult도 동일 격리(`/tmp/boule-consult-codex-home`)로 성공.
- **2-brain**: 각 페이즈 설계 시 codex+opus consult 권장(이 플랜 자체가 그렇게 만들어짐).
- **push 정책**: 절대 자동 push 금지. dev push도 사용자 명시 요청 시에만. main=PR-only.

---

## 9. 비대상 (별도 트랙)

- 인앱 codex 잡 러너(`src-tauri/src/agent.rs`) 잔여 — 별도 트랙.
- pgvector 임베딩, 실 Postgres 서버, 장기 스케줄러/데몬 — v3 external residual 유지.
- per-step executor를 넘어선 멀티-executor 동시 분배(한 스텝 = 한 세션 유지).
- 완전 무인(plan-accept 자동) — 설계상 비채택(§0.1).
- claude 세션 OS-레벨 FS 봉쇄(이전 마스터플랜 §9.6 follow-up) — 직교, 별도.

---

## 10. codex 2-brain consult — provenance (요점 verbatim)

> clean `CODEX_HOME` 격리로 실행(hook hijack 회피), `codex-cli 0.137.0`, exit 0, 98.4k tok. 전문은 세션 로그.

- **A 구성**: 역할당 단일 resolved 체인; 난이도=head 선택(실행 X); 예산=출시 전 후보 제거(token_exhausted와 다른 이벤트); token_exhausted=런타임 전진; provider-switch-to-codex=체인 내 저비용 후보(사이드도어 X). "난이도→A, 예산→B, fallback→C는 테스트 불가 정책 스파게티."
- **B 예산**: 저널에 durable 상태(데몬 X), tick마다 BudgetSnapshot 재구성; 순수 resolver + 호출당 stateful tracker; 고정 입력 주입 테스트; 예약-후-정산; 비용 불명 ≠ 공짜.
- **C evaluator**: 래퍼 강등 + **MCP complete_task도 task_completed 쓰기 중단**(executor_reported_done); 세션 terminal 후 평가; deterministic rung은 명시 check 계약일 때만; 멱등키 taskId+sessionId+diffHash.
- **D INVARIANT #1**: §3 위험 등록부의 출처. "deterministic 일반 완료 = 이름만 그럴듯한 auto-complete."
- **E 페이징**: ①완료 권위(hint-only) ②정족수 체인(실제 provider 카운트) ③순수 resolver ④예산 ⑤난이도. "리뷰 게이트가 모델 선택보다 위험 — 선택 복잡도 전에 quorum 고정."

---

## 11. As-built (2026-06-08) — M1–M5 landed + integrated

**전부 codex executor 구현 → `gate.sh` 독립 검증 → 별도 opus critic 패스(author≠reviewer) → 로컬 커밋 → 통합 머지.** 통합 브랜치 `plan/autonomous-orchestration`(로컬, **미푸시**). 결정 정본 = `governance/docs/adr/0010-autonomous-coding-backend-selection-policy-engine.md`.

| Phase | commit | gate | critic |
| --- | --- | --- | --- |
| 마스터플랜 | `e646124` | — | — |
| **M1** 완료 권위(evaluator) | `7c3e7c3` | tsc0 / vitest 601 | ACCEPT |
| toolkit(`scripts/orchestration/`) | `172a5d9` | gate.sh self-test | — |
| **M2** 정족수 체인 | `3e3a986` | 595 | ACCEPT-W-RES, 0 blocker |
| **M3** 순수 resolver | `684f13f` | 596 | ACCEPT-W-RES → MAJOR(죽은 routing 분기) 제거 후 |
| **M4** 예산 거버넌스 | `ccb0b29` | 622 | ACCEPT, 0 blocker |
| **M5** 난이도 라우팅(typed) | `075e82a` | 634 | ACCEPT, 0 blocker |
| 통합(M1–M5) | `83b3576` | **tsc0 / vitest 634 / files 103 / drift 0** | — |
| **M6a** ADR-0010+docs | (이 커밋) | — | — |

- **병렬**: M2(`decision/`)·M3(`backends/resolve.ts`)는 독립 서브시스템이라 별도 worktree에서 동시 실행, M1·M4·M5는 직렬. 통합 머지 충돌 0(`mcp/server.ts` M1×M2는 git 3-way 자동 해소).
- **공통 codex 습관 교정**: M2·M3가 `vitest.config.ts` cacheDir를 무단 추가 → revert(이후 슬라이스 브리프에 명시 금지 → M4/M5는 미발생). M3의 untyped `as PolicyWithRouting` routing 분기 → 제거, M5에서 typed 재도입.
- **검증 베이스라인**: 590 green → +11(M1) +5(M2) +6(M3) +10(M4) +12(M5) = **634**. 전구간 app `bindings.ts`/migration drift 0.

### 11.1 Deferred (M6b + 라이브 잔여 — 사용자 greenlight 대기)
- **M6b work-radar Settings UI** (backends/routing/budget 편집) — 앱 도메인(Rust `boule_config`+React+specta bindings), 별도 관심사.
- **라이브 wiring**: resolver/budget/difficulty selection을 conductor executor-dispatch에 실제 배선 + 실 usage 기록(현재 예산 spend=input) + evaluator LLM rung(현재 deterministic `check`만) + cmux 라이브 스모크.
- **푸시**: `plan/autonomous-orchestration`은 로컬만 — 사용자 명시 요청 시에만 push.
