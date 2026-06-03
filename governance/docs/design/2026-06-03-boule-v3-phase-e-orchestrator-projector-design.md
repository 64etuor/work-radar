# Boule v3 Phase E — Orchestrator Projector (observe/suggest only) — design spec

- **Phase:** v3 마스터 Phase **E** (master design `design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` §4/§10/§11).
- **Depends-on:** A(task lifecycle) · B(plan/spec) · C(conductor/envelope) · D(session registry/observer) — 전부 ✅ DONE.
- **DB:** 없음 · **UI:** 없음 · **bindings.ts:** 변경 0.
- **상태:** 🆕 설계 (이 슬라이스 = Phase E 첫 슬라이스).

## 0. Problem & Framing

Phase A–D는 task/plan/spec/session을 각자 **이벤트-소스 fold**로 투영한다. 하지만 아무도 그
fold들을 **가로질러** 보지 않는다 — "active task인데 세션이 없다", "이 세션은 컨텍스트 압력이
높아 checkpoint가 필요하다" 같은 **교차 관찰**은 현재 어떤 모듈도 만들지 않는다.

Phase E는 그 교차 관찰을 만드는 **Orchestrator의 읽기 절반**이다. Orchestrator는 master §4.1의
"또 하나의 propose-only 에이전트"이며, 이 슬라이스는 그중 **Event Reader · State Projector ·
Policy Evaluator**만 구축한다. 실행 절반(Scheduler · Session Manager · Action Dispatcher =
`session_*`/`task_started` 방출)은 **Phase I**로 미룬다.

### 0.1 가장 중요한 설계 선택 (master §4 정합)

> **Orchestrator는 승인 불가능하도록 by-construction.** 이 슬라이스의 신규 쓰기 권한은 **단
> 하나** — verdict 없는 `orchestrator_suggestion_created` (suggestion-class) — 뿐이다.
> `approve`/`choose`/`decision_*`/`task_*`/`session_*` write-path는 **0**이며 negative test로 강제한다
> (INVARIANT #1).

### 0.2 Settled (브레인스토밍에서 사용자 확정 — 재론 금지)

- 규칙 세트 = **5개** (핵심 2 + drift 3, §3).
- dedup = `(ruleId, subjectId)` 키가 로그에 이미 있으면 skip → 멱등. **조건 해소-후-재발생 재제안은
  이 슬라이스에서 미지원**(라이프사이클은 다음 슬라이스). 사용자 수용.
- 신규 이벤트 타입 = `orchestrator_suggestion_created` **단 하나**. 설계 §11의
  `instruction_*`/`orchestrator_action_*`/`action_denied`/`projection_rebuilt`는 dispatch 측 →
  Phase I로 연기.

## 1. 도메인 모델 — Orchestrator View (파생, 권위 없음)

`OrchestratorView`는 **정본이 아니다.** 기존 fold들의 순수 join이며, `state/`를 지워도 이벤트
로그에서 byte-identical 재구성된다(keystone invariant, master §2.2).

```
TaskView { state: TaskState; hasOpenBlock: boolean }   // hasOpenBlock = task/handlers.hasOpenBlock(all, taskId)

OrchestratorView {
  tasks:    TaskView[]        // projectTasks(all) + per-task hasOpenBlock
  plans:    PlanState[]       // projectPlans(all)
  sessions: SessionState[]    // projectSessions(all)
}
```

> **as-built 주(2026-06-03):** open-blocked-decision은 별도 `openBlockedDecisions[]` 컬렉션이 아니라
> **task별 `hasOpenBlock: boolean`**으로 들고 있다(5규칙은 "이 task에 열린 block이 있나?"만 묻고 decision
> id 리스트가 필요 없다). decision id 리스트가 필요한 다음 슬라이스(UI/규칙)에서 view를 확장한다.

- task↔session 바인딩은 `SessionState.taskId`로 읽는다(Phase C spawn `related_to[0]`, Phase D 그대로).
- "미해소 decision_blocked" 판정은 **기존 `task/handlers.hasOpenBlock(all, taskId)`를 재사용**한다
  (Phase A `canComplete`의 INVARIANT #1 결합과 동일 함수 — 중복 fold 아님). `hasOpenBlock`은 내부에서
  `deriveDecisionState`로 verdict 없는 `decision_blocked`만 open으로 본다(god-fold 금지 — Orchestrator는 결정 fold를 **읽기만**).

## 2. 컴포넌트 (신규 `src/orchestrator/`)

| 파일 | export | 역할 | 순수성 |
| --- | --- | --- | --- |
| `view.ts` | `projectOrchestratorView(all: GovEvent[]): OrchestratorView` | 기존 fold + per-task `hasOpenBlock` join | **순수** (I/O·emit 0) |
| `policy.ts` | `evaluateSuggestions(view: OrchestratorView): SuggestionCandidate[]` | §3의 5개 규칙. table-driven, 결정적 정렬(`(ruleId, subjectId)` localeCompare) | **순수** (I/O·emit 0) |
| `suggest.ts` | `suggest(workspaceDir, now, rand): Promise<SuggestSummary>` | read→view→evaluate→dedup→`orchestrator_suggestion_created`만 at-most-one emit. observer.ts 미러 | 비순수(경계 1곳) |
| `project.ts` | `renderOrchestrator(workspaceDir): Promise<string>` · `listSuggestions(workspaceDir): Promise<OpenSuggestion[]>` | `state/orchestrator-view.json` 렌더(keystone 테스트 대상) + open suggestion 리스트 | 렌더/read만 |

`SuggestionCandidate { ruleId: RuleId; subjectId: string; subjectType: "session"|"task"; detail: string }`

`RuleId = "session_checkpoint" | "task_needs_session" | "session_stale" | "task_blocked_decision" | "orphan_session"`

## 3. 5개 규칙 (전부 advisory, master §4.3 anemic-auto 정합)

각 후보 키 = `(ruleId, subjectId)`. 전부 `evaluateSuggestions`의 순수 함수.

| ruleId | 발화 조건 | subject | detail (요지) | 근거 |
| --- | --- | --- | --- | --- |
| `session_checkpoint` | session.phase = `context_pressure_high` | session | "checkpoint 필요" | §10 done #1 |
| `task_needs_session` | task.phase = `active` AND 그 task에 바인딩된 non-closed session 없음 | task | "세션 열어야" | §10 done #2 |
| `session_stale` | session.phase ∈ active류(non-terminal, non-pre-birth) AND session.taskId의 task.phase ∈ {`done`,`cancelled`} | session | "세션 닫기 제안" | no-auto-close(§18.3) — 제안만 |
| `task_blocked_decision` | task가 non-terminal AND 그 task id가 어떤 미해소 `decision_blocked`의 related_to에 포함 | task | "사람 주목 필요" | INVARIANT #1 coupling |
| `orphan_session` | session.phase ∈ active류 AND taskId === null AND ownership = `external_owned` | session | "고아 세션 주목" | observer orphan(§18.4) 후속 관찰 |

> "active류" = `SessionState.phase` 중 pre-birth(`planned`/`opening`)·terminal(`closed`)을 제외한
> 모든 것: `active`/`waiting`/`blocked`/`context_pressure_high`/`checkpoint_requested`/`handoff_ready`/
> `recovering`. (observer.ts `ALIVE_OBSERVED`와 동일 집합 + 의미 일치.)

규칙 간 우선순위·억제 없음(슬라이스 1) — 한 subject가 여러 규칙을 동시 발화하면 각각 별도 키로
방출된다(예: stale session이 checkpoint도 필요하면 둘 다). 억제·우선순위는 라이프사이클 슬라이스로 연기.

## 4. 이벤트 + dedup / 멱등 (observer.ts 미러)

신규 이벤트 (`event/event.ts` `EventType` union에 1개 추가):

```
orchestrator_suggestion_created   // suggestion-class; source=system, actor=system; verdict 없음
```

이벤트 형태:
- `frontmatter.type = "orchestrator_suggestion_created"`, `source: "system"`, `actor: "system"`,
  `tags: ["orchestrator", "suggestion"]`, `related_to: [subjectId]`.
- `body` = canonical JSON `{ "rule": <ruleId>, "subject": <subjectId>, "subjectType": <"session"|"task">, "detail": <string> }`.

`suggest` 알고리즘 (observer `observeSessions` 미러):
1. `readAllEvents` → `projectOrchestratorView` → `evaluateSuggestions` = 후보 리스트.
2. 기존 `orchestrator_suggestion_created` 이벤트에서 `(rule, subject)` 키 집합 = `existing`.
3. 후보 중 키가 `existing`에 없는 것만 emit (at-most-one per 키). per-emission `now + i*1000` 오프셋
   스탬프 → 한 패스에서 distinct 시간순 id (observer와 동일).
4. `SuggestSummary { created: number; skipped: number }` 반환.

멱등: run1 = N emit, run2 = 0 emit(모든 키가 `existing`). observer "orphan auto-register ONCE"와 동형.

**알려진 슬라이스-1 한계(문서화):** 조건이 해소됐다 재발생해도(high→normal→high) 키가 이미 있어
재제안하지 않는다. suggestion 라이프사이클(`orchestrator_suggestion_acknowledged`/`_dismissed` +
조건-해소 시 re-arm)은 **다음 슬라이스**로 연기. observer가 close를 별도 슬라이스로 미룬 것과 동일 규율.

## 5. MCP 명령 (stdio — INVARIANT #4 비대상)

- `suggest` — on-demand 제안 방출. observe_sessions 미러. verdict 0이라 **executor-role gate 비대상**
  (등록 위치는 observe_sessions와 동일, gated 블록 밖). `BOULE_OBSERVER_MODE` 같은 env 의존 없음
  (cmux 안 건드림 — fold만 읽음). 결과: `created N / skipped M`.
- `suggestions` — open suggestion 리스트 (read-only). `listSuggestions` 위임.

"open suggestion" 정의(슬라이스 1) = 로그의 모든 `orchestrator_suggestion_created`
(dismiss/acknowledge 이벤트가 없으므로 전부 open). 라이프사이클 슬라이스에서 필터 추가.

## 6. Storage Layout

master §5 그대로 — 신규 디렉토리 없음. `state/orchestrator-view.json`(파생 렌더, gitignore 고려는
master §2.2의 `tasks/` 정책 따름 — 슬라이스 1은 `state/` 캐시만, 별도 디렉토리 생성 없음).

## 7. 관찰 가능 Done-criteria (산문 아닌 증거)

1. crafted 이벤트 시퀀스(active task, 세션 없음)에 `suggest` → `task_needs_session` 1개 방출;
   `suggestions`가 그것을 표시.
2. session `context_pressure_high` 이벤트 → `suggest` → `session_checkpoint` 1개 방출.
3. 5개 규칙 각각 fire/no-fire가 `policy.test.js` table-driven으로 green.
4. `suggest` 2회 연속(상태 무변경) → 2회차 `created: 0`(멱등).
5. **negative test:** `suggest`가 어떤 `decision_*`/`task_*`/`session_*` 이벤트도 쓰지 않음
   (방출 타입은 `orchestrator_suggestion_created` 하나뿐) — INVARIANT #1 구조 증명.
6. **property test:** `renderOrchestrator` → `state/` wipe → 재실행 → byte-identical(파생-not-authored 증명).
7. vitest green; Postgres 없음; `bindings.ts` 변경 0(MCP stdio).

## 8. INVARIANT Compliance (decision-rails — 별도 critic 패스)

| # | INVARIANT | Posture |
| --- | --- | --- |
| 1 | 자동화 → 결정 레일 침투 금지 | 구조적: 신규 write 권한 = `orchestrator_suggestion_created`(verdict 없음)뿐; `decision_*` write-path 0 → negative test. projector 순수·emit 0. |
| 2 | 외부 토큰 keychain | 해당 없음(토큰 미사용). |
| 3 | 외부 네트워크 Rust | 해당 없음(로컬 이벤트 fold만; cmux/네트워크 호출 0). |
| 4 | IPC = specta 생성 | MCP=stdio 비대상; `bindings.ts` 변경 0. |
| 5 | bounded retry | `suggest`=on-demand 1패스, poll 루프 없음. |
| 6 | SQLite 마이그레이션만 | DB 없음(인메모리 fold + `state/` json 캐시). |
| 7 | 시각 디자인 DESIGN.md | UI 없음. |

INVARIANT 검증 = **별도 reviewer 패스(critic)** — self-approve 금지.

## 9. Top Risks → 완화

1. **투영 권위 누수(최고)** — projector/policy가 이벤트 방출/verdict minting. → `view.ts`/`policy.ts`는
   순수·total·I/O 0·방출 0; 방출은 `suggest.ts` 경계 1곳에서 suggestion-class만; negative test.
2. **god-fold** — Orchestrator가 결정/세션 fold를 재구현. → 기존 `deriveDecisionState`/`projectSessions`/
   `projectTasks`/`projectPlans`를 **읽기만**; 자체 fold 없음.
3. **suggestion flood** — 매 패스 같은 제안 재방출. → `(ruleId, subjectId)` dedup(observer no-flood 미러);
   멱등 테스트.
4. **dispatch 누수** — 슬라이스 1이 session/task를 전진. → 신규 이벤트 타입 1개(suggestion-class)뿐;
   `instruction_*`/action 이벤트는 union에 추가조차 안 함(Phase I).

## 10. Provenance / Open Items

- **브레인스토밍(2026-06-03):** 규칙 세트 = 권장안(핵심 2 + drift 3) 사용자 채택; dedup 라이프사이클
  연기 사용자 수용.
- **다음 슬라이스 후보:** suggestion 라이프사이클(acknowledge/dismiss + 조건-해소 re-arm) ·
  규칙 우선순위/억제 · Phase F(Postgres 인덱스) · Phase G(Context Steward, suggestion → handoff 트리거 소비).
- master §11의 dispatch 이벤트셋(`instruction_*` 등)은 의도적으로 이 슬라이스 범위 밖(Phase I).
