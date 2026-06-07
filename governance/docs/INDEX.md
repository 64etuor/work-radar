# Boule — Spec & Plan 인덱스 (한 곳)

이 하네스의 **모든 설계·계획 문서를 한 곳에서** 찾는 카탈로그이자 **단일 진입점(front door)**.
배치·명명·정본 규칙은 `conventions.md` 정본 — 이 파일에 중복하지 않는다.

## START HERE — 무엇을 찾는지로 라우팅

| 알고 싶은 것 | 정본 |
| --- | --- |
| **아키텍처 / as-built 전모(v3)** | `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` §7 Phase Ledger |
| **라이브-자율 실행 큐(현재 진행)** | `plans/2026-06-07-boule-v3-live-autonomy-master-plan.md` |
| per-feature 설계 입력 | `design/`의 개별 spec (프런트도어 아님 — 하위 입력) |
| 거버넌스 ADR | `governance/docs/adr/` (0007–; 앱 ADR은 `docs/adr/` 0001–0006) |
| 거버넌스 결정 로그 | `governance/docs/decisions.md` (`GDL-*`; 과거/앱 로그는 `docs/decisions.md` `DL-*`) |
| 배치·명명·정본 규칙 | `conventions.md` |

> 마스터 플랜은 **움직이는 실행 큐**이지 프런트도어가 아니다. v3 control-plane 설계는
> **아키텍처 정본**이지 라우팅 소유가 아니다. 둘 다 위 표(이 INDEX)가 라우팅한다.

- **파일 정본 = `governance/docs/`** — `design/`(설계 spec) · `plans/`(구현 plan) · `runbooks/` · `orchestration/`.
- **거버넌스 설계/계획 문서는 모두 여기에 둔다.** brainstorming/writing-plans 스킬은 기본
  `docs/superpowers/`에 쓰므로, 거버넌스 산출물은 생성 후 `governance/docs/{design,plans}/`로
  `git mv`한다(옮기기 전엔 미정본; 앱-기능 문서는 `docs/superpowers/`에 그대로). 상세: `conventions.md` §1.
- L3/L4 ingestion은 **additive source list**(`src/index/sources.ts`)다 — 인덱스가 앱(`docs/adr/`·`docs/decisions.md`)과 거버넌스(`governance/docs/adr/`·`governance/docs/decisions.md`)를 **둘 다** 읽는다. `decision-rails.md`는 repo 전역 잔류. 상세: `conventions.md` §2.
- 런타임 객체(`workspace/specs|plans|tasks|…`)는 이 설계 문서가 아니라 **이벤트 파생물**이다(다른 층).
- 운영 규율: `../workspace/HARNESS.md`.

상태 범례: ✅ 구축·머지(브랜치 내) · 🅿️ parked 설계(미착수) · 🆕 이번 세션 신규.

## 설계 계보 (Design lineage)

| 버전 | 문서 | 요약 | 상태 |
| --- | --- | --- | --- |
| **v1** | `design/2026-05-31-ssot-governance-harness-design.md` | 5계층 SSOT(L0–L4) + 7 propose-only 에이전트 + MCP + INVARIANT 매핑. 이식 기반 설계. | ✅ 기반 |
| **v2** | `design/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md` | HITL 컨트롤 플레인 + Plan→Execution→Escalation. Planner/Conductor, `decision_blocked`, autonomy envelope, two-surface HITL. | 🅿️ 설계(스파인 일부 구축) |
| **v3** | `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` | Orchestrator Control Plane: 실행 평면(Spec/Plan/Task/Session/Handoff) + Session Registry + Orchestrator 상태머신 + Context Steward + Control Room. **단일 정본** — per-phase 설계 9개를 §7 Phase Ledger로 흡수(2026-06-04). A–H Slice 1 dev 랜딩, I parked. | ✅ on dev (단일 참조) |

## 구현 슬라이스 (Spec ↔ Plan 쌍, 시간순)

| 날짜 | 슬라이스 | Spec | Plan | 상태 |
| --- | --- | --- | --- | --- |
| 05-31 | **P1 기초 골격** (events + Gateway + MCP 골격) | — | `plans/2026-05-31-ssot-governance-harness-p1.md` | ✅ |
| 05-31 | **P2a 결정 거버넌스 코어** (Type1 Guardian + External Reviewer) | — | `plans/2026-05-31-ssot-governance-harness-p2a.md` | ✅ |
| 05-31 | **Live Reviewer** (실모델 ReviewFn 배선) | `design/2026-05-31-ssot-governance-harness-live-reviewer-design.md` | `plans/2026-06-01-ssot-governance-harness-live-reviewer.md` | ✅ |
| 06-01 | **Review Quorum** (§7 ≥2 distinct-model, fail-closed) | `design/2026-06-01-ssot-governance-harness-review-quorum-design.md` | `plans/2026-06-01-ssot-governance-harness-review-quorum.md` | ✅ |
| 06-01 | **P2b ask-user 카드** (인앱 Hermes 승인 카드) | `design/2026-06-01-ssot-governance-harness-p2b-askuser-card-design.md` | `plans/2026-06-01-ssot-governance-harness-p2b-askuser-card.md` | ✅ |
| 06-01 | **Per-model Reviewer CMD** (모델별 reviewer override) | `design/2026-06-01-ssot-governance-harness-per-model-reviewer-cmd-design.md` | — | ✅ |
| 06-01 | **Approval finding / dev-DB skew** (ADR-0007 배경 + dev DB override) | `design/2026-06-01-ssot-governance-harness-approval-finding-devdb-skew-design.md` | — | ✅ |
| 06-01 | **Escalation round-trip Slice 1** (Type 0 `decision_blocked` + `choose`) | `design/2026-06-01-ssot-governance-harness-escalation-roundtrip-slice1.md` | `plans/2026-06-01-ssot-governance-harness-escalation-roundtrip-slice1a.md` (TS half) | ✅ |
| 06-02 | **Escalation round-trip Slice 1B** (Python `~/.hermes` 브릿지 sync-once) | (위 스펙 addendum) | `plans/2026-06-02-ssot-governance-harness-escalation-roundtrip-slice1b.md` | ✅ |
| 06-01 | **Decision Ingress** (P3 Slice 1 — ADR/decisions 인메모리 파서) | `design/2026-06-01-ssot-governance-harness-decision-ingress-design.md` | `plans/2026-06-01-ssot-governance-harness-decision-ingress.md` | ✅ |
| 06-01 | **L0 Harvest** (P3 Slice 2a — content-addressed 멱등 harvest) | `design/2026-06-01-ssot-governance-harness-l0-harvest-design.md` | `plans/2026-06-01-ssot-governance-harness-l0-harvest.md` | ✅ |
| 06-02 | **Pattern Detector L0→L1** (인메모리 유사도 후보 패턴) | `design/2026-06-02-pattern-detector-l0-l1-design.md` | `plans/2026-06-02-pattern-detector-l0-l1.md` | ✅ |
| 06-03 | **Phase G Context Steward / Handoff** (handoff 축 + 순수 pressure + hydration) | v3 마스터 §7 (Phase G) | `plans/2026-06-03-boule-v3-phase-g-context-steward-handoff.md` | ✅ |

## v3 마스터 Phase (A–H Slice 1 ✅ on dev / I 설계·parked)

**정본 = 단일 문서:** `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md`
— per-phase 설계 9개를 **§7 Phase Ledger로 흡수**(2026-06-04 통합, 삭제분은 git 히스토리). 각 Phase의 상세 as-built
설계는 마스터 §7, 상세 구현 플랜만 `plans/`에 별도. 진행: **A–H Slice 1 = dev 랜딩(`2a5a9db`)**(전부 opus
critic ACCEPT). **I = 설계+plan(critic ACCEPT)·구현 PARKED**(빌드는 명시적 build-it 후에만).

| Phase | 슬라이스 | 상태 | Plan |
| --- | --- | --- | --- |
| **A** | Task lifecycle SSOT | ✅ on dev | `plans/2026-06-02-boule-v3-phase-a-task-lifecycle.md` |
| **B** | Plan event-sourcing + Planner | ✅ on dev | `plans/2026-06-02-boule-v3-phase-b-plan-lifecycle-planner.md` |
| **B2** | Spec lifecycle | ✅ on dev | `plans/2026-06-02-boule-v3-phase-b2-spec-lifecycle.md` |
| **C** | Conductor + autonomy-envelope | ✅ on dev | `plans/2026-06-02-boule-v3-phase-c-conductor.md` (+ `...-phase-c-live-smoke-runbook.md`) |
| **D** | Session Registry + cmux Observer | ✅ on dev | `plans/2026-06-03-boule-v3-phase-d-session-registry.md` (+ `...-observer-live-adapter-fix.md`) |
| **E** | Orchestrator projector (observe/suggest) | ✅ on dev | `plans/2026-06-03-boule-v3-phase-e-orchestrator-projector.md` |
| **F** | Graph index (PGlite; events+nodes+edges) | ✅ on dev (pgvector deferred) | `plans/2026-06-03-boule-v3-phase-f-graph-index.md` |
| **G** | Context Steward / Handoff | ✅ on dev (vitest 418) | `plans/2026-06-03-boule-v3-phase-g-context-steward-handoff.md` |
| **H** | Control Room UI (Slice 1) | ✅ Slice 1 on dev (라이브 GUI smoke 잔여) | `plans/2026-06-03-boule-v3-phase-h-control-room-ui.md` |
| **I** | 좁은 opt-in auto (Type-2) | ✅ Slice 1 DONE locally: `auto_dispatch`/`dispatch_log`, 4 dispatch events, impl-critic ACCEPT 0 blockers (`.omx/artifacts/claude-boule-phase-i-critic-20260604T054201Z.md`), governance `tsc --noEmit` 0 + vitest 441, bindings/migrations drift 0. Live cmux smoke remains user-run. | `plans/2026-06-03-boule-v3-phase-i-narrow-auto.md` |

## v1 잔여 (v3 critical path와 독립 — 언제든 마감 가능)

| 항목 | 에이전트 | 상태 |
| --- | --- | --- |
| P4 가설 검증 | Hypothesis Tester | ✅ Slice 1 DONE locally: deterministic markdown loop, 24 hypotheses proposed then 24 refuted in `workspace/hypotheses/testing` against currently empty/unharvested L0 corpus; synthetic integration covers verified path. governance `tsc --noEmit` 0 + vitest 451. Critic ACCEPT-with-minors 0 blockers. |
| P4 Slice 1 계획 | Hypothesis Tester markdown loop | ✅ executed: `plans/2026-06-04-ssot-governance-harness-p4-hypothesis-tester.md` |
| P5 메타 관찰 | Meta Observer | ✅ Slice 1 DONE locally: pure `meta_observe` proposal-draft renderer + MCP surface; governance `tsc --noEmit` 0 + vitest 456, bindings/migrations drift 0. Current workspace has no verified hypotheses, so live result is `hasProposal:false`; synthetic tests cover verified draft path and same-scope grouping. PR/human approval remains external residual. Critic ACCEPT-with-minors 0 blockers; grouping minor addressed before commit. Plan: `plans/2026-06-04-ssot-governance-harness-p5-meta-observer.md` |
| P6 망각·정합성 | Archive Pruner | ✅ Slice 1 DONE locally: hypothesis-only `archive_prune`/`archive_status`; actual workspace pass moved 24 terminal hypotheses from testing→archived. governance `tsc --noEmit` 0 + vitest 462, bindings/migrations drift 0. Pattern/event stale policy and scheduling deferred. Critic ACCEPT-with-minors 0 blockers; `access` nit addressed before commit. Plan: `plans/2026-06-04-ssot-governance-harness-p6-archive-pruner.md` |
| P3 Postgres/pgvector | (인덱스) | ✅ v3 Phase F first cut DONE (events+nodes+edges, PGlite; pgvector 임베딩만 잔여) |

## 다음 실행 큐 (Continuation Master Plan)

정본 plan: `plans/2026-06-04-governance-continuation-master-plan.md`.

순서대로 진행한다. 각 slice 후 full verification, critic/code-review, checkpoint commit을 끝내고
이 INDEX를 다시 읽은 뒤 다음 local-implementable slice로 계속 간다. live cmux/gui, user credential,
human-approved PR, push/merge/delete/deploy가 필요한 작업은 external residual로 기록하고 다음 로컬 slice로 이동한다.

| 순서 | Slice | 실행 가능성 | 상태 |
| --- | --- | --- | --- |
| 1 | P6 Slice 2 — stale pattern/event policy | local | 🆕 next |
| 2 | P5 Slice 2 — Meta Observer draft hardening | local | 🆕 queued |
| 3 | Phase F follow-up — PGlite incremental graph upsert | local, higher blast radius | 🆕 queued |
| 4 | Phase I/H live smoke preflight + runbook hardening | local preflight only | 🆕 queued |
| external | P5 human PR, live cmux/GUI smoke, real Postgres/keyring, pgvector, long-running schedule | needs user/live surface | external residual |

## 최근 거버넌스 설계 spec (2026-06-07, `design/`로 통합)

이전에 `docs/superpowers/specs/`·`governance/docs/` 루트에 흩어져 있던 거버넌스 설계 문서를
`governance/docs/design/`로 모음(2026-06-07 문서 정합성 패스; 정본 규칙 = `conventions.md`).

| 문서 | 요약 |
| --- | --- |
| `design/2026-06-07-per-repo-governance-mcp-design.md` | per-repo `.boule/` 사이드카 + per-repo MCP 운영 경계(work=strict/personal=loose). |
| `design/2026-06-07-boule-tick-bounded-driver-design.md` | `boule tick` bounded 외부 박동 드라이버(cron=시계, NOT 데몬). master plan §9.5.2 / 위 큐. |
| `design/2026-06-02-b1-vs-v2planner-spec-plan-reconciliation.md` | B1(`feat/governance-boule-p1`) ↔ v2 planner spec/plan 비교 근거. |
