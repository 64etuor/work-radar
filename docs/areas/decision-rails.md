
# Decision Rails — INVARIANTS

이 7개는 **모든 Phase·모든 PR에서 강제된다.** 위반하는 구현은 done이 아니다.
이 문서는 `PLAN.md §1`에서 추출된 정본이며, `PLAN.md`는 Phase 계획만 남는다.

## 1. 결정 레일은 사람만

Codex/규칙은 매트릭스 분류·승격 여부를 자동 확정하지 못한다. `suggestedQuadrant`는
*힌트*일 뿐, 카드는 항상 `unclassified`로 진입한다. enrich/AI는 `suggestedArea`까지만
제안하고 사람이 `area`로 확정/수정한다.

## 2. 모든 외부 변경은 Acceptance 게이트

Codex 출력이 Notion/GitHub를 직접 mutate하지 못한다. 사람이 accept해야 변경된다.
Today 승격(`target:"today"`)은 로컬 SQLite 액션이라 Acceptance 불요(외부 변경 아님).
캘린더 이벤트 생성은 사용자 폼=사람 결정이므로 acceptance 대기 제거(Phase 19 결정).

## 3. 신호는 dedup upsert (append 아님)

system/PR/Hermes 신호는 안정적 `dedupKey`로 중복 생성을 막고, 원인이 해소되면
auto-resolve 한다. 예: CI 통과 시 신호 소멸. braindump 정규화 키도 dedup 한다.

## 4. 매트릭스는 결정 큐 (거울 아님)

ambient status(PR Radar/Hermes/News)는 자기 뷰에 살고, **임계치를 넘을 때만**
매트릭스로 escalate 한다. PR Radar는 현재 표시 전용으로 escalation/CI-failure
notification 제거됨(2026-05-24 settings-refactor B). 재도입 금지.

## 5. 에이전트 잡은 bounded

모든 에이전트 잡은 `timeout + maxTurns + costCapUsd + kill switch`로 제약된다.
재트리거 체인(CI triage 등)에도 `retryKey`+`retryCount` 캡을 두고 초과 시
Q1으로 사람에게 escalate. 전부-실패 분류 보존(transient vs terminal)도 INVARIANT #5의
일부 — `with_retry`/`Retryable` 트레이트 사용.

## 6. 코드 작업은 격리

코드 작업은 git worktree에 격리. 사용자 워킹트리를 절대 건드리지 않는다.
샌드박스 기본 read-only, 쓰기는 명시 승인 시 workspace-write, **danger-full 금지**.

> 주의: 이 INVARIANT는 **앱이 실행하는 Codex 잡**에 적용된다. 이 앱을 *만드는* 에이전트의
> 멀티-에이전트 디스패치 가드(parallel worktree 사고 등)는 `parallel-agent-safety.md`에 있다.

## 7. SSOT 분리

Notion = 백로그/안건 *내용*의 SSOT. 로컬 SQLite = 매트릭스 상태·신호·승격 이력·
에이전트 잡의 SSOT. 로컬 미러는 read cache + write-through일 뿐.

---

## 추가 전역 규칙 (구 PLAN.md §1 추가 규칙)

`AGENTS.md` Implementation Rules와 중복되는 항목은 거기서 정본. 결정-레일 인접:

- **Next.js 금지** — desktop webview엔 Vite + React (구조적 제약).
- **AI는 닫힌 taxonomy만.** `AreaTag` 9개 + `other`(Wheel of Life). 세트 밖 카테고리 생성 금지.
