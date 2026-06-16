# Decision Rails — INVARIANTS

이 7개는 **모든 Phase·모든 PR에서 강제된다.** 위반하는 구현은 done이 아니다.
이 문서는 `PLAN.md §1`에서 추출된 정본이며, `PLAN.md`는 Phase 계획만 남는다.

## 1. 결정 레일은 사람만

Codex/규칙은 매트릭스 분류·승격 여부를 자동 확정하지 못한다. `suggestedQuadrant`는
*힌트*일 뿐, 카드는 항상 `unclassified`로 진입한다. enrich/AI는 `suggestedArea`까지만
제안하고 사람이 `area`로 확정/수정한다.

> **Boule orchestrator dispatch rail.** Orchestrator/conductor/scheduler dispatch modules do not
> have a `decision_*` write path. Type-1 boundaries reached by spawned work emit
> `decision_blocked` and halt until a human resolves them; no timeout/default/self-resolve path.
> Binding record: `governance/docs/adr/0008-orchestrator-dispatch-decision-rail.md`.

> **Graduated autonomy 경계.** `.boule/boule.config.json`의 `autonomyLevel`
> (manual < dispatch < auto_plan < full)은 **acceptance/dispatch 자동화만** 연다 — spec/plan
> accept와 다음 step 파견. Type-1 결정(`decision_blocked`)과 stall 해소는 `full`에서도
> 항상 사람이 푼다. `auto_plan`/`full`은 **config-file-only(test/dev), per-kind 기본값 불가**.
> 이 INVARIANT와 모순 아님: 자동화는 실행 *진입*을 열 뿐, 결정 레일은 닫힌 채 유지된다.
> as-built 정의: `governance/src/repo/config.ts` (ADR-0009 §4의 anemic-auto 경계·ADR-0010
> fail-closed 드라이버와 정합 — 이 ladder 자체는 두 ADR 이후 추가).

## 2. 모든 외부 변경은 Acceptance 게이트

Codex 출력이 Notion/GitHub를 직접 mutate하지 못한다. 사람이 accept해야 변경된다.
Today 승격(`target:"today"`)은 로컬 SQLite 액션이라 Acceptance 불요(외부 변경 아님).
캘린더 이벤트 생성은 사용자 폼=사람 결정이므로 acceptance 대기 제거(Phase 19 결정).

> **MCP 서버 경계.** 외부 AI가 spawn하는 `work-radar --mcp-stdio` MCP 서버는 #1/#2를
> MCP 표면에서 mechanize한다 — non-Hermes write 툴은 `store::enqueue`(proposal)만 호출.
> `Acceptance::mint`은 `pub(in crate::external_actions)` 타입-월 + trybuild로 mcp에서 컴파일-차단
> (토큰 위조 불가). `store::{approve,reject}`는 현재 `pub(crate)`라 컴파일이 아닌 **durable 규칙으로
> 금지**(mcp는 호출 안 함; 경화는 mcp-server-conventions §핵심불변). 단, Work Radar가 Hermes ACP
> 세션에 주입한 MCP 서버(`WORK_RADAR_MCP_CALLER=hermes`)는 Hermes permission card를 사람 게이트로
> 간주해 Work Radar 승인 큐를 한 번 더 거치지 않고 기존 Rust connector/local store 경로를 실행한다.
> 토큰은 여전히 project_id→credential_ref→keychain으로만 해석한다. 정본:
> `docs/areas/mcp-server-conventions.md`.

> **스킬 매니저(ADR-0006) 경계.** 스킬 _파일_ 설치/동기화(중앙 라이브러리 → 로컬 에이전트 dir,
> `~/.{claude,codex,openclaw}/skills`)는 **사용자 발동 파일 작업**으로, 이 INVARIANT의 "codex 출력이
> 외부 서비스를 mutate" 대상이 아니다(사용자 액션 = 사람 결정). 단 **가역(uninstall=원상복구)·audit
> 필수**. 여전히 불변: 스킬을 설치/동기화해도 **codex 잡은 gated→Acceptance** — 스킬 파일 관리 ≠ 잡
> 실행(#1/#2). 정본: `docs/adr/0006-skills-registry-full-manager.md`.

## 3. 신호는 dedup upsert (append 아님)

system/PR/Hermes 신호는 안정적 `dedupKey`로 중복 생성을 막고, 원인이 해소되면
auto-resolve 한다. 예: CI 통과 시 신호 소멸. braindump 정규화 키도 dedup 한다.

## 4. 매트릭스는 결정 큐 (거울 아님)

ambient status(PR Radar/Hermes/News)는 자기 뷰에 살고, **명시적 임계치를 넘을 때만**
매트릭스로 escalate 한다. 임계치 없는 자동 escalation은 매트릭스를 알림 거울로
만든다 — 신호당 결정 budget이 사라진다.

> 현재 PR Radar는 표시 전용 (escalation/CI-failure notification 제거 —
> `docs/areas/frontend-shell.md` "PR Radar 제약" + `docs/decisions.md`
> 2026-05-24 settings-refactor B). 재도입은 새 임계치 정책을 ADR로 정한 뒤.

## 5. 에이전트 잡은 bounded

모든 에이전트 잡은 `timeout + maxTurns + costCapUsd + kill switch`로 제약된다.
재트리거 체인(CI triage 등)에도 `retryKey`+`retryCount` 캡을 두고 초과 시
Q1으로 사람에게 escalate. 전부-실패 분류 보존(transient vs terminal)도 INVARIANT #5의
일부 — `with_retry`/`Retryable` 트레이트 사용.

## 6. 코드 작업은 격리

코드 작업은 git worktree에 격리. 사용자 워킹트리를 절대 건드리지 않는다.
샌드박스 기본 read-only, 쓰기는 명시 승인 시 workspace-write. **`danger-full-access`는
코드 경로에 존재하지 않는다** — 필요 시 새 ADR로 도입 근거·범위·로그 보존을 정의.

> 주의: 이 INVARIANT는 **앱이 실행하는 Codex 잡**에 적용된다. 이 앱을 _만드는_ 에이전트의
> 멀티-에이전트 디스패치 가드(parallel worktree 사고 등)는 `parallel-agent-safety.md`에 있다.

## 7. SSOT 분리

Notion = 백로그/안건 *내용*의 SSOT. 로컬 SQLite = 매트릭스 상태·신호·승격 이력·
에이전트 잡의 SSOT. 로컬 미러는 read cache + write-through일 뿐.

> **스킬 매니저(ADR-0006) SSOT.** 중앙 라이브러리 = **managed 스킬의 SSOT**. 발견된(discovered)
> 외부 스킬은 import 전까지 **디스크-SSOT(읽기 전용)** — import 시 중앙레포로 복사되고 이후 중앙이
> SSOT. 양방향 sync(Phase G3)는 중앙 ↔ 프로젝트/에이전트 dir. 정본: `docs/adr/0006-skills-registry-full-manager.md`.

---

## 추가 전역 규칙 (구 PLAN.md §1 추가 규칙)

`AGENTS.md` Implementation Rules와 중복되는 항목은 거기서 정본. 결정-레일 인접:

- **Webview = Vite + React** — Tauri webview는 SSR/Node 런타임이 없으므로
  서버 프레임워크(Next.js 등) 도입 시 빌드·런타임 모델이 깨진다.
- **AI는 닫힌 taxonomy만.** `AreaTag` 9개 + `other`(Wheel of Life). 세트 밖 카테고리 생성 금지.
