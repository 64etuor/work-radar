# Boule — Spec & Plan 인덱스 (한 곳)

이 하네스의 **모든 설계·계획 문서를 한 곳에서** 찾는 카탈로그이자 단일 진입점.

- **파일 정본 = `governance/docs/`** — `design/`(설계 spec) · `plans/`(구현 plan).
- **앞으로 거버넌스 설계/계획 문서는 모두 여기에 둔다.** brainstorming/writing-plans 스킬은
  기본 `docs/superpowers/`에 쓰므로, 거버넌스 산출물은 생성 후 `governance/docs/{design,plans}/`로
  옮긴다(앱-기능 문서는 `docs/superpowers/`에 그대로).
- L3/L4 정본(adr·decisions·decision-rails)은 `docs/`에 둔다(어댑터가 경로로 읽음 — 이동 금지).
- 런타임 객체(`workspace/specs|plans|tasks|…`)는 이 설계 문서가 아니라 **이벤트 파생물**이다(다른 층).
- 운영 규율: `../workspace/HARNESS.md`.

상태 범례: ✅ 구축·머지(브랜치 내) · 🅿️ parked 설계(미착수) · 🆕 이번 세션 신규.

## 설계 계보 (Design lineage)

| 버전 | 문서 | 요약 | 상태 |
| --- | --- | --- | --- |
| **v1** | `design/2026-05-31-ssot-governance-harness-design.md` | 5계층 SSOT(L0–L4) + 7 propose-only 에이전트 + MCP + INVARIANT 매핑. 이식 기반 설계. | ✅ 기반 |
| **v2** | `design/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md` | HITL 컨트롤 플레인 + Plan→Execution→Escalation. Planner/Conductor, `decision_blocked`, autonomy envelope, two-surface HITL. | 🅿️ 설계(스파인 일부 구축) |
| **v3** | `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` | Orchestrator Control Plane: 실행 평면(Spec/Plan/Task/Session/Handoff) + Session Registry + Orchestrator 상태머신 + Context Steward + Control Room. 마스터 Phase A–I. | 🆕 설계 |

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

## v3 마스터 Phase (계획 예정 — 각 Phase는 자체 spec+plan)

정본: `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` §10.

| Phase | 슬라이스 | Depends-on | Spec/Plan |
| --- | --- | --- | --- |
| **A** | Task lifecycle SSOT (fold+가드+projector+property test) | BUILT substrate | `plans/2026-06-02-boule-v3-phase-a-task-lifecycle.md` ✅ DONE (critic ACCEPT) |
| **B** | Spec/Plan event-sourcing + Planner | A | (예정) |
| **C** | Conductor + autonomy-envelope (cmux spawn) | B + escalation spine | (예정) |
| **D** | Session Registry + cmux Observer | C | (예정) |
| **E** | Orchestrator projector (observe/suggest) | A,B,C,D | (예정) |
| **F** | Postgres+pgvector 그래프 인덱스 | E | (예정) |
| **G** | Context Steward / Handoff | E | (예정) |
| **H** | Control Room UI (specta) | E,F,G | (예정) |
| **I** | 좁은 opt-in auto (Type-2만) | E,G + envelope(C) | (예정) |

## v1 잔여 (v3 critical path와 독립 — 언제든 마감 가능)

| 항목 | 에이전트 | 상태 |
| --- | --- | --- |
| P4 가설 검증 | Hypothesis Tester | ❌ 미구축 |
| P5 메타 관찰 | Meta Observer | ❌ 미구축 |
| P6 망각·정합성 | Archive Pruner | ❌ 미구축 |
| P3 Postgres/pgvector | (인덱스) | ⏸ 의도적 연기 → v3 Phase F |
