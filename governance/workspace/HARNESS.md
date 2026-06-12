# Boule — Harness 운영 지침 (durable)

> **위치 주의 (2026-06-12):** 이 문서가 사는 `governance/workspace/`는 **2026-06-02 동결된
> 레거시 워크스페이스**다(라이브 = per-repo `<repo>/.boule/workspace`, ADR-0009). 이 문서
> 자체는 durable 규칙으로 **현역**이며 모든 workspace(per-repo 포함)에 적용된다 —
> `governance/docs/harness/`로 이동 예정(`../docs/STATUS.md` P5a).

이 문서는 boule workspace 안에서 행동하는 **모든 에이전트/세션**(Gateway, Guardian, Reviewer,
Pattern Detector, Planner, Conductor, Orchestrator, …)이 따르는 **레포 전역 durable 규칙**이다.
아키텍처 정본은 설계 docs(§아래 인덱스), 7 INVARIANT 정본은 `docs/areas/decision-rails.md`.
이 파일은 그 규율을 workspace 행동 규칙으로 압축한다 — 규칙을 중복하지 않고 가리킨다.

## 0. Mission

work-radar를 *어떻게 만드는가*(결정/패턴/원칙/실행)를 관장하는 **자기 관찰형 dev-거버넌스
하네스**. 제품 런타임 신호(signals/agent_runs)는 대상이 아니다. 재귀적 우아함: work-radar를
닮은 시스템이 work-radar가 만들어지는 과정을 관찰한다.

## 1. 두 직교 축 — 하나의 append-only 이벤트 스토어 위에

- **인식론적 사다리 (L0–L4)** — *프로젝트가 무엇을 참이라 믿는가*.
  `events/` → `patterns/` → `hypotheses/` → (L3 decisions=`docs/adr`+`docs/decisions.md`)
  → (L4 principles=`docs/areas/decision-rails.md`).
- **실행 평면 (Spec → Plan → Task → Session → Handoff)** — *지금 어떤 작업이 흐르는가*.
  같은 L0 스토어에 라이딩. **verdict 권위를 일절 갖지 않는다.**

> **Decision은 의도를 추구할 _권한_을 부여한다. Plan은 그 의도를 _분해_한다.**
> **Task는 그 분해를 _실행_한다. 이벤트만이 유일한 가변 진실(mutable truth)이다.**

## 2. Write-first rule (가장 중요한 기계적 규율)

- **쓰기는 항상 markdown 이벤트가 먼저.** 인덱스/투영/캐시는 그 뒤(파생, 비동기).
- 손상 시 markdown(`events/`)만으로 완전 재구축 가능해야 한다.
- 런타임에 상태를 묻지 않는다 — **상태를 이벤트에 적고, 런타임은 관찰해서 보정**한다.
- 무언가를 실행하기 전에 이벤트를 쓴다: `instruction_planned` → 안전점검 → `instruction_sent`;
  `session_close_requested` → close-guard → `session_closed`; `handoff_requested` → `checkpoint_requested` → `handoff_validated`.

## 3. Keystone invariant — 상태는 파생물이다 (절대 손으로 안 고친다)

> Task/Plan/Session/Handoff의 경로 segment·frontmatter `status:`는 **DERIVED**다. 이벤트 fold를
> 읽는 projector만 그것을 쓴다. **어떤 명령·에이전트·사람도 `status:`를 직접 편집하지 않는다.**
> `tasks/`(등 파생 디렉토리)를 통째로 지워도 projector 재실행이 bit-for-bit 재구성한다.

- 파생 디렉토리(`plans/ tasks/ sessions/ handoffs/`)의 생성 `<id>.md`는 gitignore(`.gitkeep`만 추적).
- **Spec 본문은 사람이 저술**(`specs/`, ADR 본문과 동일 성격) — 산문은 event-source 하지 않고
  *lifecycle*(`spec_drafted`→`spec_accepted`)만 이벤트.
- projector는 순수·total·I/O 0·**이벤트 방출 0**. 이벤트를 방출하는 projector = 아키텍처 냄새 → 리뷰 실패.
- **체크박스 vs 상태 머신 (혼동 금지):** 구현 플랜(`docs/plans/*.md`)의 `- [ ]` 체크박스는
  **사람의 빌드 추적용** — 오케스트레이터는 이것을 읽지 않는다. 오케스트레이터가 이해하는
  "완료"는 **`task_completed` 등의 이벤트 → fold된 `phase`**다. 런타임 진척은 항상 이벤트가 정본;
  체크박스를 오케스트레이터 입력으로 쓰면 이 keystone invariant 위반.

## 4. 승인 불가능 by-construction (INVARIANT #1 기계화)

- 모든 에이전트/세션/오케스트레이터 모듈은 **propose-only**. `decision_*` verdict write-path = 0.
- verdict는 `approve()`/`reject()`/`choose()`만 minting하며 전부 **`actor:"user"` 하드핀 + `canApprove`**(distinct-model 리뷰 quorum). 게이트 함수엔 mode 파라미터가 없다 — auto 모드가 게이트를 무력화하지 못한다.
- **승인 엔드포인트는 에이전트 MCP stdio에 미노출.** `propose_*` ↔ `approve_*`는 API 레벨에서 분리.
- Safety Gate는 **deny-by-default** → 거부 시 `action_denied` 방출.
- 모든 액션은 `actor`/`authority_decision_id`/`task_id`/`session_id`를 기록(append-only audit).

## 5. Escalation, not automation

- 에이전트는 **사전 인가된 autonomy envelope** 안에서만 진행한다. 경계를 넘는 순간 →
  **`decision_blocked` 방출 후 halt**. 세션은 결정하지 않는다; *결정이 필요함을 관찰*해 기록한다.
- **`decision_blocked`에는 auto-resolution도 timeout-default도 없다 — 영원히 halt.**
  세션을 bound(kill/checkpoint)하되 **결정을 bound하지 않는다.** 지연이 곧 기능이다.
- 모호하면 보수적으로 차단(Type 0 pending). Type-1 재분류는 Guardian(사람 게이트).

## 6. Type 0 / 1 / 2

- **Type 0 = pending/unresolved** (`phase:proposed, verdict:null`). holding state — Type 2 / Type 1 후보 / plan revision / task cancel / 사람 지시 / no-op로 해소.
- **Type 1 (비가역)** = 새 ADR / INVARIANT 변경 → **외부 리뷰 + 사람 승인 필수**(self-approve 금지).
- **Type 2 (가역)** = `docs/decisions.md` 한 줄 트레이드오프 → 자동 진행 가능.
- "auto" 모드가 무인으로 할 수 있는 건 **이미 사람-승인된** plan step의 bounded 세션 spawn + 가드 통과 **Type-2 in-envelope** task 전이 + 관찰/제안/audit뿐. **의도적으로 빈약(anemic)**.

## 7. 권한 모델 (per-agent ALLOWED_PATHS)

각 에이전트는 `agents/<name>.md` 명세서에 선언된 경로에만 쓴다(신뢰 경계의 핵심).

| 에이전트 | 쓰기 | 비고 |
| --- | --- | --- |
| Gateway | `events/` | 레포 활동 → L0 |
| Type 1 Guardian | (차단/보고만) | verdict 직접 쓰기 금지 |
| External Reviewer | `reviews/` | 작성자 ≠ 리뷰어 |
| Pattern Detector | `patterns/` | L0→L1 |
| Hypothesis Tester | `hypotheses/` | (미구축) |
| Meta Observer | (PR 초안만) | decision-rails 진화 PR |
| Archive Pruner | `*/archived/` 이동 | (미구축) |
| Planner | `plans/proposed/`(투영)·`events/` | 1 intent → 1 draft plan (Phase B) |
| Conductor | `sessions/`·`events/`(envelope 내) | 디스패처, approve 능력 0 (Phase C) |
| Orchestrator | 제한적 `tasks/`·`sessions/`·`events/` | propose-only; principles 직접 수정 금지 |

## 8. bounded retry / 로그 / 망각

- **bounded retry only** — backoff+jitter, terminal failure 노출, 무한 poll 금지(INVARIANT #5).
- **로그 PII/시크릿 금지** — 외부 응답은 코드+크기만; 프롬프트/응답 본문 로그 X.
- **망각** — Archive Pruner가 stale events/patterns/expired hypotheses를 `*/archived/`로 이동, 인덱스 재구축.

## 9. 디렉토리

`workspace/README.md`의 레이아웃 표 참조. 요점: `events/`만이 L0 진실; 그 외 디렉토리의
상태는 전부 그로부터 파생. L3/L4는 여기 복제하지 않고 `docs/`의 정본을 어댑터가 인덱싱.

## 10. 설계/계획 인덱스 (정본 문서)

- v1 설계: `governance/docs/design/2026-05-31-ssot-governance-harness-design.md`
- v2 설계(HITL plan→exec→escalation): `governance/docs/design/2026-06-01-ssot-governance-harness-hitl-plan-loop-design.md`
- **v3 설계(Orchestrator Control Plane)**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md`
- 전체 거버넌스 spec/plan 목록: `governance/docs/INDEX.md`
- 7 INVARIANT 정본: `docs/areas/decision-rails.md`
