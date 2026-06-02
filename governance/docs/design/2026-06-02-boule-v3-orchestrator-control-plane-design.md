# SSOT Governance Harness — Boule v3: Orchestrator Control Plane (architecture design)

- **Date**: 2026-06-02
- **Status**: design (architecture agreed; master plan + per-phase forks below) — pre-plan, parked
- **Branch**: `feat/governance-boule-p1` (PARKED, unpushed — commit only, never push without explicit request)
- **Parent designs**:
  - `governance/docs/design/2026-05-31-ssot-governance-harness-design.md` (v1 — 5-layer SSOT, 7 agents, MCP, INVARIANTs)
  - `governance/docs/design/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md` (v2 — HITL control plane, Planner/Conductor, escalation, autonomy envelope)
- **Provenance**: synthesized from a **two-model architecture consult run this session** — `codex exec` (codex-cli 0.135.0) + an opus architect agent — both grounded by reading the real code (`deriveDecisionState`, `canApprove`/`approve`, `chooseOption`, `buildIndex`, the `EventType` union, the current `governance/workspace/` layout) and the v1/v2 designs. They converged tightly on the spine; their divergences and the user's resolutions are recorded inline. Consult brief: `/tmp/boule-v3-consult/brief.md` (ephemeral).

> Working name **Boule** (아테네 평의회). 이름은 bikeshed — 자유 변경.

---

## 0. Problem & Framing

사용자는 Boule를 **SSOT Event-Sourced Multi-Agent Orchestration Control Plane**으로 확장하길
원한다: 여러 에이전트/세션을 관찰하고, 작업을 **분해·배정·이어받기·검증·승인·망각**까지
수행하는 자기 관찰형 운영 시스템. v1(5계층 SSOT)과 v2(HITL + Plan→Execution→Escalation)
위에 **네 가지 레이어**를 더한다:

1. **Spec / Plan / Task** — 무엇을·어떻게·어떤 단위로 할지 (실행 계획의 정본).
2. **Session / Agent Runtime** — cmux/Hermes 런타임을 관찰 가능한 SSOT 객체로.
3. **Orchestrator 상태 머신** — Observe→Project→Evaluate→Decide→Act→Learn 루프.
4. **Context Handoff / Continuity** — context 포화 시 안전한 checkpoint→handoff→재개.

여기에 Control Room UI(6 패널), Postgres+pgvector 인덱스/그래프, 확장 이벤트/MCP 명령셋,
강한 경로-권한 모델, 장애 복구 플로우가 따라온다.

### 0.1 가장 중요한 아키텍처 선택 (사용자 정본)

> **상태를 runtime에 묻지 않는다. 상태를 SSOT(append-only events)에 적고, runtime은 관찰해서 보정한다.**
> **긴 context를 유지하려 하지 않는다. handoff artifact를 만들어 세션을 갈아탄다.**
> **중앙 오케스트레이터가 모든 걸 결정하지 않는다. 로컬 agent · 상태 머신 · policy · human approval이 함께 진화한다.**

### 0.2 Settled Decisions (이 세션에서 사용자 확정 — 재론 금지)

1. **v2 위에 additive layering** — v2의 escalation spine + (예정된) Planner/Conductor를
   실행 substrate로 두고, v3는 Session Registry / Orchestrator projection / Context
   Steward / Control Room을 그 위에 올린다.
2. **Postgres + pgvector — 스키마/재구축 계약은 _지금_ 확정, 서버 stand-up은 Phase F**
   (cross-session 그래프 쿼리가 실제로 필요한 시점). Phase A는 인메모리 fold만. pgvector 최후.
   _(두 모델이 독립적으로 "Phase A는 Postgres 의존 금지"를 권고 → 사용자 수용.)_
3. **Control Room UI = work-radar 인앱 Tauri/shadcn 뷰** (specta IPC, 앱 셸 재사용). **Phase H — 최후.**
4. **첫 상세 슬라이스 = Spec/Plan/Task SSOT 중 Task lifecycle (Phase A)**; 나머지는 마스터 플랜의 순차 Phase.
5. **Planner = Phase B, Conductor = Phase C — 각자 별도 Phase로 먼저 구축**(critic ACCEPT)
   하고, 멀티-모듈 Orchestrator(Phase E)는 그 _뒤_. _(아키텍트 교정: Conductor는 미구축 — 디스패처가 없는데 Scheduler/Session Manager를 올리지 않는다.)_

---

## 1. Prerequisites & v2 Relationship — "v2 완성"이 별도 선행조건인가?

**아니다.** v2의 _미구축_ 부분이 곧 이 v3 플랜의 초기 Phase다. 의존성은 all-or-nothing이
아니라 **Phase별**이다.

| 구분                        | 항목                                                                                                                                   | 상태                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **BUILT (substrate)**       | L0–L4 SSOT, 7 propose-only 에이전트, Governance MCP, L0 harvest, Pattern Detector(인메모리), review quorum, `deriveDecisionState` fold | ✅                         |
| **BUILT (v2 spine)**        | escalation round-trip: `escalate`/`choose`, `decision_blocked` 이벤트 타입, Boule↔Telegram 브릿지(sync-once)                           | ✅                         |
| **v2 DESIGN-ONLY (미구축)** | Planner(intent→`plan_proposed`), Conductor(cmux 디스패처), autonomy-envelope, cmux 세션 spawn                                          | ❌ → **이 플랜 Phase B/C** |

따라서:

- **Phase A는 BUILT substrate에만 의존** — 이벤트 스토어 + fold + MCP + 이미 구축된
  `decision_blocked`(`canComplete`가 검사). **미구축 v2에 의존하지 않음 → 즉시 착수 가능.**
- **"v2를 완성한다" = 이 플랜의 Phase B(Planner) + Phase C(Conductor)를 실행한다**는 뜻.
  별도 선행 트랙이 아니다.
- 디스패처를 실제로 소비하는 Phase(E 이후)만 B/C 뒤로 정렬. 이것이 Planner/Conductor를
  먼저 별도 Phase로 두는 이유.

각 Phase의 **Depends-on**은 §10 마스터 시퀀스 표에 명시.

---

## 2. The Two Axes — Execution Plane is Orthogonal to the Epistemic Ladder

(consult Q1 — codex + opus 합의)

Boule는 이제 **하나의 append-only L0 이벤트 스토어 위에 두 개의 직교 축**을 갖는다.

- **인식론적 사다리 (L0–L4)** — _프로젝트가 무엇을 참이라 믿는가_. (v1 그대로, 변경 없음)
  - L0 events → L1 patterns → L2 hypotheses → L3 decisions → L4 principles.
- **실행 평면 (Spec → Plan → Task → Session → Handoff)** — _지금 어떤 작업이 흐르고 있는가_. (신규)
  - 같은 L0 스토어에 라이딩. **verdict 권위를 일절 갖지 않는다.**

핵심 모델 (정본 문장):

> **Decision은 의도를 추구할 *권한*을 부여한다. Plan은 그 의도를 *분해*한다.**
> **Task는 그 분해를 *실행*한다. 이벤트만이 유일한 가변 진실(mutable truth)이다.**

### 2.1 왜 이것이 v2의 "Plan은 새 레이어가 아니다"와 정합한가

v2의 규칙은 *저장 구조*가 아니라 ***권위***에 관한 것이었다 — Plan이 무언가를 "승인"할 수
있게 되면 그것이 곧 결정 레일 침투(INVARIANT #1 위반)다. 실행 평면을 **권위 없는 직교 축**으로
두면 그 제약이 그대로 보존된다: Task 전이 이벤트는 verdict를 만들지 못한다(코드상
`approve()`/`reject()`/`choose()`만 verdict를 minting하며 전부 `actor:"user"` 하드핀).

- **Task는 새 인식론적 레이어가 아니다.** L0–L4와 직교하는 **실행 단위**다.
- **Plan은 권위가 아니라 분해다.** Plan의 권위는 오직 승인된 `dec_*`에서 온다.
- **Spec 본문은 사람이 저술**(ADR 본문과 동일 성격) — 산문을 event-source 하지 않는다.
  Spec의 _lifecycle_(`spec_drafted`→`spec_accepted`)만 이벤트.

### 2.2 The keystone invariant — 상태는 파생물이다 (절대 손으로 안 고친다)

> **Task의 경로 segment / frontmatter의 `status:`는 DERIVED다. 이벤트 fold를 읽는 projector만
> 그것을 쓴다. 어떤 명령·에이전트·사람도 `status:`를 직접 편집하지 않는다. `tasks/`를 통째로
> 지워도 projector 재실행이 bit-for-bit 재구성한다.**

이것이 v3에서 가장 먼저 썩는 지점이므로 **순수성 property test로 강제**(§7 Phase A). 렌더된 문서는
`GENERATED — do not edit` 마커를 달고, 유혹 제거를 위해 `tasks/` 등 파생 디렉토리는
**L0-harvest처럼 gitignore 고려**.

---

## 3. Domain Model — Spec / Plan / Task / Session / Handoff

전부 YAML frontmatter + Markdown 본문(문서 §2.2 형식). **단 frontmatter의 lifecycle 필드는
파생** — 식별/내용은 생성 이벤트로, 상태는 fold로. (v1 §2.1 형식 재사용)

| 객체        | 의미             | 정본(쓰기 진실)                                       | 파생(렌더)                  | 권위                 |
| ----------- | ---------------- | ----------------------------------------------------- | --------------------------- | -------------------- |
| **Spec**    | 무엇을 만들지    | 본문=사람 저술 + lifecycle 이벤트                     | `specs/<status>/` 경로      | 없음 (의도 기술)     |
| **Plan**    | 어떻게 분해      | `plan_proposed`/`plan_revised`/`plan_accepted` 이벤트 | 최신 non-superseded 투영    | 없음 (sequencing만)  |
| **Task**    | 실행 단위        | `task_*` lifecycle 이벤트                             | `tasks/<status>/<id>.md`    | 없음 (실행만)        |
| **Session** | 런타임 관찰 객체 | `session_*` 이벤트                                    | `sessions/<status>/<id>.md` | 없음 (관찰/디스패치) |
| **Handoff** | 연속성 계약      | `handoff_*` 이벤트                                    | `handoffs/<status>/<id>.md` | 없음 (continuity)    |

> **참고:** `governance/workspace/`에는 현재 events/patterns/hypotheses/state/reviews/agents/
> interfaces만 있다. specs/plans/tasks/sessions/handoffs는 **전부 신규**(아키텍트 확인).

### 3.1 Plan = 최신 non-superseded 투영 (v2 그대로)

Plan의 "현재 모습"은 편집된 파일이 아니라 **최신 non-superseded `plan_*` 이벤트들의 투영**이다.
`plan_revised`가 이전 plan id를 supersede(텔레그램 토픽 정리가 이미 쓰는 패턴). Plan은
그 step들이 가리키는 결정 이벤트들로부터 **완전 파생**(reference-graph 기계 재사용).
**Plan은 아무것도 승인하지 않는다.** Plan 채택(execution spawn / 방향 변경 시)은 사람 게이트
(`plan_accepted`, `actor:"user"`).

---

## 4. Orchestrator — 승인 불가능하도록 by-construction

(consult Q2 — 최고 위험 영역; codex + opus 합의)

오케스트레이터는 **또 하나의 propose-only 에이전트**다. 신규 쓰기 권한은 단 하나 —
verdict를 갖지 않는 `task_*`/`session_*` lifecycle 이벤트 — 뿐이며, `approve`/`choose`/
`decision_*` write-path는 **0**이다.

### 4.1 9개 모듈 × 쓰기 권한

| 모듈                                            | 쓸 수 있음                                               | 절대 못 씀                                            |
| ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Event Reader · State Projector · Audit Writer   | 파생 투영 / `state/` 캐시                                | 어떤 L0 verdict                                       |
| Policy Evaluator · Context Steward              | `suggestion`-class 이벤트(자문)                          | verdict · task 전진                                   |
| Scheduler · Session Manager · Action Dispatcher | `session_*` + `task_started`/`task_blocked`(envelope 내) | 관찰 안 한 작업의 `task_completed`; 모든 `decision_*` |
| Safety Gate                                     | (없음 — _거부_ 함수)                                     | (승인 불가; `canApprove` 미러 — block만)              |

### 4.2 사람 게이트 (불변)

- Type 1 결정 승인 · L4(principle) 변경 · scope/risk/권한/결정 의미를 바꾸는 plan 채택 ·
  **observe/suggest → auto 승격** · autonomy-envelope 경계 변경 · 파괴적/외부-프로덕션/
  자격증명/광범위 쓰기.

### 4.3 "auto" 모드가 무인으로 할 수 있는 것 = 의도적으로 빈약(anemic)

- 가능: 이벤트 읽기 · 투영/인덱스 재구축 · **이미 사람-승인된** plan step의 bounded 세션 spawn ·
  가드 통과한 **non-decision Type-2** task 전이 · 관찰/제안/blocked/audit 이벤트 방출 · bounded recovery retry.
- 절대 불가: 결정 승인 · **timeout/default로 승인 추론** · scope 확장 · L4 변경 · Type-1 accepted 마킹 ·
  ambiguity의 무성(silent) 실행 전환.

> **정직한 트레이드오프(아키텍트):** _지연(latency)이 곧 기능이다._ blocked 결정은 사람이 올 때까지
> 무기한 대기. 모든 안전 완화가 "auto"를 더 느리고 좁게 만든다. 높은 자율성과 구조적 보장을
> 동시에 주는 설계는 없다 — **빈약한 auto를 채택**한다.

### 4.4 실패 모드 → 구조적 완화

1. **Scheduler/Conductor가 timeout-default로 사실상 결정자가 됨** ← 최대 위험.
   → `decision_blocked`는 **auto-resolution도 timeout-default도 없음. 영원히 halt.**
   세션을 bound(kill/checkpoint)하되 **결정을 bound하지 않는다.** *negative test*로 강제:
   `approve`/`reject`/`choose` 외 어떤 경로도 `decision_*`를 `actor!=user`로 쓰지 못함.
2. **분류 드리프트** (Type-1을 Type-2로 라벨링해 전진). → 분류 자체가 escalation; auto는 화이트리스트로
   Type-2 증명 가능한 것만 전진, 모호하면 보수적으로 `decision_blocked`. Guardian이 재분류(사람 게이트).
3. **"auto" 모드가 게이트 전역 무력화.** → 게이트 함수에 mode 파라미터 **없음**(`canApprove`는 순수
   함수, 현 코드 확인). "auto"는 _task dispatch_ 속성이지 _decision approval_ 속성이 아니며 둘은 공유 플래그 없는 별개 코드.
4. **projector가 "파생"으로 verdict를 minting.** → projection은 이벤트에 대한 total 함수, I/O·이벤트 방출 0.
   **이벤트를 방출하는 projector = 아키텍처 냄새 → 리뷰 실패.**
5. **Context Steward가 미해결 ambiguity를 요약으로 세탁.** → handoff는 미해결 blocker + autonomy
   envelope을 **보존**해야 하며, hydration이 권한을 **확장하지 못함**.

### 4.5 명령 표면 분리

`propose_*` ↔ `approve_*`를 API 레벨에서 분리. `approve_*`는 `actor:"user"` 하드핀 + `canApprove`
검사. Scheduler는 **승인된** plan/task authority만 소비. **승인 엔드포인트는 에이전트 MCP stdio에 미노출.**
모든 액션은 `actor`/`authority_decision_id`/`task_id`/`session_id`를 기록. Safety Gate는
deny-by-default이며 `action_denied` 방출.

### 4.6 새 결정 레일 (Meta-Observer PR 게이트 경유)

`decision-rails.md`에 추가 주장: _오케스트레이터/conductor/scheduler 모듈은 어떤 `decision\__`이벤트에도 write-path가 없다; Type-1 경계를 만난 spawn 세션은 반드시`decision_blocked`를 방출하고
halt하며 self-resolve 금지.* 절차적 레일은 썩는다 → §4.4#1의 *negative test\*가 진짜 가드.

---

## 5. Storage Layout (v1 사이드카에 실행 평면 추가)

```
governance/workspace/
  events/  patterns/  hypotheses/  reviews/  state/  agents/  interfaces/   # 기존
  specs/      proposed/ active/ accepted/ archived/    # 신규 — 본문=저술, lifecycle=파생
  plans/      proposed/ active/ done/ archived/        # 신규 — 투영(최신 non-superseded)
  tasks/      ready/ active/ blocked/ review/ done/ archived/   # 신규 — GENERATED, gitignore 고려
  sessions/   active/ waiting/ blocked/ checkpointing/ handoff_ready/ closed/ crashed/  # 신규(Phase D)
  handoffs/   pending/ consumed/ archived/             # 신규(Phase G)
  orchestrator/  policies.md state-machines.md routing.md safety-rails.md session-templates/  # 신규(Phase E)
```

L3/L4는 v1대로 어댑터(adr/decisions.md/decision-rails)를 재사용 — 복제 안 함.
**쓰기는 항상 markdown(events) 먼저, 인덱스/투영은 파생(비동기).** 손상 시 markdown에서 완전 재구축.

---

## 6. Postgres + pgvector — 파생 인덱스 (정본 아님)

(consult Q3 — 스키마/계약 지금 확정, 서버 Phase F)

**모든 테이블은 markdown에서 `TRUNCATE; fold(events)`로 재구축 가능한 파생 캐시.** 정본은 아니다.

```
events(event_id PK, content_hash, event_type, occurred_at, actor,
       subject_type, subject_id, authority_decision_id, markdown_path, payload_jsonb)  -- L0와 1:1
nodes(node_id PK, node_type ENUM(decision|task|plan|session|spec|handoff|pattern|hypothesis),
       canonical_id, title, state_jsonb, embedding vector)                            -- 투영
edges(edge_id, from_node_id, to_node_id, edge_type ENUM(related_to|supersedes|refs|blocks|step_of),
       source_event_id)                                                               -- 참조 그래프
session_observations(observation_id, session_id, task_id, event_id, summary, payload_jsonb)
approvals(approval_id, decision_id, actor, approved_at, source_event_id, scope_jsonb)  -- actor 반드시 'user'
```

- **멱등 ingest:** markdown 스캔 → frontmatter+본문 파싱 → content_hash 계산 → `event_id` upsert + hash 검증
  (L0 harvest가 이미 content-addressed·멱등; run1 written→run2 0 실증). 동일 hash = no-op.
- **재구축:** 파생 테이블 truncate → 이벤트 결정적 순서 fold → nodes/edges/approvals 재생성 →
  (가능 시) 임베딩 재생성 → **투영 checksum을 markdown-렌더 투영 파일과 비교.**
- **불변 주장:** 모든 파생 행은 `events/*.md`만으로 재구성 가능. 이벤트로 추적 안 되는 행이 있으면 스키마가 틀린 것.
- **최초 유효 cut(Phase F):** `events`+`nodes`+`edges`(임베딩 없이) → Control Room 그래프 쿼리.
  **pgvector(임베딩)는 최후** — Pattern Detector L0→L1 대규모 유사도용, 코퍼스 크기 driven.
- **앱 SQLite와 완전 분리**(INVARIANT #6) — governance는 별도 스토어. Phase A는 인메모리 fold만(Postgres 의존 0).

---

## 7. Phase A — 첫 슬라이스 (실행 가능, 즉시 착수)

(consult Q4 — codex + opus 거의 동일; 아키텍트의 INVARIANT-#1 coupling + property test 채택)

**Phase A = Task lifecycle, event-sourced, 상태 머신으로 관찰 가능, 순수 projector + 순수성 증명 테스트.**
**Plan·Session·Spec·orchestrator dispatch·Postgres·UI 전부 없음.** (v2 "first slice = governance
round-trip, no cmux" 규율과 동형.)

### 7.1 이벤트 타입 (`event/event.ts` `EventType` union에 추가)

`task_started`, `task_blocked`, `task_completed`, `task_cancelled` (`task_created`는 이미 존재).
`source` = 사람 발기 시 `hermes`, 세션 방출 시 `agent_run` — **어느 것도 verdict 권위 없음.**

### 7.2 MCP 명령 (decision 명령 표면 미러)

- `create_task`(존재) 유지 · `start_task <id>` · `block_task <id> <reason>` · `complete_task <id>` ·
  `cancel_task <id>` (각 1개 lifecycle 이벤트, `related_to:[taskId]`).
- `task <id>` — read: `deriveTaskState` fold + audit chain (`why` 클론).
- `tasks` — read: non-terminal task 리스트 (`conflicts` 클론).

### 7.3 Task lifecycle 상태 머신 + 가드 (순수 `deriveTaskState`, `decision.ts` fold 클론)

```
ready ──start──▶ active ──complete──▶ done   (terminal)
  │                │  └──block──▶ blocked ──(unblock=start)──▶ active
  └──cancel──▶ cancelled (terminal)        active ──cancel──▶ cancelled
```

가드(거부 함수, `guardian.ts` 클론):

- `canStart`: `ready`/`blocked`에서만. terminal이면 거부.
- `canComplete`: `active`에서만. **그리고 task의 related chain에 미해결 `decision_blocked`가 있으면 거부**
  ← INVARIANT #1과의 구조적 연결(미응답 Type-0 fork 위에서 task를 done 못 함).
- `canCancel`: 모든 non-terminal.

### 7.4 파생 투영 + keystone 테스트

`state/tasks.json`(또는 렌더된 `tasks/<status>/<id>.md`)은 **fold를 읽는 projector만** 쓴다.

> **Property test:** 무작위 유효 task 이벤트 시퀀스에 대해 `render(events)`는 `state/` wipe 후의
> `render(events)`와 동일 — 투영은 이벤트 로그의 순수 함수이며 markdown만으로 복구된다. (모델이 손편집
> 상태 파일로 썩는 것을 막는 단 하나의 테스트.)

### 7.5 관찰 가능 Done-criteria (산문 아닌 증거)

1. `create_task`→`start_task`→`complete_task` = 불변 이벤트 3개; `task <id>`가 `ready→active→done`
   전진 + 전체 audit chain 표시.
2. chain에 열린 `decision_blocked`가 있는 task의 `complete_task`는 **이유와 함께 거부**(INVARIANT-#1 coupling 증명).
3. `state/` wipe → projector 재실행 → 투영 byte-identical (파생-not-authored 증명).
4. task 명령들이 어떤 `decision_*`도 쓰지 않음(negative test).
5. vitest green; Postgres 없음; **`bindings.ts` 변경 없음**(MCP는 stdio → INVARIANT #4 비대상, 현 server stdio 확인).

---

## 8. 상태 머신 (Phase A 상세, 이후 Phase 스케치)

- **Task** (Phase A): §7.3.
- **Plan** (Phase B): `draft→proposed→active→(needs_revision↔active)→completed→archived`, `superseded`.
  drift 감지(완료 task 미반영 / plan 밖 작업 / 정체 step / spec 범위 이탈 / 과대 task → 분할).
- **Session** (Phase D): `planned→opening→active→{waiting,blocked,context_pressure_high,checkpoint_requested}→
checkpointing→handoff_ready→closing→closed`, `crashed→recovering`. ownership = user_owned|orchestrator_owned|external_owned.
  자동 close 금지/자동 open 허용 가드는 사용자 §18.3/18.4 그대로.
- **Handoff** (Phase G): `requested→drafting→validating→pending→consumed→archived`, `validating→invalid→drafting`.
  필수 섹션(Mission/Completed/Current failing point/Important implicit knowledge/Next exact steps/Do not do/Open questions)
  없으면 invalid.
- **Decision/Approval** (기존 v1/v2): Type 0 pending → Type 2 자동 가능 / Type 1 guarded → external review → human gate.

> **god-fold 금지:** 축마다 fold 하나(`deriveDecisionState`/`deriveTaskState`/`derivePlanState`),
> 각자 소유 안 하는 이벤트 타입은 무시(fail-closed type filter — 현 `decision.ts` 규율 유지).

---

## 9. Context Steward / Handoff (Phase G)

- **context_pressure** = weighted(estimated_token_ratio, turn_count, wall_clock, files_touched,
  unresolved_decisions, plan_step_distance_to_safe_boundary, last_handoff_age).
  low<0.50 / medium<0.70 / **high<0.85** / critical≥0.85 (70% = 비용 관리 압축 임계와 정합).
- **reset flow:** `context_pressure_high` → `checkpoint_requested` → 에이전트가 안전 경계까지 마무리 + handoff 작성
  → `handoff_validated` → `handoff_ready` → old 세션 closing → new 세션 opening → **hydration bundle만** 소비 → `handoff_consumed`.
- **hydration bundle**(전체 로그 X): role template · 관련 principles · spec · active plan · current task ·
  최신 handoff · 최근 N events · git status/diff 요약 · known risks · exact next actions.
- **세탁 방지(§4.4#5):** handoff는 미해결 blocker + envelope 보존; hydration은 권한 확장 불가.

---

## 10. 마스터 Phase 시퀀스 (decomposition — 각자 spec→plan→critic)

| Phase | 슬라이스                                                       | Depends-on                  | DB       | UI       | Done(관찰)                                                                       |
| ----- | -------------------------------------------------------------- | --------------------------- | -------- | -------- | -------------------------------------------------------------------------------- |
| **A** | Task lifecycle SSOT (fold+가드+projector+property test)        | BUILT substrate             | 없음     | 없음     | §7.5                                                                             |
| **B** | Spec/Plan event-sourcing + **Planner**(intent→`plan_proposed`) | A                           | 없음     | 없음     | 1 intent→1 draft plan; plan 채택=사람 게이트                                     |
| **C** | **Conductor** + autonomy-envelope (cmux 1-step spawn)          | B + escalation spine(BUILT) | 없음     | 없음     | 세션 spawn→`task_completed`/`decision_blocked` 관찰→pointer 전진; approve 능력 0 |
| **D** | Session Registry + cmux Observer (read-only heartbeat)         | C                           | 없음     | 없음     | 입력 없이 에이전트 상태 관찰; orphan 감지                                        |
| **E** | Orchestrator projector — **observe/suggest only**              | A,B,C,D                     | 없음     | 없음     | "이 세션 checkpoint 필요"·"이 task에 세션 열어야" 제안 생성                      |
| **F** | Postgres+pgvector 그래프 인덱스 (스키마는 A서 확정)            | E (코퍼스 driven)           | **여기** | 없음     | markdown→완전 재구축 멱등; checksum 일치                                         |
| **G** | Context Steward / Handoff continuity                           | E                           | —        | 없음     | 긴 작업이 reset 후 다음 세션에서 이어짐                                          |
| **H** | Control Room UI (6 패널, specta IPC)                           | E,F,G                       | —        | **여기** | spec→plan→task→session 그래프·drift·승인 큐·replay                               |
| **I** | 좁은 opt-in auto (Type-2·in-envelope만)                        | E,G + envelope(C)           | —        | —        | Type-2 반복 운영 자동화; Type-1은 사람 게이트                                    |

점진 도입 — 막히는 지점에서만 다음 계층(v1 §9 / 사용자 §21 권장). 각 Phase는 **별도 spec + plan +
critic ACCEPT(별도 패스, self-approve 금지)** 후 다음.

---

## 11. 확장 이벤트 타입셋 (사용자 §16 — Phase별 점증)

기존(commit*recorded/pr*_/ci*failed/agent_run_completed/decision*_/task_created)에 추가:

- spec/plan: `spec_proposed`·`spec_accepted`·`spec_archived`·`plan_proposed`·`plan_accepted`·`plan_revised`·`plan_drift_detected`·`plan_completed`
- task(Phase A): `task_started`·`task_blocked`·`task_completed`·`task_cancelled`
- session(Phase D): `session_open_requested`·`session_opened`·`session_observed`·`session_waiting`·`session_blocked`·`session_context_pressure_changed`·`session_checkpoint_requested`·`session_handoff_ready`·`session_close_requested`·`session_closed`·`session_crashed`·`session_recovered`
- handoff(Phase G): `handoff_requested`·`handoff_drafted`·`handoff_validated`·`handoff_invalid`·`handoff_consumed`
- orchestration(Phase E): `instruction_planned`·`instruction_sent`·`instruction_rejected_by_policy`·`orchestrator_suggestion_created`·`orchestrator_action_executed`·`orchestrator_action_failed`·`action_denied`·`projection_rebuilt`
- approval(기존 확장): `approval_requested`·`approval_granted`·`approval_rejected`

> 한 flat union이 비대해지면 fold 분리가 흐려진다(§8 god-fold 금지). Phase별로만 추가.

---

## 12. Control Room UI (Phase H — 인앱 Tauri/shadcn)

6 패널: System Overview · Spec/Plan Graph · Agent Session Board · Handoff Queue · Approval/Decision Queue ·
Timeline/Replay. 핵심 그래프 `Spec └ Plan ├ Task ─ Session ─ Handoff ─ Session`. 노드 색:
green=healthy/done · blue=active · yellow=waiting/review · orange=context pressure/handoff ·
red=blocked/crashed/Type1 conflict · gray=archived/derived.

- **파생 `state/`(또는 Phase F Postgres)를 specta-typed IPC로 read.** 승인은 기존 Hermes shadcn
  카드(ADR-0007) 재사용 — UI가 외부 리뷰/quorum/actor 게이트를 **우회하지 못함**(§13 위험).
- INVARIANT #4(specta drift CI 게이트)·#7(shadcn+Tailwind v4) 준수. **최후 Phase** — Phase A 아님.

---

## 13. INVARIANT Compliance (decision-rails — 리뷰 바)

| #   | INVARIANT                    | Posture                                                                                                                                                 |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 자동화 → 결정 레일 침투 금지 | 구조적: 모든 모듈/세션은 propose/block만; `decision_*` write-path 0; `approve`=`actor:user`+`canApprove`; timeout→blocked; 신규 레일+negative test(§4). |
| 2   | 외부 토큰 keychain           | Telegram 자격증명은 `~/.hermes` fabric(레포 밖); Postgres 자격증명 keyring; Boule은 토큰 미보유.                                                        |
| 3   | 외부 네트워크 Rust           | 네트워크 호출은 기존 Python fabric/`github.rs`; Boule(TS)·governance 서비스는 로컬 이벤트/Postgres.                                                     |
| 4   | IPC = specta 생성            | Governance MCP=stdio(비대상). Control Room(Phase H) 신규 커맨드/이벤트만 specta, drift CI 게이트. Phase A 변경 0.                                       |
| 5   | bounded retry                | escalation=event-driven+human-gated; 사이드카 폴링 루프 없음; ingest/recovery는 bounded scan+backoff.                                                   |
| 6   | SQLite 마이그레이션만        | governance=별도 Postgres(앱 sqlite 무변경). Phase A는 DB 없음. spawn 세션은 worktree 격리.                                                              |
| 7   | 시각 디자인 DESIGN.md        | Phase A~G UI 없음. Control Room(H)은 shadcn+Tailwind v4 토큰.                                                                                           |

INVARIANT 검증은 **별도 reviewer 패스**(critic) — self-approve 금지.

---

## 14. Top Risks (consult Q5 — codex + opus 합의) → 완화

1. **투영 권위 누수(최고)** — projector/orchestrator가 이벤트 방출/verdict minting. → 투영은 순수·total·I/O 0·방출 0; negative test; `actor:"user"` 하드핀 유지.
2. **Conductor 미구축인데 그 위에 orchestrator를 올림.** → 마스터 시퀀스가 Conductor(Phase C)를 멀티-모듈 orchestrator(E) 앞에 배치; 디스패처 없이 Scheduler/Session Manager 금지.
3. **Postgres-now가 smallest-change·상시 ops 위반**(v1 §11 "사이드카 운영 부담"). → 스키마/계약만 지금 확정, 서버는 Phase F; Phase A 인메모리; pgvector 최후.
4. **이중 SSOT 드리프트**(렌더 task 문서 ↔ 이벤트 로그 손편집). → write-through `GENERATED` 마커 + property test + `tasks/` gitignore 고려; CI drift 체크.
5. **인앱 Control Room이 dev-DB skew / bindings drift 재유발**(MEMORY: `Migrate(VersionMissing(38))` 패닉; 브랜치가 origin/dev 마이그레이션보다 뒤). → governance 스토어 앱 sqlite와 완전 분리; UI는 thin specta IPC(drift CI 게이트); UI 슬라이스 전 앱 마이그레이션 rebase; UI는 최후 Phase.
6. **이벤트 타입셋 폭발 → fold 명료성 저하.** → 축마다 fold 하나, 소유 안 한 타입 무시(fail-closed); Phase별 점증.
7. **autonomy-envelope가 장식적**(미명세인데 settled로 제시). → envelope 스키마 + per-session 경로 권한 강제는 Phase C에서 critic-accepted; 그 전엔 observe/suggest만.
8. **context handoff가 ambiguity를 자신감 있는 실행으로 세탁.** → handoff가 미해결 blocker+envelope 보존; hydration 권한 확장 불가.
9. **additive-on-v2가 평행 Planner/Conductor 구현으로 변질.** → v3가 v2 substrate를 _감싼다_; 동치 증명 전 교체 없음.

---

## 15. Distribution / Verification

- **분배:** `/omc-teams`(CLI tmux)는 이 환경(cmux)에서 startup 스톨 이력(MEMORY) → 기본은 **네이티브
  병렬 에이전트**(v1 §10). 두-모델 컨설트(이 doc)는 codex + opus architect로 실증.
- 병렬 격리 주의(parallel-agent-safety): worktree 교차오염 이력 → 순차 또는 명확한 경로 분리; executor late-writes → 커밋 전 git status.
- **검증:** governance 자체 vitest(이벤트 fold·projection 순수성·rebuild 멱등); work-radar 변경분(Phase H IPC)은
  `cargo test`+clippy+fmt / `pnpm typecheck`+lint+vitest / `pnpm bindings:check`(drift 0) / `pnpm tauri dev` 부팅.
  INVARIANT 7개 별도 critic 패스. 실행 못 한 검증은 "could not run" ≠ "passed".

---

## 16. Provenance / Open Items

- **두-모델 컨설트(2026-06-02):** codex(codex-cli 0.135.0) + opus architect agent. 합의 = 두 직교 축 ·
  execution plane은 권위 없음 · 이벤트만 가변 진실 · orchestrator 승인 불가 by-construction · timeout→blocked ·
  Phase A는 Postgres 의존 0 + property test · Conductor를 orchestrator 앞에 시퀀싱. 발산(사용자 해소):
  ⓐ Phase A 범위 — codex(spec/plan/task 얇게 전부) vs opus(Task만) → **opus 채택(smallest-change)**.
  ⓑ Postgres 타이밍 — 둘 다 "Phase A 금지", 서버 stand-up Phase F → 사용자 수용.
- **남은 forks(각 Phase plan에서 해소):** Boule↔Telegram 브릿지 seam (a/b/c — v2 권고 (a)) · autonomy-envelope
  상세 스키마(Phase C) · Postgres ingest 트리거 메커니즘(Phase F) · Control Room 권한 surface 상세(Phase H).
- **ADR 후보:** ADR-0007 companion(two-surface HITL) · 새 결정 레일(spawn 세션 강제 escalation, Meta-Observer PR 게이트).
