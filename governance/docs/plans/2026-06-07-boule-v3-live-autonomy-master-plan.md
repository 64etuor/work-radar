# Boule v3 — Live Autonomy Master Plan (spec/plan → 자율 cmux+claude/codex 실행 입증)

- **Date**: 2026-06-07
- **Author**: claude (Opus) — 2-brain 의도(codex:1 claude:1)로 착수, codex `exec` headless 2회 inconclusive(known flakiness) → claude 합성. **모든 상태 주장은 `dev`(`56ca525`) git 증거로 검증**(메모리 아님).
- **Canonical v3 reference**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md`
- **이 플랜의 위치**: 위 v3 설계의 **A–I가 dev에 빌드+유닛테스트 완료**된 상태에서, 사용자 확정 목표("라이브 자율 루프 입증" + "codex 동급 executor")를 향한 **연속 실행 큐**. 2026-06-04 continuation 플랜(로컬-only, 라이브=외부잔여)을 **의도적으로 한 단계 넘어선다** — 단 push/merge/deploy/credential은 여전히 사용자 게이트.

---

## 0. 한 줄 요약 / 사용자 확정

**기반(architecture)은 ~90% 완성이다. 빠진 건 "라이브 실증"과 "codex executor 배선"이다.**

- ✅ Spec/Plan/Task lifecycle, Conductor(cmux spawn), Session Observer, Orchestrator suggest, narrow auto_dispatch, Context Steward/Handoff, Graph index, Control Room UI Slice 1 — **전부 dev에 머지 + 유닛테스트(~vitest 441)**.
- ❌ **라이브 루프 0회 실행**: `BOULE_CONDUCTOR_MODE=live` + `BOULE_AUTO_MODE=type2` + 실제 cmux spawn + 실제 세션이 작업하고 `task_completed`를 observer로 회수하는 end-to-end가 한 번도 안 돌았다(stub adapter 유닛테스트만).
- ❌ **Conductor는 `claude` 전용**(`governance/src/conductor/adapter.ts:141`). codex는 분리된 인앱 substrate(`agent.rs`)에만 있고 **오케스트레이션 디스패치 대상이 아님**.

사용자 확정(2026-06-07):
1. **목표 = 라이브 자율 루프 입증**(외부잔여 선을 넘는다).
2. **codex를 동급 executor로** 같은 worktree+envelope substrate 위에서 dispatch.
3. **범위 = Boule 오케스트레이션만.** 인앱 codex 잡 러너(`agent.rs` ~70%, Phase 9c mismatch-draft, diff viewer)는 **별도 트랙**(이 플랜 비대상, §9 한 줄 참조만).

### 0.1 자율의 경계 (재확인 — INVARIANT #1)

"에이전트가 알아서 판단해서 진행"은 **plan 채택 이후**의 자율이다. 사람 게이트는 그대로 load-bearing:

> spec 저술 → `accept_spec`(user) → Planner가 `plan_proposed` → **`accept_plan`(user, scope/risk 동의)** → **여기부터 자율**: auto_dispatch가 채택된 plan을 1스텝씩 분해·디스패치·관찰·전진. Type-1 결정/외부쓰기/파괴적 작업 만나면 `decision_blocked` → **영구 halt**(timeout/default 없음) → 사람 `choose`/`approve`.

완전 무인(plan 채택까지 자동)은 **설계상 채택 안 함** — "anemic auto, 지연이 곧 기능"(v3 §4). 이 플랜은 그 경계를 바꾸지 않는다.

---

## 1. 라이브 루프의 임계 경로 (무엇을 입증하는가)

```
[user] spec 저술 ─accept_spec▶ [Planner] plan_proposed ─accept_plan(user)▶ plan=active
   │
   ▼  (BOULE_AUTO_MODE=type2)
[auto_dispatch] active plan 순회 → ready 스텝 1개 → conduct_plan(1 step)
   │
   ▼  (BOULE_CONDUCTOR_MODE=live, adapter.ts)
   git worktree add --detach  +  .boule/{envelope.json, step-prompt.md, mcp.json}  +
   cmux new-workspace  +  cmux send "claude|codex ... --mcp-config .boule/mcp.json"
   │   (mint: task_started · step_bound · session_spawned)
   ▼
[spawned session] worktree에서 작업 → executor-MCP로:
   ├─ 완료 → complete_task ▶ task_completed
   ├─ 막힘(Type-1/외부) → escalate ▶ decision_blocked ── halt(사람 대기)
   └─ 죽음 → (이벤트 없음)
   │
   ▼  (BOULE_OBSERVER_MODE=live)
[Observer] cmux tree --json reconcile → 죽은 세션 = session_crashed (silent stall 방지)
   │
   ▼  다음 auto_dispatch 패스
   task_completed 확인 → conductor cursor++ → 다음 스텝 … (plan done까지)
```

**루프가 닫히려면 4가지가 라이브에서 참이어야 한다(=이 플랜의 입증 대상):**

- **C1 — Spawn 실제 동작**: live adapter가 실제 worktree+cmux 세션을 띄우고 envelope/prompt/mcp를 정확히 운반.
- **C2 — Executor 계약**: spawn된 세션이 executor-role MCP로 `complete_task`/`escalate`를 **실제 호출**하고, verdict 도구는 **부재**.
- **C3 — 회수**: `task_completed` 이벤트가 SSOT에 적히고 다음 패스가 그것을 읽어 전진.
- **C4 — Stall 안전**: 죽거나 멈춘 세션이 **조용히 멈추지 않고** observer/사람에게 표면화.

---

## 2. Top 3 라이브 리스크 (첫 실행에서 깨질 곳)

1. **회수 실패(C2/C3, 최고 리스크)** — `cmux send`는 fire-and-forget. spawn된 세션이 `complete_task`를 안 부르면(프롬프트 미준수·MCP 미연결·세션 죽음) task가 `active`에 영구 정체. → **L1에서 executor MCP 노출 + step-prompt 계약을 먼저 실증**, **L2에서 crash→stall 표면화 입증**.
2. **Executor-role MCP 배선 미검증(C2)** — `.boule/mcp.json` + `BOULE_SESSION_ROLE=executor`가 spawn된 프로세스에서 실제로 올바른 도구셋(task lifecycle + escalate, **no** approve/choose/decision_*)을 노출하는지 라이브 미확인. → **L1 게이트**.
3. **codex 회수 메커니즘 부재(C2, codex 한정)** — `codex exec`가 executor MCP를 통해 `complete_task`를 부를 수 있는가, 아니면 exit-code 기반 wrapper 완료가 필요한가가 미설계. → **L3 설계 결정**.

> envelope path-glob이 advisory라는 점은 흔히 과대평가됨: **worktree 격리가 이미 hard boundary**다(세션은 자기 worktree 밖을 못 만짐). 진짜 hardening 대상은 forbidden-classes(외부쓰기/파괴적) + `escalateOnAnyBoundaryCrossing`이며 **L4**에서.

---

## 3. 실행 큐 (L0 → L6, 의존/리스크 순)

각 슬라이스 공통 규율(repo durable):
- **TDD: RED → impl → GREEN**, 그다음 full governance 검증
  ```bash
  cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run
  ```
- repo 루트 app drift 0 확인: `git diff --stat -- src/bindings.ts src-tauri/migrations`
- **별도 critic 패스 ACCEPT(self-approve 금지)** 후에만 다음.
- 라이브 스텝은 **runbook 형식**(env·기대출력·실패 triage)으로 적고, 실행은 cmux 네이티브 surface가 필요하므로 **사용자 또는 cmux 세션이 실행**(에이전트 단독 불가). 분배는 **네이티브 병렬 에이전트**(omc team은 cmux startup stall 이력 → §8).
- **push/merge/deploy/credential은 사용자 명시 요청 시에만.**

---

### Phase L0 — 라이브 프리플라이트 하네스 + 희생용 타깃 (먼저 de-risk)

**Goal**: 라이브 루프를 **안전·반복 가능**하게 돌릴 결정적 프리플라이트 + 사소한 throwaway spec/plan + 샌드박스 git 타깃을 만든다. (실제 자율 코드 변경 없이 루프 배관만 입증할 표적.)

**Deliverables**:
- `governance/src/live/preflight.ts` (+ test): 순수/로컬 체크 — `CMUX_SOCKET_PATH` 존재, `cmux` 바이너리, `git worktree` 가능, executor MCP 부팅(`--mcp-stdio` dry probe), 필요한 env 플래그 상태를 구조화 리포트. **부작용 0**(검사만).
- `governance/docs/runbooks/2026-06-07-live-loop-smoke.md`: hello-loop 런북(아래).
- **hello-loop 타깃**: 1-스텝 plan = "샌드박스 worktree에 `LOOP_OK.md` 파일을 정해진 내용으로 생성" — 가장 작은 닫힌 루프. 별도 throwaway repo(`/tmp/boule-live-smoke`)에서.

**Done**: 프리플라이트가 모든 전제를 green/red로 결정적 보고(테스트 커버). 런북만으로 다음 operator가 라이브 스모크 준비 가능. **라이브 실행 자체는 L1에서.**

**Constraints**: push/merge/deploy 없음, credential 없음, 데몬 없음.

---

### Phase L1 — Executor 세션 계약(claude) + **첫 루프 닫힘 입증** ⭐

**Goal**: 라이브 단일 스텝이 claude 세션으로 **실제로 닫히는지** 입증. 이 플랜 전체에서 가장 중요한 de-risking.

**Sub-steps**:
1. **Executor-role MCP 검증/수리(C2)** — `governance/src/mcp/{server,config}.ts`에서 `BOULE_SESSION_ROLE=executor`가 노출하는 도구셋이 `{start_task, complete_task, block_task, escalate}`(+필요 read)이고 `{approve_*, choose, decision_*, accept_plan, accept_spec}`는 **미등록**임을 negative test로 못박는다. `--strict-mcp-config` + denylist 동작 확인.
2. **Step-prompt 계약 정형화** — `.boule/step-prompt.md` 템플릿: (a) 작업은 이 worktree 안에서만, (b) 끝나면 **반드시** `complete_task` 호출, (c) Type-1/외부쓰기/scope 이탈이면 `escalate` 호출 후 정지, (d) envelope의 forbidden-classes 준수. adapter가 envelope에서 이 프롬프트를 결정적으로 생성하는지 테스트.
3. **라이브 단일 스텝(runbook)** — `BOULE_CONDUCTOR_MODE=live`로 hello-loop plan을 `accept_plan` 후 `conduct_plan` 1회 → 실제 worktree+cmux claude 세션 spawn → 세션이 `LOOP_OK.md` 생성 + `complete_task` 호출 → `conductor_status`/이벤트에서 `task_completed` 관측.

**Done (라이브 증거)**: hello-loop 1스텝이 실제 cmux claude 세션으로 닫히고 `task_completed`가 SSOT에 기록됨을 **관측**(스크린샷/이벤트 로그). executor MCP가 verdict 도구 0임을 라이브 확인.

**왜 먼저**: C1+C2+C3를 한 번에 입증하는 최소 단위. 여기서 막히면 그 위 전부 무의미.

---

### Phase L2 — 멀티스텝 자동 전진 + Stall 안전 (auto_dispatch 라이브)

**Goal**: `BOULE_AUTO_MODE=type2`로 2–3 스텝 plan이 **사람 개입 없이 스텝 간 자동 전진**(plan-accept 게이트 외 사람 0)됨을 입증 + 안전 속성 입증.

**Deliverables / 입증 항목**:
- 2–3 스텝 hello-loop plan: auto_dispatch 반복 패스가 스텝 순차 전진(plan done까지). materialization(`step_bound`) 키 dedup으로 부분실패 재-dispatch(중복 spawn 0) 확인.
- **decision_blocked halt 입증**: 한 스텝이 escalate → `decision_blocked` → 후속 auto_dispatch가 **전진 거부**(영구 halt) → 사람 `choose` 후 재개.
- **Stall 표면화 입증(C4)**: 의도적으로 세션을 죽임 → `BOULE_OBSERVER_MODE=live` observer가 `session_crashed` 방출, task는 정체로 표면화(조용한 멈춤 아님). 죽은 세션이 plan을 영구 정지시키되 **표면적으로** 그런지 확인.
- (필요시) **stall 감지 헬퍼**: active task인데 소유 세션이 crashed/부재 → 자문 suggestion(`task_needs_session`/신규)로 표면화. 순수+propose-only.

**Done**: 멀티스텝 무인 전진 + halt + crash-표면화가 라이브 관측. negative test로 timeout/default 부재 재확인.

---

### Phase L3 — **Codex 동급 executor** 배선

**Goal**: 같은 worktree+envelope substrate 위에서 `codex exec` 세션도 dispatch + 루프 닫힘 입증. "코덱스 활용" 충족.

**설계 결정(L3 착수 시 2-모델 consult 권장 — v3 관례)**:
- **executor kind 도입**: envelope/step spec에 `executor: "claude" | "codex"` 필드(기본 claude). Planner/사람이 스텝별 지정. adapter가 kind로 분기.
- **codex 회수 메커니즘(C2-codex)** — 두 경로 중 택1, L3에서 결정:
  - (A) **MCP 경로**: `codex exec`에 executor MCP 부착(codex가 MCP server 호출 가능) → 세션이 직접 `complete_task`. claude와 동형. *선호(대칭)*.
  - (B) **Wrapper 경로**: `codex exec --json`을 bounded(timeout/turns)로 돌리고, **exit success → adapter/observer가 `task_completed` 대리 방출**(인앱 `agent.rs` 패턴 재사용). codex가 MCP 회수 불가일 때 fallback.
- **read-only sandbox 기본**: codex는 `--sandbox read-only` 기본, 쓰기는 worktree 한정(인앱 러너 규율 재사용). danger-full 금지.
- **bounds**: spawn된 codex/claude 세션에 timeout/turn/cost cap + kill — 인앱 `BoundsTracker` 개념을 오케스트레이션 세션에도(L4와 연계).

**Deliverables**: adapter 분기 + envelope 필드 + (A 또는 B) 회수 배선 + 유닛테스트(stub) + **codex hello-loop 라이브 스모크**(runbook).

**Done**: codex 세션으로 hello-loop 1스텝이 라이브로 닫힘(claude와 동일 substrate). executor kind가 plan/step에서 선택 가능.

---

### Phase L4 — Envelope hardening (load-bearing) + 무인 실행 안전 레일

**Goal**: 무인 라이브 실행 전에 advisory였던 안전 경계를 **강제(enforced)**로. (F1 deferred 해소.)

**Deliverables**:
- **forbidden-classes 강제**: 외부쓰기(External Action Gate 경유만)·파괴적·credential·broad-write를 envelope에서 구조적으로 차단 + `escalateOnAnyBoundaryCrossing` 실동작. worktree 격리가 path hard-boundary임을 명문화 + path-glob은 **검출→escalate**(silent 위반 금지)로 격상.
- **세션 bounds 일원화**: 모든 spawn 세션에 timeout/turns/cost/kill(claude·codex 공통). 동시 세션 수 상한.
- **무인 준비 체크리스트(readiness gate)**: "이 plan을 unattended로 돌려도 되는가"를 결정적으로 판정하는 순수 함수 + 런북(프리플라이트 + envelope 강제 + bounds + observer live + halt 테스트 green).

**Done**: 경계 위반이 silent가 아니라 `decision_blocked`/`action_denied`로 강제 표면화(라이브 negative 스모크). 무인 준비 체크리스트 통과해야만 unattended 권장.

---

### Phase L5 — Control Room 라이브 운영 뷰 + Handoff 연속성 라이브

**Goal**: 자율 런 **도중** 상태를 사람이 보고, 긴 작업이 끊김 없이 이어짐을 라이브 입증.

**Deliverables**:
- **Control Room(Phase H) 라이브 GUI 스모크**: `pnpm tauri dev` 부팅 → 진행 중 자율 런의 session/task/handoff 패널이 라이브 갱신(네이티브 WKWebView → 사용자/cmux 실행). (H의 잔여 라이브 스모크 해소.)
- **Handoff(Phase G) 라이브**: 실제 장기 세션에서 context-pressure 상승 → `checkpoint → handoff → hydrate`로 새 세션이 미해결 blocker+envelope 보존하며 재개(권한 확장 0) 라이브 확인.

**Done**: 자율 런이 Control Room에 라이브로 보이고, handoff로 세션 교체가 라이브로 닫힘.

**Constraints**: bindings drift 0(specta 재생성+CI 게이트), app SQLite/마이그레이션 무변경(INVARIANT #4/#6).

---

### Phase L6 — 안정화 / 승격 결정 / 문서

**Goal**: 라이브 자율을 운영 가능 상태로 굳히고 기본값/포스처 확정.

**Deliverables**:
- 기본값 결정(여전히 opt-in 유지 권장: `BOULE_AUTO_MODE` 기본 off).
- **ADR**: 라이브 자율 포스처(executor kind, codex 회수 경로, envelope 강제, 무인 readiness 게이트). `docs/adr/`.
- 운영 runbook 통합 + `governance/docs/INDEX.md` 갱신.
- `docs/decisions.md` Phase 트레이드오프 한 줄씩.

**Done**: 다음 operator가 런북만으로 spec→plan→자율실행을 재현. push/merge는 사용자 게이트 유지.

---

## 4. 의존 그래프

```
L0 (preflight + 타깃)
 └─ L1 (claude 루프 닫힘) ⭐ 최우선
     ├─ L2 (멀티스텝 auto + stall 안전)
     │    └─ L4 (envelope 강제 + bounds + readiness)
     ├─ L3 (codex executor)  ← L1 substrate 위
     └─ L5 (Control Room 라이브 + handoff 라이브)
          └─ L6 (안정화/ADR/문서)
```

L1이 단일 임계 게이트. L2/L3는 L1 후 병렬 가능(경로 분리: L2=dispatch/observer, L3=adapter/envelope). L4는 무인 권장의 전제. L5는 GUI/handoff 라이브(사용자 surface 의존).

---

## 5. INVARIANT 준수 (decision-rails — 리뷰 바)

| # | 라이브에서의 posture |
|---|---|
| 1 자동화→결정레일 침투 금지 | spawn 세션 executor MCP에 verdict 도구 0(L1 negative test); auto_dispatch `decision_*` 0 mint(기존); decision_blocked 영구 halt; plan-accept=사람. |
| 2 외부 토큰 keychain | codex/claude 세션은 토큰 미보유; 외부쓰기는 External Action Gate(Rust+keychain) 경유만(L4 강제). |
| 3 외부 네트워크 Rust | 세션의 외부 호출 금지(escalate); 네트워크는 기존 Rust connectors. |
| 4 IPC=specta | governance MCP=stdio(비대상); Control Room(L5) 신규만 specta, drift CI 0. |
| 5 bounded retry | 세션 bounds(timeout/turns/kill, L3/L4); 데몬/무한poll 없음 — on-demand 단발. |
| 6 SQLite 마이그레이션만 | governance=별도 PGlite; 세션=worktree 격리; app sqlite 무변경. |
| 7 시각 디자인 | L5 Control Room=shadcn+lucide+Tailwind v4 토큰. |

검증은 **별도 critic 패스**(self-approve 금지).

---

## 6. 검증 (정본 = docs/reference/commands.md)

- governance: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run` (현 ~441 → 슬라이스마다 증가).
- app(L5만): `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` / `pnpm typecheck`+`pnpm lint`+`pnpm vitest run` / bindings drift 0 / `pnpm tauri dev` 부팅.
- **라이브 스모크는 관측 증거로**("could not run" ≠ "passed"). 라이브 단계는 cmux 네이티브 surface 필요 → 사용자/cmux 실행.
- ⚠️ 이 워크트리 rtk 파이프 truncation/SHA confab 이력 → 상태 주장은 **셸 등식계산**(`git ls-remote`==HEAD)·범위확인으로, agent prose 신뢰 금지.

---

## 7. 첫 액션 (이 플랜 승인 시)

1. **L0 착수**: `preflight.ts` + hello-loop 타깃 + 런북(로컬·결정적·테스트). 
2. 동시에 **L1 sub-step 1**(executor MCP negative test)로 C2 표면을 못박기.
3. L1 라이브 스모크는 **사용자/cmux 1회 실행** → `task_completed` 관측 = 전체 비전 de-risk의 분기점.

---

## 8. 분배 / 운영 노트

- **분배**: `/omc-teams`(CLI tmux)는 cmux startup stall 이력 → 기본 **네이티브 병렬 에이전트**. 병렬 격리 주의(worktree 교차오염·executor late-writes → 커밋 전 `git status`).
- **2-brain**: 각 라이브 phase 설계 시 codex+opus 2-모델 consult 권장(v3 설계 관례). 단 `codex exec` headless는 stdin/skill-frontmatter 이슈로 불안정 → `< /dev/null` + read-only sandbox, 또는 cmux codex 세션.
- **push 정책**: 절대 자동 push 금지. dev push도 사용자 명시 요청 시에만. main=PR-only.

---

## 9.5 As-built status (2026-06-07, branch `plan/autonomous-orchestration`)

deterministic 코어는 TDD+검증 완료, 라이브 스텝은 runbook(사용자/cmux). governance vitest
**489 pass** (4 pre-existing `escalate/` 실패는 이 워크트리 fresh-install 한정, 범위 밖). 검증
node: 테스트=node20(CI핀), 런타임 서버=node22+(`--experimental-strip-types`). **push 안 함.**

| Phase | 상태 | 증거 |
| --- | --- | --- |
| **L0** preflight | ✅ DONE | `src/live/preflight.ts` + 11 test + read-only `preflight` MCP, **e2e MCP smoke ready=true**(cmux resolved) |
| **L1** claude 루프 닫힘 | ✅ DONE (라이브 관측 2026-06-07) | hello-loop 1스텝이 실제 cmux claude 세션으로 닫힘 — `LOOP_OK.md` + `task_completed` in SSOT (~30s, 2회 재현). 라이브 adapter 버그 **4건** 수정(아래 §9.7). 폴더-trust 전제=runbook §3.0 |
| **L2** 멀티스텝 auto + halt + stall | ✅ DONE (라이브 관측 2026-06-07) | **A** 2-스텝 plan이 사람 개입 0으로 auto_dispatch 자동 전진(step_bound dedup)·둘 다 `task_completed`; **B** escalate→`decision_blocked`→auto_dispatch 전진 **거부(halted)**→`choose` 해소→재개(step1 전진); **C** 세션 워크스페이스 kill→`observe_sessions` `crashed=1`+`stalled_tasks` 표면화. 라이브 드라이버 3종 재현. **제품 코드 무변경**(L1 어댑터 수정으로 동작) |
| **L3** codex peer executor | ⚠️ 배선 라이브 검증 / 어드히어런스 후속 | codex가 `-c mcp_servers`로 executor MCP attach + `complete_task` **호출** 라이브 확인. `approval_policy="never"` 필수(기본 정책=headless exec에서 MCP 호출 차단→`complete_task (failed)` on PermissionRequest) — `buildSessionCommand` 반영(sandbox=workspace-write 유지). 단 gpt-5.5가 파일 작성 후 `complete_task`를 매번 부르진 않음(프롬프트 어드히어런스) → 신뢰성은 step-prompt 강화 또는 옵션 B 래퍼(exit→`task_completed`) 후속(§9.6) |
| **L4** readiness gate | ✅ DONE | `src/live/readiness.ts` `evaluateReadiness` + 7 test + read-only `readiness` MCP (observer-live 필수); envelope 검증=구조적(ADR-0009) |
| **L5** Control Room 라이브 | ⏳ 라이브=사용자 | Phase H 뷰 존재; `tauri dev` GUI 스모크 + handoff 라이브=사용자/cmux |
| **L6** ADR/문서 | ✅ DONE | `docs/adr/0009-live-autonomy-executor-and-readiness.md` + 이 status + runbook |

**L1 + L2 라이브 입증 완료**(2026-06-07, cmux 네이티브 surface에서 에이전트가 직접 구동). L3 codex
배선도 라이브 확인(어드히어런스만 후속). **남은 라이브 = L5 Control Room GUI**뿐(`tauri dev` + control-room
워크트리 의존 → 사용자/cmux). 전부 `governance/docs/runbooks/2026-06-07-live-loop-smoke.md`로 실행 가능.
신규 read-only MCP 진단 도구 3종(`preflight`/`readiness`/`stalled_tasks`)이 go/no-go를 결정적으로 알려준다.

## 9.5.1 라이브 어댑터 수정 (L1/L3 + per-repo 라이브 구동에서 발견 — never-run-live 결함)

라이브 단일스텝을 실제 구동하니 `makeLiveAdapter`의 cmux/MCP 배관이 **유닛테스트(가짜 spawn)에서만
통과하던** 결함 5건이 드러남. 전부 수정 + 실contract 테스트로 고정(`conductor/handlers.test.ts`):

1. **surface 파싱**: `new-workspace`는 `OK workspace:N`(공지=stderr)을 출력 → `stdout.trim()`은 surface가
   아닌 workspace ref. 이제 `parseCmuxRef` + `cmux tree --json`에서 워크스페이스의 terminal **surface** resolve
   (Observer가 surface ref로 reconcile하므로 필수).
2. **백그라운드 surface는 send 불가**: 비가시 워크스페이스 surface는 `cmux send`가 "not a terminal"로 거부.
   → `new-workspace --command <invocation>`로 **원자적 생성+실행**(별도 send 제거).
3. **claude 프롬프트 누락**: variadic `--disallowedTools`가 위치 인자 prompt를 삼킴 → `--`로 옵션 파싱 종료.
4. **claude unattended**: `--permission-mode bypassPermissions` 없으면 첫 권한 프롬프트에서 정지.
   ⚠️ **claude↔codex 샌드박스 비대칭**: bypassPermissions는 승인 프롬프트만 제거할 뿐 **OS FS 샌드박스가
   아니다**(worktree는 claude의 cwd일 뿐 강제 경계 아님 → 오작동/인젝션 세션이 worktree 밖 절대경로에
   쓸 수 있음). codex만 `-c approval_policy="never"` + `--sandbox workspace-write`로 실제 FS 격리. claude의
   **verdict 격리(executor-role MCP)·외부쓰기 게이트(L4)는 이 플래그와 무관하게 구조적으로 유지**되며,
   claude의 OS-레벨 FS 봉쇄는 후속(§9.6). (※ §2의 "worktree=hard boundary"는 codex엔 성립, claude엔 advisory.)

5. **per-repo 세션 MCP 서버 경로**(⭐ per-repo 라이브에서만 노출 — L1/L3 스모크는 governance 심링크로
   가려졌음): `sessionMcpConfig`/codex `serverPath`가 `${repoRoot}/governance/src/mcp/server.ts`로 서버를
   유도 — **지정 로컬 레포엔 governance/ 디렉터리가 없다**(그 레포는 boule 설치본이 아님) → 스폰된 세션의
   executor MCP가 부팅 실패 → `complete_task` 불가 → 루프 영구 정체(파일은 생성되나 닫히지 않음). 수정:
   서버 경로를 **Boule 설치 위치**(`import.meta.url` 기반 `serverEntrypoint`, `LiveAdapterDeps`로 주입)에서
   유도, repoRoot와 분리(repoRoot는 worktree git add 전용으로 유지). `boule run --repo <타깃>` 라이브로
   루프 닫힘 재확인(events→`<repo>/.boule/workspace`, worktree→`<repo>/.boule/worktrees`, decisions ingest=그
   레포의 `docs/decisions.md`).

또한 **세션 워크스페이스를 프로젝트별 cmux 폴더(workspace-group)로 그룹화** — repoRoot basename 라벨로
reuse-or-create(`findGroupRef`/`projectLabelFromRepoRoot`, best-effort=실패해도 루프 무영향). 라이브 재현:
2회 실행이 같은 폴더를 재사용(세션만 추가).

**per-repo `boule run --repo` 라이브 입증**(2026-06-07): `boule init`→`.boule/{config,workspace,worktrees,mcp.json}`
+ `.gitignore` 패치 → `boule run`이 BOULE_WORKSPACE/REPO_ROOT/WORKTREES를 `.boule/`로 스코프 → 1-스텝 루프
닫힘 + per-repo decisions ingest 확인. (이전엔 Slice 1 유닛테스트만; 이제 실 entrypoint 라이브.) 단 #5 수정
전엔 per-repo 루프가 닫히지 못했음 — Slice 1을 처음 실제 구동해 발견.

## 9.6 남은 비결정 follow-up (별도 슬라이스)

- per-step executor (plan-step 스키마에 executor 필드) — 현재 run-level만.
- codex 무인 실행 network/external-write 하드닝 (`workspace-write`는 FS만 제한; 외부쓰기는 External Action Gate 경유).
- **codex `complete_task` 어드히어런스**(§9.5 L3): 배선·approval은 라이브 OK지만 gpt-5.5가 작업 후 매번
  `complete_task`를 부르진 않음 → step-prompt 강화(codex 변형) 또는 옵션 B 래퍼(`codex exec` exit success →
  adapter/observer가 `task_completed` 대리 방출, 인앱 `agent.rs` 패턴) 중 택1.
- **claude 세션 OS-레벨 FS 봉쇄**(§9.5.1 #4 비대칭): claude는 `bypassPermissions`에 FS 샌드박스가 없어
  worktree 밖 절대경로 쓰기가 가능 — codex의 `--sandbox workspace-write`에 상응하는 confinement(외부 샌드박스/
  컨테이너 또는 claude CLI 샌드박스 옵션) 필요. 현재는 operator 감독 + External Action Gate + verdict 격리로 완화.
- **세션 worktree/폴더 reaping**: 종료된 세션의 `.boule-worktrees/*` git worktree + cmux workspace-group 멤버가
  현재 누적 — 정리 루틴(observer crash 감지와 연계) 필요.
- **`state/*.json` 투영 캐시 미배선**(라이브 관측 2026-06-07): `renderTasks`/`renderPlans`/`renderSpecs`/
  `renderHandoffs`/orchestrator-render(= `state/*.json` 파일 writer)가 `src/`에서 **호출처 0** — 서버는
  read 투영(`projectTasks` 등 순수함수)만 in-memory로 쓰고 `state/*.json`은 런타임에 안 만든다. SSOT는
  `events/`(append-only). 의도적 event-sourcing이나 캐시 export가 필요하면 write-path/rebuild 커맨드에
  배선 필요(배선 시 `${BOULE_WORKSPACE}/state/`로 per-repo 자동 정렬). per-repo 분리 자체엔 영향 없음.
- L5 Control Room에 stalled_tasks/readiness 패널 노출.

## 9. 비대상 (별도 트랙)

- 인앱 codex 잡 러너(`src-tauri/src/agent.rs`, ~70%) 잔여: Phase 9c mismatch-draft 잡, Diff Viewer 통합, calendar/today 자동화 — **이 플랜 비대상**(사용자 확정 "보울 오케스트레이션만").
- pgvector 임베딩, 실 Postgres 서버, 장기 스케줄러/데몬 — v3 external residual 유지.
- 완전 무인(plan-accept 자동) — 설계상 비채택(§0.1).
</content>
</invoke>
