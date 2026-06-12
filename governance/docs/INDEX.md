# Boule — Spec & Plan 인덱스 (한 곳)

이 하네스의 **모든 설계·계획 문서를 한 곳에서** 찾는 카탈로그이자 **단일 진입점(front door)**.
**라우팅 전용** — 진행 상태·실행 큐는 `STATUS.md`(유일한 moving ledger)가 답하고,
배치·명명·정본 규칙은 `conventions.md` 정본이다. **이 파일에 상태 셀(✅/🅿️/큐)을 두지 않는다**
— 라우팅(안정)과 상태(주 단위 변동)를 한 문서에 섞은 것이 과거 INDEX가 썩은 방식이다(2026-06-12 P0).

## START HERE — 무엇을 찾는지로 라우팅

| 알고 싶은 것 | 정본 |
| --- | --- |
| **아키텍처 / as-built 전모(v3)** | `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` §7 Phase Ledger |
| **지금 상태 · 현재 실행 큐** | `STATUS.md` |
| per-feature 설계 입력 | `design/`의 개별 spec (프런트도어 아님 — 하위 입력) |
| 거버넌스 ADR | `governance/docs/adr/` — 배치=도메인, **id는 repo 전역 단일 시퀀스**(`docs/adr/README.md` 정본) |
| 결정 breadcrumb | repo-root `docs/decisions.md`(`DL-*`, 단일 로그) — `governance/docs/decisions.md`(`GDL-*`)는 2026-06-12 동결 |
| 배치·명명·정본 규칙 | `conventions.md` |
| 운영 규율(워크스페이스 행동 규칙) | `harness/HARNESS.md` (+ `harness/agents/`·`harness/interfaces/MCP.md`·`harness/orchestrator.md`) |
| 라이브 운용 런북 (오늘 손으로 켜는 법 포함) | `runbooks/2026-06-07-live-loop-smoke.md` |

- **파일 정본 = `governance/docs/`** — `design/`(설계 spec) · `plans/`(구현 plan) · `runbooks/` · `orchestration/`.
  생성 스킬이 `docs/superpowers/`에 쓴 거버넌스 산출물은 생성 직후 `git mv`(상세: `conventions.md` §1).
- **앱 운영층 boule 문서**(앱 ticker·Control Room 등 **앱 코드가 주체**인 트랙)는 앱 정본 위치
  (`docs/plans/`·`docs/superpowers/{specs,plans}/`)에 두고, 아래 카탈로그가 **교차 라우팅**한다(`conventions.md` §1).
- L3/L4 ingestion은 additive source list(`src/index/sources.ts`) — 앱·거버넌스의 ADR/결정 로그를 **둘 다** 읽는다(`conventions.md` §2).
- 런타임 상태는 per-repo **`.boule/workspace`**(이벤트 파생물 — 설계 문서가 아니다).
  구 `governance/workspace/`는 **2026-06-02 동결 레거시**(순수 이벤트 아카이브 — durable 문서는 `harness/`로 이동 완료, 2026-06-12 P5a).

## 설계 계보 (Design lineage)

| 버전 | 문서 | 요약 |
| --- | --- | --- |
| **v1** | `design/2026-05-31-ssot-governance-harness-design.md` | 5계층 SSOT(L0–L4) + 7 propose-only 에이전트 + MCP + INVARIANT 매핑. 이식 기반 설계. |
| **v2** | `design/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md` | HITL 컨트롤 플레인 + Plan→Execution→Escalation. Planner/Conductor, `decision_blocked`, autonomy envelope. 스파인이 v3로 흡수. |
| **v3** | `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` | Orchestrator Control Plane: 실행 평면(Spec/Plan/Task/Session/Handoff) + Session Registry + Orchestrator 상태머신 + Context Steward + Control Room. **단일 정본** — per-phase 설계 9개를 §7 Phase Ledger로 흡수(2026-06-04). Phase A–I 전부 랜딩(이력=STATUS). |

## 마스터플랜 · 트랙 문서 (시간순)

| 날짜 | 문서 | 한 줄 |
| --- | --- | --- |
| 06-04 | `plans/2026-06-04-governance-continuation-master-plan.md` | (SUPERSEDED 2026-06-10 — 역사 기록, 실행 금지; 배너 참조) |
| 06-07 | `design/2026-06-07-per-repo-governance-mcp-design.md` | per-repo `.boule/` 사이드카 + per-repo MCP 경계 — as-built 스키마는 ADR-0009/0010 |
| 06-07 | `design/2026-06-07-boule-tick-bounded-driver-design.md` | `boule tick` bounded 외부 박동(cron=시계, NOT 데몬) |
| 06-07 | `plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` | 라이브 자율 루프 L0–L6 + graduated `autonomyLevel` + `boule tick` |
| 06-07 | `plans/2026-06-07-configurable-backends-wiring.md` | executor/reviewer/evaluator backends 배선 RFC (06-08 마스터플랜으로 승격) |
| 06-08 | `plans/2026-06-08-autonomous-coding-master-plan.md` | Backend Selection Policy Engine — 난이도 라우팅·예산·완료권위·정족수 (ADR-0010) |
| 06-08 | `docs/plans/2026-06-08-boule-operations-layer.md` *(앱층)* | 앱 ticker 운영층 T1–T5 (T3/T4b 랜딩, T5는 06-12 플랜 P3로 승계) |
| 06-09 | `docs/superpowers/specs/2026-06-09-control-room-live-schematic-design.md` *(앱층)* | Control Room live schematic (INFRA/READINESS/lanes) |
| 06-10 | `docs/superpowers/specs/2026-06-10-ticker-scheduler-reliability-design.md` *(앱층)* | ticker heartbeat + self-heal + bounded escalation |
| 06-10 | `plans/2026-06-10-step-worktree-chaining.md` | plan 브랜치 위 step 워크트리 체이닝 |
| 06-12 | `plans/2026-06-12-boule-omc-alignment-operability-master-plan.md` | **현재 큐의 정본** — Boule×OMC 비교 진단 + 문서 정합 + 운용성 P0–P5 |

## v3 Phase → Plan 매핑 (이력/상태는 STATUS·§7 Phase Ledger)

| Phase | 슬라이스 | Plan |
| --- | --- | --- |
| A | Task lifecycle SSOT | `plans/2026-06-02-boule-v3-phase-a-task-lifecycle.md` |
| B | Plan event-sourcing + Planner | `plans/2026-06-02-boule-v3-phase-b-plan-lifecycle-planner.md` |
| B2 | Spec lifecycle | `plans/2026-06-02-boule-v3-phase-b2-spec-lifecycle.md` |
| C | Conductor + autonomy-envelope | `plans/2026-06-02-boule-v3-phase-c-conductor.md` (+ `...-phase-c-live-smoke-runbook.md`) |
| D | Session Registry + cmux Observer | `plans/2026-06-03-boule-v3-phase-d-session-registry.md` (+ `...-observer-live-adapter-fix.md`) |
| E | Orchestrator projector (observe/suggest) | `plans/2026-06-03-boule-v3-phase-e-orchestrator-projector.md` |
| F | Graph index (PGlite; pgvector deferred) | `plans/2026-06-03-boule-v3-phase-f-graph-index.md` |
| G | Context Steward / Handoff | `plans/2026-06-03-boule-v3-phase-g-context-steward-handoff.md` |
| H | Control Room UI | `plans/2026-06-03-boule-v3-phase-h-control-room-ui.md` |
| I | 좁은 opt-in auto (Type-2) | `plans/2026-06-03-boule-v3-phase-i-narrow-auto.md` |

## 초기 구현 슬라이스 (Spec ↔ Plan, 시간순)

| 날짜 | 슬라이스 | Spec | Plan |
| --- | --- | --- | --- |
| 05-31 | P1 기초 골격 (events + Gateway + MCP 골격) | — | `plans/2026-05-31-ssot-governance-harness-p1.md` |
| 05-31 | P2a 결정 거버넌스 코어 (Type1 Guardian + External Reviewer) | — | `plans/2026-05-31-ssot-governance-harness-p2a.md` |
| 05-31 | Live Reviewer (실모델 ReviewFn 배선) | `design/2026-05-31-ssot-governance-harness-live-reviewer-design.md` | `plans/2026-06-01-ssot-governance-harness-live-reviewer.md` |
| 06-01 | Review Quorum (§7 ≥2 distinct-model, fail-closed) | `design/2026-06-01-ssot-governance-harness-review-quorum-design.md` | `plans/2026-06-01-ssot-governance-harness-review-quorum.md` |
| 06-01 | P2b ask-user 카드 (인앱 Hermes 승인 카드) | `design/2026-06-01-ssot-governance-harness-p2b-askuser-card-design.md` | `plans/2026-06-01-ssot-governance-harness-p2b-askuser-card.md` |
| 06-01 | Per-model Reviewer CMD (모델별 reviewer override) | `design/2026-06-01-ssot-governance-harness-per-model-reviewer-cmd-design.md` | — |
| 06-01 | Approval finding / dev-DB skew (ADR-0007 배경) | `design/2026-06-01-ssot-governance-harness-approval-finding-devdb-skew-design.md` | — |
| 06-01 | Escalation round-trip Slice 1 (Type 0 `decision_blocked` + `choose`) | `design/2026-06-01-ssot-governance-harness-escalation-roundtrip-slice1.md` | `plans/2026-06-01-ssot-governance-harness-escalation-roundtrip-slice1a.md` |
| 06-02 | Escalation round-trip Slice 1B (Python `~/.hermes` 브릿지 sync-once) | (위 spec addendum) | `plans/2026-06-02-ssot-governance-harness-escalation-roundtrip-slice1b.md` |
| 06-01 | Decision Ingress (P3 Slice 1 — ADR/decisions 인메모리 파서) | `design/2026-06-01-ssot-governance-harness-decision-ingress-design.md` | `plans/2026-06-01-ssot-governance-harness-decision-ingress.md` |
| 06-01 | L0 Harvest (P3 Slice 2a — content-addressed 멱등 harvest) | `design/2026-06-01-ssot-governance-harness-l0-harvest-design.md` | `plans/2026-06-01-ssot-governance-harness-l0-harvest.md` |
| 06-02 | Pattern Detector L0→L1 (인메모리 유사도 후보 패턴) | `design/2026-06-02-pattern-detector-l0-l1-design.md` | `plans/2026-06-02-pattern-detector-l0-l1.md` |
| 06-04 | P4 Hypothesis Tester / P5 Meta Observer / P6 Archive Pruner (Slice 1) | — | `plans/2026-06-04-ssot-governance-harness-p4-hypothesis-tester.md` · `...p5-meta-observer.md` · `...p6-archive-pruner.md` |
| 06-02 | B1 ↔ v2 planner 비교 근거 | `design/2026-06-02-b1-vs-v2planner-spec-plan-reconciliation.md` | — |
