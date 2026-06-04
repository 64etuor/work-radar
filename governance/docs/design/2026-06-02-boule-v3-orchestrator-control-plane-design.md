# SSOT Governance Harness — Boule v3: Orchestrator Control Plane (consolidated design)

- **Date**: 2026-06-02 (architecture) · **consolidated 2026-06-04**
- **Status**: **Phases A–H Slice 1 BUILT and landed on `dev`** (governance line merge `2a5a9db`). **Phase I designed (spec rev.2 + plan, critic ACCEPT) but implementation PARKED.**
- **Canonical**: **THIS file is the single v3 reference.** The per-phase design docs were folded in here (2026-06-04, §7 Phase Ledger); their detailed **implementation plans remain** in `governance/docs/plans/2026-06-0x-boule-v3-phase-*.md`. The v1/v2 design docs and pre-v3 slice specs are **historical** (kept in `design/`, see `INDEX.md`). Point AIs at this one file for v3 context.
- **Parent designs (historical, folded)**:
  - `design/2026-05-31-ssot-governance-harness-design.md` (v1 — 5-layer SSOT, 7 agents, MCP, INVARIANTs)
  - `design/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md` (v2 — HITL control plane, Planner/Conductor, escalation, autonomy envelope) — see §1.
- **Provenance**: synthesized from a **two-model architecture consult** (`codex exec` codex-cli 0.135.0 + an opus architect agent), both grounded by reading the real code (`deriveDecisionState`, `canApprove`/`approve`, `chooseOption`, `buildIndex`, the `EventType` union, the `governance/workspace/` layout) and the v1/v2 designs.

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

여기에 Control Room UI, Postgres+pgvector 인덱스/그래프, 확장 이벤트/MCP 명령셋,
강한 경로-권한 모델, 장애 복구 플로우가 따라온다.

### 0.1 가장 중요한 아키텍처 선택 (사용자 정본)

> **상태를 runtime에 묻지 않는다. 상태를 SSOT(append-only events)에 적고, runtime은 관찰해서 보정한다.**
> **긴 context를 유지하려 하지 않는다. handoff artifact를 만들어 세션을 갈아탄다.**
> **중앙 오케스트레이터가 모든 걸 결정하지 않는다. 로컬 agent · 상태 머신 · policy · human approval이 함께 진화한다.**

### 0.2 Settled Decisions (사용자 확정 — 재론 금지)

1. **v2 위에 additive layering** — v2의 escalation spine + Planner/Conductor를 실행 substrate로 두고,
   v3는 Session Registry / Orchestrator projection / Context Steward / Control Room을 그 위에 올린다.
2. **Postgres + pgvector — 스키마/재구축 계약은 _지금_ 확정, 서버 stand-up은 Phase F.**
   Phase A는 인메모리 fold만. pgvector 최후. _(두 모델이 독립적으로 "Phase A는 Postgres 의존 금지" 권고 → 수용.)_
3. **Control Room UI = work-radar 인앱 Tauri/shadcn 뷰** (specta IPC, 앱 셸 재사용). **Phase H.**
4. **첫 상세 슬라이스 = Task lifecycle (Phase A)**; 나머지는 마스터 시퀀스의 순차 Phase.
5. **Planner = Phase B, Conductor = Phase C — 각자 별도 Phase로 먼저 구축**(critic ACCEPT)
   하고, 멀티-모듈 Orchestrator(Phase E)는 그 _뒤_. _(Conductor 미구축 상태에서 Scheduler/Session Manager 금지.)_

---

## 1. Prerequisites & v2 Relationship — v1/v2 흡수 (folded)

**"v2 완성"은 별도 선행조건이 아니다.** v2의 _미구축_ 부분이 곧 이 v3 플랜의 초기 Phase(B/C)였고, 이제 전부 빌드됐다.

**v1이 v3에 남긴 토대 (그대로 유지):** L0–L4 인식론 사다리(events→patterns→hypotheses→decisions→principles),
7 propose-only 에이전트, Governance MCP(stdio), L0 harvest(content-addressed·멱등), Pattern Detector(인메모리),
review quorum(≥2 distinct-model, fail-closed), `deriveDecisionState` fold, INVARIANT 매핑.

**v2가 v3에 남긴 것 (실행 substrate):** HITL 컨트롤 플레인, escalation round-trip(`escalate`/`choose`,
`decision_blocked` 이벤트), autonomy-envelope 개념, two-surface HITL, Boule↔Telegram 브릿지(sync-once).
v2의 _미구축_ 부분이던 **Planner(intent→`plan_proposed`)는 Phase B, Conductor(cmux 디스패처)는 Phase C**로 구축됐다.

| 구분                  | 항목                                                                            | 상태 |
| --------------------- | ------------------------------------------------------------------------------- | ---- |
| **BUILT (v1 substrate)** | L0–L4 SSOT, 7 에이전트, MCP, L0 harvest, Pattern Detector, review quorum, fold | ✅   |
| **BUILT (v2 spine)**     | escalation round-trip, `decision_blocked`, Telegram 브릿지                    | ✅   |
| **BUILT (was v2 design-only)** | Planner(Phase B), Conductor(Phase C), autonomy-envelope, cmux spawn      | ✅   |

> v2의 규칙("Plan은 새 레이어가 아니다")은 *저장 구조*가 아니라 ***권위***에 관한 것이었다 — Plan이
> 무언가를 "승인"하면 결정 레일 침투(INVARIANT #1). 실행 평면을 **권위 없는 직교 축**으로 두어 그대로 보존(§2).

---

## 2. The Two Axes — Execution Plane is Orthogonal to the Epistemic Ladder

Boule는 **하나의 append-only L0 이벤트 스토어 위에 두 개의 직교 축**을 갖는다.

- **인식론적 사다리 (L0–L4)** — _프로젝트가 무엇을 참이라 믿는가_. (v1 그대로)
  - L0 events → L1 patterns → L2 hypotheses → L3 decisions → L4 principles.
- **실행 평면 (Spec → Plan → Task → Session → Handoff)** — _지금 어떤 작업이 흐르고 있는가_. (신규)
  - 같은 L0 스토어에 라이딩. **verdict 권위를 일절 갖지 않는다.**

> **Decision은 의도를 추구할 *권한*을 부여한다. Plan은 그 의도를 *분해*한다.**
> **Task는 그 분해를 *실행*한다. 이벤트만이 유일한 가변 진실(mutable truth)이다.**

- **Task는 새 인식론적 레이어가 아니다** — L0–L4와 직교하는 **실행 단위**.
- **Plan은 권위가 아니라 분해다** — Plan의 권위는 오직 승인된 `dec_*`에서.
- **Spec 본문은 사람이 저술**(ADR 본문과 동일) — 산문을 event-source 하지 않는다. Spec의 _lifecycle_만 이벤트.

### 2.1 The keystone invariant — 상태는 파생물이다 (절대 손으로 안 고친다)

> **Task의 경로 segment / frontmatter `status:`는 DERIVED다. 이벤트 fold를 읽는 projector만 그것을 쓴다.
> 어떤 명령·에이전트·사람도 `status:`를 직접 편집하지 않는다. `tasks/`를 통째로 지워도 projector
> 재실행이 bit-for-bit 재구성한다.**

v3에서 가장 먼저 썩는 지점이므로 **순수성 property test로 강제**(모든 Phase의 fold). 렌더 문서는
`GENERATED — do not edit` 마커, 파생 디렉토리(`tasks/` 등)는 L0-harvest처럼 gitignore.

---

## 3. Domain Model — Spec / Plan / Task / Session / Handoff

전부 YAML frontmatter + Markdown 본문. **단 frontmatter의 lifecycle 필드는 파생** — 식별/내용은 생성 이벤트로, 상태는 fold로.

| 객체        | 의미             | 정본(쓰기 진실)                                       | 파생(렌더)                  | 권위                 |
| ----------- | ---------------- | ----------------------------------------------------- | --------------------------- | -------------------- |
| **Spec**    | 무엇을 만들지    | 본문=사람 저술 + lifecycle 이벤트                     | `specs/<status>/` 경로      | 없음 (의도 기술)     |
| **Plan**    | 어떻게 분해      | `plan_proposed`/`plan_revised`/`plan_accepted` 이벤트 | 최신 non-superseded 투영    | 없음 (sequencing만)  |
| **Task**    | 실행 단위        | `task_*` lifecycle 이벤트                             | `tasks/<status>/<id>.md`    | 없음 (실행만)        |
| **Session** | 런타임 관찰 객체 | `session_*` 이벤트                                    | `sessions/<status>/<id>.md` | 없음 (관찰/디스패치) |
| **Handoff** | 연속성 계약      | `handoff_*` 이벤트                                    | `handoffs/<status>/<id>.md` | 없음 (continuity)    |

Plan의 "현재 모습"은 편집된 파일이 아니라 **최신 non-superseded `plan_*` 이벤트들의 투영**이다.
**Plan은 아무것도 승인하지 않는다.** Plan 채택은 사람 게이트(`plan_accepted`, `actor:"user"`).

---

## 4. Orchestrator — 승인 불가능하도록 by-construction

오케스트레이터는 **또 하나의 propose-only 에이전트**다. 신규 쓰기 권한은 verdict를 갖지 않는
`task_*`/`session_*` lifecycle 이벤트 뿐이며, `approve`/`choose`/`decision_*` write-path는 **0**이다.

| 모듈                                            | 쓸 수 있음                                               | 절대 못 씀                                            |
| ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Event Reader · State Projector · Audit Writer   | 파생 투영 / `state/` 캐시                                | 어떤 L0 verdict                                       |
| Policy Evaluator · Context Steward              | `suggestion`-class 이벤트(자문)                          | verdict · task 전진                                   |
| Scheduler · Session Manager · Action Dispatcher | `session_*` + `task_started`/`task_blocked`(envelope 내) | 관찰 안 한 작업의 `task_completed`; 모든 `decision_*` |
| Safety Gate                                     | (없음 — _거부_ 함수)                                     | (승인 불가; `canApprove` 미러 — block만)              |

**사람 게이트(불변):** Type 1 결정 승인 · L4 변경 · scope/risk/권한/결정 의미를 바꾸는 plan 채택 ·
observe/suggest → auto 승격 · autonomy-envelope 경계 변경 · 파괴적/외부-프로덕션/자격증명/광범위 쓰기.

> **정직한 트레이드오프:** _지연이 곧 기능이다._ blocked 결정은 사람이 올 때까지 무기한 대기.
> 높은 자율성과 구조적 보장을 동시에 주는 설계는 없다 — **빈약한(anemic) auto를 채택**한다.

**핵심 실패-모드 완화:** ① Scheduler/Conductor가 timeout-default로 결정자가 됨(최대 위험) →
`decision_blocked`는 **auto-resolution도 timeout-default도 없음, 영원히 halt**; *negative test*가 진짜 가드.
② 분류 드리프트 → auto는 화이트리스트 Type-2만, 모호하면 보수적 `decision_blocked`. ③ "auto"가 게이트
무력화 → 게이트 함수에 mode 파라미터 **없음**(`canApprove` 순수). ④ projector가 verdict minting → 투영은
total 함수, I/O·방출 0(방출하는 projector = 리뷰 실패). ⑤ Context Steward가 ambiguity를 세탁 →
handoff는 미해결 blocker + envelope 보존, hydration은 권한 확장 불가.

명령 표면: `propose_*` ↔ `approve_*` API 레벨 분리. `approve_*`는 `actor:"user"` 하드핀 + `canApprove`.
**승인 엔드포인트는 에이전트 MCP stdio에 미노출.** Safety Gate는 deny-by-default + `action_denied` 방출.

---

## 5. Storage Layout (v1 사이드카에 실행 평면 추가)

```
governance/workspace/
  events/  patterns/  hypotheses/  reviews/  state/  agents/  interfaces/   # v1
  specs/      proposed/ active/ accepted/ archived/    # 본문=저술, lifecycle=파생 (Phase B2)
  plans/      proposed/ active/ done/ archived/        # 투영(최신 non-superseded) (Phase B)
  tasks/      ready/ active/ blocked/ review/ done/ archived/   # GENERATED, gitignore (Phase A)
  sessions/   active/ waiting/ blocked/ checkpointing/ handoff_ready/ closed/ crashed/  # (Phase D)
  handoffs/   pending/ consumed/ archived/             # (Phase G)
  orchestrator/  policies.md state-machines.md routing.md safety-rails.md  # (Phase E)
  index/      pglite/                                  # 파생 그래프 캐시, gitignore (Phase F)
```

L3/L4는 v1대로 어댑터(adr/decisions.md/decision-rails)를 재사용 — 복제 안 함.
**쓰기는 항상 markdown(events) 먼저, 인덱스/투영은 파생(비동기).** 손상 시 markdown에서 완전 재구축.
파생 `state/*.json`은 gitignored (각 phase의 projector가 유일 writer).

---

## 6. Postgres + pgvector — 파생 인덱스 (정본 아님, Phase F)

**모든 테이블은 markdown에서 `TRUNCATE; fold(events)`로 재구축 가능한 파생 캐시.** 정본 아님.
Phase F는 **임베디드 PGlite**(in-process WASM Postgres)로 첫 cut; 실서버/pgvector는 코퍼스 driven으로 최후.

```
events(event_id PK, content_hash, event_type, occurred_at, actor, subject_type, subject_id,
       authority_decision_id, markdown_path, payload_jsonb)  -- L0와 1:1
nodes(node_id PK, node_type, canonical_id, title, state_jsonb, embedding vector)  -- 투영
edges(edge_id, from_node_id, to_node_id, edge_type ENUM(related_to|supersedes|refs|blocks|step_of), source_event_id)
-- deferred: session_observations · approvals(actor 반드시 'user')
```

- **멱등 ingest** (L0 harvest 패턴): 동일 content_hash = no-op. **재구축:** truncate → 결정적 fold →
  nodes/edges 재생성 → **투영 checksum을 markdown-렌더와 비교**(DB == pure projection).
- **앱 SQLite와 완전 분리**(INVARIANT #6). Phase A–E는 인메모리 fold만(Postgres 의존 0).

---

## 7. Phase Ledger (A–I) — as-built

각 Phase는 **별도 spec + plan + critic ACCEPT(별도 패스, self-approve 금지)** 로 구축됐다. 아래는 각 Phase의
**as-built 핵심**(설계 정수 + 상태 + 이벤트 + INVARIANT-#1 기전 + 코드 위치 + deferred)을 통합한 것이다.
상세 구현 플랜은 `governance/docs/plans/2026-06-0x-boule-v3-phase-*.md`에 남아 있다.

### Phase A — Task lifecycle SSOT

- **Status:** ✅ Built · on dev · 첫 슬라이스(foundational) · critic ACCEPT · 순수성 property test green
- **Goal:** Task lifecycle를 event-sourced·상태머신 관찰가능·순수 projector + 순수성 증명 테스트로. Plan·Session·Spec·dispatch·Postgres·UI 전부 없음.
- **Depends-on:** BUILT substrate (v1/v2)
- **As-built design (essence):**
  - 이벤트 타입 `task_started`/`task_blocked`/`task_completed`/`task_cancelled` (`task_created` 기존). `source`=사람발기 `hermes` / 세션방출 `agent_run` — 둘 다 verdict 권위 0.
  - 순수 `deriveTaskState` fold: `ready ─start▶ active ─complete▶ done`(terminal); `active ─block▶ blocked ─(unblock=start)▶ active`; `*─cancel▶ cancelled`(terminal). fail-closed type filter.
  - 가드(거부 함수): `canStart`(ready/blocked만), `canComplete`(active만 **+ related chain에 미해결 `decision_blocked` 있으면 거부**), `canCancel`(non-terminal). ← INVARIANT-#1과 구조적 연결.
  - 파생 투영 `state/tasks.json`은 fold projector만 쓴다. **keystone property test:** 무작위 유효 시퀀스에 대해 `render(events)` == `state/` wipe 후 `render(events)`.
- **Events/types added:** `task_started`·`task_blocked`·`task_completed`·`task_cancelled`
- **INVARIANT-#1 mechanism:** task 명령은 `decision_*` 0 write(negative test); `canComplete`가 열린 `decision_blocked` 위에서 done 거부(구조적 coupling 증명).
- **Code:** `governance/src/task/{task,guards,handlers,project}.ts`; MCP `start_task`/`block_task`/`complete_task`/`cancel_task`/`task`/`tasks` (stdio → `bindings.ts` 무변경, INVARIANT #4 비대상).
- **Deferred:** Plan/Session/Spec/dispatch/Postgres/UI (이후 Phase).

### Phase B — Plan lifecycle + Planner

- **Status:** ✅ Built · on dev · opus critic ACCEPT (0B/0M) · vitest 242
- **Goal:** Plan을 event-sourced 실행평면 객체로(상태=L0 fold) + propose-only Planner(intent→정확히 1 `plan_proposed` draft, 자기 plan 채택 불가).
- **Depends-on:** A
- **As-built design (essence):**
  - Plan = append-only L0 이벤트(가변 레코드 없음); 상태 = `derivePlanState(created, related)` 순수 fold(`src/task/` 미러). 별도 버전 테이블 없음.
  - 상태머신: `draft → active → needs_revision`, terminal `completed / archived / superseded`. fold 우선순위 `archived > superseded > completed`, else 최신 `{accepted→active, revised→needs_revision}` (chronological id).
  - `plan_revised`(reason 보유) → `active→needs_revision`; `plan_superseded`(terminal)는 `supersededBy`(대체 plan 참조) 기록.
  - Planner = `proposePlan` 핸들러, `actor:"planner"`/`source:"hermes"`; non-empty intent + ≥1 step 검증; **정확히 1 `plan_proposed`만 쓰고 accept/verdict write-path 0.**
  - accept = 하드코딩 사람 게이트: 모든 non-propose 전이가 단일 `writeLifecycle`(`actor:"user"` 하드핀) 경유.
- **Events/types added:** `plan_proposed`·`plan_accepted`·`plan_revised`·`plan_completed`·`plan_archived`·`plan_superseded`
- **INVARIANT-#1 mechanism:** Planner 에이전트엔 `propose_plan`만 등록, `accept_plan`(사람 게이트)은 미등록. negative test: `plan_proposed`에 `actor:"user"` 없음 / `plan_accepted`에 `actor:"planner"` 없음 / plan 명령 `decision_*`·`task_*` 0.
- **Code:** `governance/src/plan/{plan,guards,handlers,project}.ts`; `src/mcp/server.ts` +8 tools.
- **Deferred:** `plan_drift_detected` + drift 휴리스틱; Conductor 연동(C); Postgres(F); UI(H).

### Phase B2 — Spec lifecycle

- **Status:** ✅ Built · on dev · opus critic ACCEPT (0B/0M, 2 minor fixed) · vitest 263
- **Goal:** Spec를 event-sourced 객체로(`draft → accepted → archived`, 사람 게이트 acceptance).
- **Depends-on:** A (B의 sibling, `src/plan/` 미러)
- **As-built design (essence):**
  - 3-phase lifecycle (`archived`만 terminal, `accepted`는 live). `deriveSpecState` 우선순위 archived > accepted > draft.
  - **Spec 본문은 markdown에 남고**(§3), 이벤트는 lifecycle만 기록. 이벤트 body의 `summary`는 denormalized 라벨(정본 아님).
  - `proposeSpec(dir,{title,summary})` propose-only, `actor:"author"`(never `"user"`), 정확히 1 `spec_proposed`. 가드 `canAccept`(draft만)/`canArchive`(non-terminal). 순수 projector `renderSpecs`→`state/specs.json`.
- **Events/types added:** `spec_proposed`·`spec_accepted`·`spec_archived`
- **INVARIANT-#1 mechanism:** `spec_accepted`는 `acceptSpec`(`actor:"user"` 하드핀)만 씀. negative test: spec 명령 `decision_*`/`task_*`/`plan_*` 0.
- **Code:** `governance/src/spec/{spec,guards,handlers,project}.ts`; `src/mcp/server.ts` +5 tools.
- **Deferred:** spec↔plan 링크(plan `related_to` accepted spec), spec revision/supersession, scope-exit drift.

### Phase C — Conductor + autonomy-envelope

- **Status:** ✅ Built · on dev · opus critic round-2 ACCEPT (0B/0M) · vitest 301 · 라이브 cmux smoke = 사용자
- **Goal:** 디스패처(결정자 아님) — 단일 MCP `conduct_plan`이 사람-채택 plan을 호출당 최대 1스텝 전진(task mint + 격리 cmux 세션 1개 spawn 후 stop).
- **Depends-on:** B + escalation spine (built)
- **As-built design (essence):**
  - `deriveConductorState(plan, allEvents)` 순수 합성 투영(`step_bound`/`session_spawned` 위, `derivePlanState`/`deriveTaskState`/`hasOpenBlock` 위임); 저장 커서·데몬 없음(다음 호출에 재유도).
  - 전제: plan이 `active`여야(사람 `accept_plan` 게이트); priors가 terminal-done인 최저 미materialized 스텝을 전진 — 엄격 순차(병렬 fan-out → 후속).
  - autonomy envelope(worktree 경로, advisory globs/Type-2 화이트리스트, forbidden classes, `escalateOnAnyBoundaryCrossing`)을 `session_spawned` body + `<worktree>/.boule/envelope.json`로 운반, sha256 `envelopeHash` tamper-evident.
  - 데몬 없이 결과 관찰: 다음 `conduct_plan`/`conductor_status`에 이벤트 재독 — `task_completed`→포인터 전진, `decision_blocked`→halt.
  - DI `ConductorAdapter`: stub 기본(git/cmux/fs 없음); 라이브 cmux는 `BOULE_CONDUCTOR_MODE=live`(실 `git worktree add --detach` + `cmux new-workspace`).
- **Events/types added:** `step_bound`·`session_spawned` (actor=conductor, verdict-free); `escalate`에 optional `relatedTaskId` 추가.
- **INVARIANT-#1 mechanism:** `conductor/`는 결정 write 핸들러 import 0 — `conduct_plan`은 `task_*`/`step_bound`/`session_spawned`만 mint. spawn 세션은 executor-role MCP 설정(`BOULE_SESSION_ROLE=executor`, verdict 도구 미등록 + `--strict-mcp-config` + denylist) 하에 실행. Type-1 → 세션이 `decision_blocked` 방출 + halt(사람 `choose`/`approve` 전까지 영속, timeout/default 없음).
- **Code:** `governance/src/conductor/{conductor,guards,envelope,adapter,handlers}.ts`; MCP `conduct_plan`/`conductor_status`.
- **Deferred:** 구조적 in-worktree path-glob 강제(advisory→F1/D); 병렬 fan-out; session-output 머지; `plan_completed` 자동화.

### Phase D — Session Registry + cmux Observer

- **Status:** ✅ Built · on dev · opus critic ACCEPT (0B/0M, 2 minor resolved) · vitest 353 · 라이브 `cmux tree --all --json` smoke 7/7 green
- **Goal:** read-only·on-demand 레지스트리가 세션 lifecycle를 이벤트에서 투영 + cmux Observer가 라이브 surface를 대조(observe/crash/recover/orphan), `decision_*` write 0 · 자동 close 0.
- **Depends-on:** C (`session_spawned`이 birth source)
- **As-built design (essence):**
  - `deriveSessionState`(순수, fail-closed, id-tiebreak): `planned→opening→active→{waiting,blocked,context_pressure_high,checkpoint_requested}→handoff_ready→closing→closed` + crash/recover. sessionId=birth-event id, `closed` terminal.
  - read-only Observer(`observer.ts`): on-demand 단발 reconcile(데몬/poll 없음), **state-change에만 방출**(heartbeat flood 없음), 패스당 세션당 ≤1 전이; **surface에 입력 절대 안 보냄.**
  - orphan: 미지 세션 surface → 1 `session_opened`(`external_owned`), 멱등; surface 소멸 → `session_crashed`; 복귀 → `session_recovered`.
  - ownership `user_owned | orchestrator_owned | external_owned`. no-auto-close는 **구조적**(observer가 `session_closed` write 0; 가드된 `close_session`만 close).
  - live-adapter fix: 실재하는 `cmux tree --all --json`로 surface walk(`type==="terminal"`만), `parseSurfaces` defensive. `BOULE_OBSERVER_MODE=live` 게이트.
- **Events/types added (12, verdict-free):** `session_open_requested`·`session_opened`·`session_observed`·`session_waiting`·`session_blocked`·`session_context_pressure_changed`·`session_checkpoint_requested`·`session_handoff_ready`·`session_close_requested`·`session_closed`·`session_crashed`·`session_recovered`.
- **INVARIANT-#1 mechanism:** Observer는 propose-only·read-only — `src/session/**` 어디도 `decision_*` write/import 0; negative test가 observe+record run에서 `decision_*` 0 + approve surface 0 검증.
- **Code:** `governance/src/session/{session,guards,project,handlers,observer}.ts`; `src/mcp/config.ts`(`parseObserverConfig`).
- **Deferred:** auto-pressure/auto-checkpoint(G), handoff 아티팩트(G), worktree auto-cleanup, orchestrator "open session for task" 제안(E).

### Phase E — Orchestrator projector (observe/suggest)

- **Status:** ✅ Built · on dev (`d0bd978`) · opus critic ACCEPT 0 blockers · vitest 371 · `bindings.ts` byte-unchanged
- **Goal:** Boule Orchestrator의 read-half — task/plan/session/decision 상태의 순수 cross-fold + Policy Evaluator가 **자문 제안만** 방출(스케줄/디스패치 없음).
- **Depends-on:** A,B,C,D
- **As-built design (essence):**
  - `view.ts` `projectOrchestratorView(all)` — 기존 per-axis fold(`projectTasks/Plans/Sessions`) + per-task `hasOpenBlock`(task 핸들러 재사용 = 그 INVARIANT-#1 coupling)의 순수 join. god-fold 금지 준수.
  - `policy.ts` `evaluateSuggestions(view)` — 순수, table-driven 5 자문 규칙(`session_checkpoint`/`task_needs_session`/`session_stale`/`task_blocked_decision`/`orphan_session`), `(ruleId, subjectId)` 결정적 정렬.
  - `suggest.ts` `suggest(dir, now, rand)` — 단일 impure 경계(`observer.ts` 미러): read→view→evaluate→dedup→`(ruleId,subjectId)`당 ≤1 `orchestrator_suggestion_created` 방출; 멱등(run1 N, run2 0); on-demand 1 패스.
  - 결정/task/session write 0; 신규 쓰기 권한은 suggestion-class 이벤트뿐.
- **Events/types added:** `orchestrator_suggestion_created` (only; `source/actor:"system"`, verdict 없음). `instruction_*`/`orchestrator_action_*`/`action_denied`는 의도적으로 Phase I로 연기.
- **INVARIANT-#1 mechanism:** `view`/`policy` 순수·total(I/O 0, 방출 0); 방출은 `suggest.ts`에 격리되어 suggestion-class만(`actor=system`). negative test가 5규칙 동시 발화 시 모든 신규 이벤트가 `orchestrator_suggestion_created`이고 `decision_*`/`task_*`/`session_*` 0임을 검증.
- **Code:** `governance/src/orchestrator/{view,policy,suggest,project}.ts`; MCP `suggest`/`suggestions`.
- **Deferred:** suggestion lifecycle(ack/dismiss + 재무장); 규칙 priority/suppression; dispatch/execute half(Scheduler·Session Manager·Action Dispatcher) → Phase I.

### Phase F — Graph index (Postgres/PGlite)

- **Status:** ✅ Built · on dev (`dc09f3a`) · plan-critic + impl-critic(둘 다 opus, 별도) ACCEPT 0 blockers · vitest 394
- **Goal:** L0 markdown 이벤트 위에 파생·재구축가능 그래프 인덱스(`events`+`nodes`+`edges`) + on-demand `rebuild_index` + thin read MCP. 임베딩 deferred.
- **Depends-on:** E (코퍼스 driven)
- **As-built design (essence):**
  - **임베디드 PGlite 0.5.1**(`@electric-sql/pglite`, in-process WASM, 실 Postgres SQL·pgvector-capable, 서버/creds 없음); 테스트 `:memory:`, 런타임 `workspace/index/pglite/`(gitignore). 실서버는 deferred.
  - 테이블 `events`+`nodes`+`edges`; `EdgeRow` 투영이 `supersedes`/`step_of`/`blocks`/`related_to`/`refs` 커버(결정적 sha256 edge id).
  - 순수 total `projectGraph(events)`가 per-axis fold 재사용(I/O·방출 0, god-fold 금지); PGlite는 dumb persistence.
  - rebuild = `TRUNCATE; bulk-insert` 단일 txn, 멱등(재실행→동일 checksum); `status()`가 DB-read 행에서 checksum 재계산 → **DB == pure projection**(keystone). 파생 캐시(정본 아님), 앱 SQLite와 별도 스토어.
- **Events/types added:** 없음 (read-only 투영).
- **INVARIANT-#1/#6 mechanism:** #1 — read-only 파생 캐시, `decision_*`/L0 write-path 0; `projectGraph` 순수 + negative test가 ingest의 이벤트 파일 생성 0(content-stable) 검증. #6 — governance 인덱스는 **별도 PGlite 스토어**, 앱 SQLite/마이그레이션 무변경; `bindings.ts` byte-unchanged(#4).
- **Code:** `governance/src/graph/{types,checksum,project,schema,store,ingest}.ts` + MCP `rebuild_index`/`index_status`/`graph_node`/`graph_neighbors`.
- **Deferred:** pgvector 임베딩(코퍼스 driven), `approvals`·`session_observations` 테이블, incremental upsert, 실 Postgres 서버 + keyring creds, Control Room consumer(H).

### Phase G — Context Steward / Handoff

- **Status:** ✅ Built · on dev · plan-critic + impl-critic(opus) ACCEPT 0 blockers · vitest 418
- **Goal:** handoff 연속성 축 + 순수 자문 Context Steward + 순수 hydration-bundle assembler — 긴 작업이 context 유지 없이 `checkpoint → handoff → hydrate`로 새 세션에서 이어짐.
- **Depends-on:** E (suggestion/observe substrate); F 그래프 인덱스 1-hop 이웃 read.
- **As-built design (essence):**
  - `handoff_*` lifecycle(`requested→validating→pending→invalid→consumed`) 순수 `deriveHandoffState` fold(fail-closed, terminal `consumed` 승) + `renderHandoffs`→`state/handoffs.json`.
  - `validateHandoff` = 7 필수 섹션(Mission/Completed/Current failing point/Important implicit knowledge/Next exact steps/Do not do/Open questions) 순수 구조 검사 → present+non-empty면 `validated`, 아니면 `invalid` + `missing[]`. 사람 게이트 없음(HITL은 결정 전용).
  - `computeContextPressure(runtimeSignals, log, now)` = 순수 자문 가중 점수(weights sum 1.0; token-ratio/turns/wall-clock/files + 이벤트유도 미해결 blocker/in-flight task/last-handoff-age). 임계 low<0.50/medium<0.70/high<0.85/critical≥0.85. **방출 0** — observer/hermes가 `session_context_pressure_changed` SSOT writer 유지.
  - `assembleBundle` = 순수 hydration core. **세탁 방지:** 모든 열린 `decision_blocked` + `autonomyEnvelope` 필드 운반, 해결된 blocker 제외, 번들 타입에 grant/approve/authority 필드 **없음**(property-tested). thin `hydrate` IO 셸이 git 요약 + F 인덱스 읽고 1 `handoff_consumed` 방출.
- **Events/types added:** `handoff_requested`·`handoff_drafted`·`handoff_validated`·`handoff_invalid`·`handoff_consumed` (압력 이벤트 신규 없음 — Steward는 자문).
- **INVARIANT-#1 mechanism:** Phase G 경로 전체가 `decision_*`/`task_*`/`session_*` 0 write; 유일 신규 쓰기는 `hydrate`의 1 `handoff_consumed`; fold/scoring/assembly 순수 total; hydration은 권한 확장 불가(authority 필드 없음, 열린 blocker 보존). negative test(consumed 위 2차 hydrate = 0 신규).
- **Code:** `governance/src/handoff/{handoff,validate,guards,handlers,project}.ts` · `governance/src/steward/{pressure,hydrate,hydrateIo}.ts`; MCP 6개(`request_handoff`/`draft_handoff`/`validate_handoff`/`hydrate`/`handoff_status`/`context_pressure`).
- **Deferred:** `handoff_archived` lifecycle; 실 per-session `AutonomyEnvelope` sourcing(placeholder); pgvector-ranked 번들 선택; 번들 파일 영속; UI(H).

### Phase H — Control Room UI (Slice 1)

- **Status:** ✅ Slice 1 Built · on dev (`83dddef..c614601`) · plan-critic + impl-critic(둘 다 opus) ACCEPT 0 blockers · gates cargo 448/clippy 0/fmt · tc 0/lint 0err(2 baseline)/vitest 238 · **잔여 = 라이브 `tauri dev` GUI 부팅 스모크(네이티브 WKWebView → 사용자/cmux)** + deferred 슬라이스
- **Goal:** read-only 인앱 Control Room — Boule 하네스의 파생 `state/*.json`을 thin specta-typed Tauri 커맨드 1개로 4 패널 렌더.
- **Depends-on:** E,F,G
- **As-built design (essence):**
  - read-only Rust file-read bridge(`snapshot.rs`): 파생 `governance/workspace/state/*.json` `read_to_string`(absent⇒empty · corrupt⇒terminal `AppError` · 최신 mtime⇒`generatedAt`); dir는 `WORK_RADAR_GOVERNANCE_WORKSPACE` override + compile-time default.
  - 단일 집계 커맨드 `get_control_room_snapshot()` → `Result<ControlRoomSnapshot, AppError>`(single round-trip, single specta type).
  - **앱 어디에도 governance 이벤트 로그 write/emit/append 경로 0** — 결정 레일이 앱 경계에서 구조적으로 도달 불가(INVARIANT #1), approval surface·rebuild 트리거 없음.
  - 4 패널: System Overview · Agent Session Board · Handoff Queue · Work(Task/Plan/Spec) Lists; blocked-task 배지는 `orchestrator.tasks[].hasOpenBlock` 구동.
  - 신규 `phase_enum!` 매크로: drift-resilient bare-string enum + `Unknown` fallback(specta rc.25가 `#[serde(other)]` 거부 → 신규 phase가 read 실패 대신 "unknown" degrade).
  - shadcn(`Card`/`Badge`/`Button`) + lucide + Tailwind v4 `--color-wr-*` 토큰, view-scoped `--cr-*`(단일 문서화 hex 예외); overlay 없음 ⇒ Esc 계약 무변경; View `"control-room"` 등록(palette/`Cmd+K`).
- **Events/types added:** 없음 (read-only viewer).
- **INVARIANT mechanism:** #1 구조적(유일 Rust 경로 `read_to_string`, write/emit 0); #4 `bindings.ts` cargo 재생성 + CI `git diff --exit-code`, drift 0; #6 앱 SQLite/마이그레이션 무변경; #7 shadcn+lucide+Tailwind v4 토큰. 별도 opus impl-critic 검증(self-approve 금지).
- **Code:** `src-tauri/src/governance/{mod,snapshot}.rs` · `src-tauri/src/commands/governance.rs` · `src/lib/controlRoom.ts`(+test) · `src/lib/query/governance.ts` · `src/components/control-room/{ControlRoomView.tsx,.css}`; 셸 `src/store.ts`·`src/lib/nav.ts`·`src/App.tsx`.
- **Deferred:** Spec/Plan 그래프 viz(governance-side `state/graph.json` export 필요 — Rust가 PGlite 못 읽음) · Timeline/Replay · approval/decision-queue 패널(기존 Hermes ADR-0007 카드 deep-link, action surface 아님) · 인앱 rebuild 트리거 · release-build 경로 해결 · auto-refresh · `generatedAt` staleTime drift(impl-critic minor).

### Phase I — Narrow opt-in auto (Type-2 only)

- **Status:** 📍 Designed (spec rev.2) + plan + plan/re-critic ACCEPT 0 blockers · **implementation PARKED (미빌드)** · **유일한 미빌드 Phase**
- **Goal:** Orchestrator의 빈약한 *execute* half — opt-in·on-demand `auto_dispatch`가 사람-채택 plan을 Phase-C `conduct_plan`로 1스텝 자동 전진(deny-by-default, `decision_*` 0 mint).
- **Depends-on:** E (read half), G (continuity) + envelope/conductor (C); A–G fold 재사용.
- **Planned design (essence):**
  - opt-in `BOULE_AUTO_MODE=type2`(기본 `off`); `off`⇒거부·방출 0(mode 레벨 deny-by-default).
  - on-demand 단일 패스 — `auto_dispatch`가 `active` plan을 순회해 ready한 것을 Phase-C `conduct_plan`로 **1스텝**(데몬/poll/watcher 없음, plan당 패스당 ≤1).
  - 순수 deny-by-default Safety Gate(`evaluateAutoDispatch`, G0–G3: mode→accepted→not-halted→ready-cursor)가 silent no-op 대신 설명된 `action_denied` 기록.
  - **conductor-advanceability**(사람-채택 plan) 기반, E 제안 기반 아님(E는 자문 유지; suggestion-mediated dispatch는 fork F2).
  - dispatch 감사 trail; dedup은 **materialization(`step_bound`)** 키(intent 이벤트 아님) → 부분실패가 스텝 poison 대신 재-dispatch(M2).
  - `decision_*` 0 write — 구조적(결정 핸들러 import 0) **+** negative test. timeout/default/skip 없음; Type-1 → spawn 세션 `decision_blocked` + 영속 halt. headless stdio MCP — UI 없음, `bindings.ts` byte-unchanged.
- **Events/types added (planned):** `instruction_planned`·`orchestrator_action_executed`·`orchestrator_action_failed`·`action_denied` (verdict-free, `source/actor:"system"`).
- **INVARIANT-#1 mechanism:** 4 독립 구조 가드 — (1) 결정 핸들러 import 0(verdict-tool 부재); (2) `active`⇔`plan_accepted`(actor user)로 사람-채택만; (3) opt-in 플래그는 dispatch를 게이트할 뿐 approval 아님 — `canApprove`/`canComplete`/`canAdvance`는 mode 인자 없음; (4) timeout-free 상속 halt-on-block.
- **Implementation:** 미구현 — spec+plan만 커밋(`governance/src/orchestrator/dispatch/` 코드 없음). Build = TDD 5태스크(event types→순수 gate→config→IO shell→MCP wiring + 구조 negative) → 별도 impl-critic(opus) ACCEPT → 라이브 `BOULE_AUTO_MODE=type2`+`BOULE_CONDUCTOR_MODE=live` smoke(사용자).
- **Deferred / next:** 빌드 자체(사용자 "build it" 게이트). forks: F1 hardened in-worktree path-glob; F2 suggestion-mediated dispatch(`(planId,stepIndex)` body 재사용); F4 Control Room dispatch 패널(H). ADR 후보: orchestrator/dispatcher 결정-레일(`decision_*` write-path 0)을 `docs/adr/` + `decision-rails.md` 한 줄로 승격.

---

## 8. State machine 원칙 (god-fold 금지)

축마다 fold 하나(`deriveDecisionState`/`deriveTaskState`/`derivePlanState`/`deriveSpecState`/`deriveSessionState`/`deriveHandoffState`/`deriveConductorState`),
각자 소유 안 하는 이벤트 타입은 무시(**fail-closed type filter**). 한 flat union이 비대해지면 fold 분리가 흐려지므로 Phase별로만 추가.
**Decision/Approval**(기존 v1/v2): Type 0 pending → Type 2 자동 가능 / Type 1 guarded → external review(≥2 distinct-model quorum) → human gate.

---

## 9. 마스터 Phase 시퀀스 (상태)

| Phase | 슬라이스                                              | Depends-on        | DB       | UI       | 상태                          |
| ----- | ----------------------------------------------------- | ----------------- | -------- | -------- | ----------------------------- |
| **A** | Task lifecycle SSOT                                   | BUILT substrate   | 없음     | 없음     | ✅ on dev                     |
| **B** | Plan event-sourcing + Planner                        | A                 | 없음     | 없음     | ✅ on dev                     |
| **B2**| Spec lifecycle                                       | A                 | 없음     | 없음     | ✅ on dev                     |
| **C** | Conductor + autonomy-envelope (cmux 1-step spawn)    | B + escalation    | 없음     | 없음     | ✅ on dev                     |
| **D** | Session Registry + cmux Observer (read-only)         | C                 | 없음     | 없음     | ✅ on dev                     |
| **E** | Orchestrator projector — observe/suggest only        | A,B,C,D           | 없음     | 없음     | ✅ on dev                     |
| **F** | Graph index (PGlite; events+nodes+edges)             | E (corpus-driven) | **여기** | 없음     | ✅ on dev (pgvector deferred) |
| **G** | Context Steward / Handoff continuity                 | E                 | —        | 없음     | ✅ on dev                     |
| **H** | Control Room UI (4 패널, specta IPC)                 | E,F,G             | —        | **여기** | ✅ Slice 1 on dev (라이브 GUI smoke 잔여) |
| **I** | 좁은 opt-in auto (Type-2·in-envelope만)             | E,G + envelope(C) | —        | —        | 📍 designed, **impl PARKED**  |

점진 도입 — 막히는 지점에서만 다음 계층. 각 Phase는 별도 spec + plan + critic ACCEPT(별도 패스, self-approve 금지) 후 다음.

---

## 10. 확장 이벤트 타입셋 (Phase별 점증)

- **spec/plan(B/B2):** `spec_proposed`·`spec_accepted`·`spec_archived` · `plan_proposed`·`plan_accepted`·`plan_revised`·`plan_completed`·`plan_archived`·`plan_superseded` (`plan_drift_detected` 미구현)
- **task(A):** `task_started`·`task_blocked`·`task_completed`·`task_cancelled`
- **conductor(C):** `step_bound`·`session_spawned`
- **session(D):** `session_open_requested`·`session_opened`·`session_observed`·`session_waiting`·`session_blocked`·`session_context_pressure_changed`·`session_checkpoint_requested`·`session_handoff_ready`·`session_close_requested`·`session_closed`·`session_crashed`·`session_recovered`
- **orchestrator(E):** `orchestrator_suggestion_created`
- **handoff(G):** `handoff_requested`·`handoff_drafted`·`handoff_validated`·`handoff_invalid`·`handoff_consumed`
- **auto-dispatch(I, planned):** `instruction_planned`·`orchestrator_action_executed`·`orchestrator_action_failed`·`action_denied`

> 한 flat union이 비대해지면 fold 분리가 흐려진다(§8). Phase별로만 추가.

---

## 11. INVARIANT Compliance (decision-rails — 리뷰 바)

| #   | INVARIANT                    | Posture                                                                                                                                       |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 자동화 → 결정 레일 침투 금지 | 구조적: 모든 모듈/세션은 propose/block만; `decision_*` write-path 0; `approve`=`actor:user`+`canApprove`; timeout→blocked; phase별 negative test. |
| 2   | 외부 토큰 keychain           | Telegram 자격증명은 `~/.hermes` fabric(레포 밖); (예정)Postgres creds keyring; Boule은 토큰 미보유.                                          |
| 3   | 외부 네트워크 Rust           | 네트워크 호출은 기존 Python fabric/`github.rs`; Boule(TS)·governance 서비스는 로컬 이벤트/PGlite.                                            |
| 4   | IPC = specta 생성            | Governance MCP=stdio(비대상). Control Room(H) 신규 커맨드/타입만 specta, drift CI 게이트 0. A–G 변경 0.                                       |
| 5   | bounded retry                | escalation=event-driven+human-gated; 사이드카 폴링 루프 없음; ingest/observe/recovery는 on-demand 단발 + bounded.                            |
| 6   | SQLite 마이그레이션만        | governance=별도 PGlite(앱 sqlite 무변경). A–E는 DB 없음. spawn 세션은 worktree 격리.                                                         |
| 7   | 시각 디자인 DESIGN.md        | A~G UI 없음. Control Room(H)은 shadcn+lucide+Tailwind v4 토큰.                                                                                |

INVARIANT 검증은 **별도 reviewer 패스**(critic) — self-approve 금지.

---

## 12. Top Risks → 완화

1. **투영 권위 누수(최고)** — projector/orchestrator가 이벤트 방출/verdict minting. → 투영은 순수·total·I/O 0·방출 0; negative test; `actor:"user"` 하드핀.
2. **Conductor 미구축인데 그 위에 orchestrator.** → 시퀀스가 Conductor(C)를 multi-module orchestrator(E) 앞에 배치(완료).
3. **Postgres-now가 상시 ops 부담.** → PGlite in-process 첫 cut, 실서버/pgvector 최후.
4. **이중 SSOT 드리프트**(렌더 ↔ 이벤트 손편집). → `GENERATED` 마커 + property test + gitignore + CI drift.
5. **인앱 Control Room dev-DB skew / bindings drift.** → governance 스토어 앱 sqlite와 분리; UI는 thin specta IPC(drift CI 게이트); UI는 최후 Phase.
6. **이벤트 타입셋 폭발.** → 축마다 fold 하나, fail-closed; Phase별 점증.
7. **autonomy-envelope 장식적.** → envelope 스키마 + per-session 경로 권한은 Phase C critic-accepted(advisory; hardened 강제는 F1 deferred).
8. **context handoff가 ambiguity 세탁.** → handoff가 미해결 blocker+envelope 보존; hydration 권한 확장 불가(property-tested).
9. **additive-on-v2가 평행 구현으로 변질.** → v3가 v2 substrate를 _감싼다_; 동치 증명 전 교체 없음.

---

## 13. Distribution / Verification

- **분배:** `/omc-teams`(CLI tmux)는 cmux에서 startup 스톨 이력 → 기본은 **네이티브 병렬 에이전트**. 병렬 격리 주의(worktree 교차오염 이력 → 순차 또는 경로 분리; executor late-writes → 커밋 전 git status).
- **검증:** governance vitest(fold·projection 순수성·rebuild 멱등, 현 **418**); work-radar 변경분(Phase H IPC)은 `cargo test`+clippy+fmt / `pnpm typecheck`+lint+vitest / bindings drift 0 / `pnpm tauri dev` 부팅. INVARIANT 7개 별도 critic 패스. 실행 못 한 검증은 "could not run" ≠ "passed".

---

## 14. Provenance / Open Items

- **두-모델 컨설트(2026-06-02):** codex(codex-cli 0.135.0) + opus architect. 합의 = 두 직교 축 · execution plane 권위 없음 · 이벤트만 가변 진실 · orchestrator 승인 불가 by-construction · timeout→blocked · Phase A Postgres 의존 0 + property test · Conductor를 orchestrator 앞에 시퀀싱. 발산(해소): Phase A 범위 = opus(Task만) 채택; Postgres 타이밍 = Phase F.
- **남은 forks(Phase plan에서 해소/연기):** Boule↔Telegram 브릿지 seam(v2 권고 (a)) · autonomy-envelope hardened 강제(F1) · Postgres 실서버/pgvector(F) · Control Room 권한 surface 상세/dispatch 패널(H/I).
- **ADR 후보:** ADR-0007 companion(two-surface HITL) · orchestrator/dispatcher 결정-레일(spawn 세션 강제 escalation; `decision_*` write-path 0).

---

## 15. Consolidation note (2026-06-04)

이 문서는 **단일 v3 정본**이다. 2026-06-04에 per-phase 설계 문서 9개(`...phase-b/b2/c/d/e/f/g/h/i-design.md`)를
§7 Phase Ledger로 흡수하고 그 파일들은 삭제했다(git 히스토리에 보존). 각 Phase의 **상세 구현 플랜**은
`governance/docs/plans/2026-06-0x-boule-v3-phase-*.md`에 그대로 있다. **v1/v2 설계 + pre-v3 슬라이스 스펙**은
`design/`에 historical로 남아 있다(`INDEX.md`의 계보 참조). v3 작업 컨텍스트는 이 파일 하나만 참조하면 된다.
