# Work Radar

흩어진 업무 신호(Notion 백로그·안건, GitHub PR, 일정, Hermes, braindump)를 먼저
**아이젠하워 매트릭스**로 모으고, 사람이 직접 판단해 Notion 백로그·안건·일정·실행
작업으로 **수동 승격**하는 개인/팀 업무 관제 데스크톱 앱.

> 핵심 철학: "자동으로 업무를 만들어주는 앱"이 아니라,
> "판단해야 할 것들을 매트릭스에 모아 수동으로 정리하게 해주는 앱."
> 자동화(Codex)는 **결정 레일에 절대 들어가지 않고**, 제안/실행 레일에만 붙는다.

## 상태

**계획 단계 (plan only).** 아직 코드 없음. 이 레포는 현재 `PLAN.md` + `docs/`만 보유.
Ralph로 Phase 0부터 단계별 자율 진행할 수 있도록 설계됨.

## 스택

- **Shell:** Tauri 2.x (상주 + 전역 핫키 + 경량 footprint)
- **Backend:** Rust — tokio · sqlx(SQLite)+migrations · reqwest(Notion REST) · octocrab(GitHub) · keyring
- **Frontend:** Vite + React + TS · Tailwind · shadcn/ui · cmdk(팔레트) · TanStack Query · Zustand
- **IPC 타입안전:** tauri-specta (Rust→TS 타입 생성)
- **자동화 엔진:** Codex CLI (`codex exec`) via `tokio::process`, worktree 격리

자세한 근거는 `docs/architecture.md`, 디자인 정본은 루트 `DESIGN.md` (Cohere 스타일).

## 문서

| 파일 | 내용 |
| --- | --- |
| `PLAN.md` | Ralph-ready 단계별 플랜 (Phase 0–11) + 불변식 |
| `AGENTS.md` | 이 앱을 만드는 에이전트(Ralph/Codex/Claude)의 working agreement |
| `docs/architecture.md` | 데이터 모델, 3-rail, AgentRunner, 멀티프로젝트/레포, SSOT |
| `DESIGN.md` | **시각 디자인 정본** — Cohere 스타일(white editorial). 토큰·컴포넌트·반응형 |
| `docs/design.md` | (이전됨) `DESIGN.md`로 이전을 알리는 포인터 |
| `docs/archive/design-raycast.md` | 이전 Raycast 다크 방향(보존) |

## Ralph로 진행하기 (나중에)

```
cd ~/Projects/work-radar
# Phase 0부터: PLAN.md의 done-criteria로 자가 검증하며 진행
/oh-my-claudecode:ralph  Phase 0 부터 PLAN.md 따라 진행. 각 Phase done-criteria 충족 시 다음으로.
```
