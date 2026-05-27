# Work Radar

흩어진 업무 신호(Notion 백로그·안건, GitHub PR, 일정, Hermes, braindump)를 먼저
**아이젠하워 매트릭스**로 모으고, 사람이 직접 판단해 Notion 백로그·안건·일정·실행
작업으로 **수동 승격**하는 개인/팀 업무 관제 데스크톱 앱.

> 핵심 철학: "자동으로 업무를 만들어주는 앱"이 아니라,
> "판단해야 할 것들을 매트릭스에 모아 수동으로 정리하게 해주는 앱."
> 자동화(Codex)는 **결정 레일에 절대 들어가지 않고**, 제안/실행 레일에만 붙는다.

## 상태

**활발히 개발 중 (dogfooding).** `PLAN.md`의 Phase 0–20이 `dev`에 머지됨 —
스켈레톤·Capture Board·Notion 승격·GitHub PR Radar·Worktree·Agent(Codex) 스파인·
Google Calendar(read/write)·Today/Timeline/Weekly·트레이 상주·Routines·회고 등.
레포는 Private(`64etuor/work-radar`). 작업 브랜치는 `dev`(직접 push), `main`은
PR로만 머지한다(husky pre-push가 main 직접 push 차단).

> 코드는 `src-tauri/`(Rust 백엔드)와 `src/`(Vite + React 프론트)에 있다.
> 단계별 진행 이력과 현재 상태 요약은 `docs/HANDOFF.md`를 본다.

## 스택

- **Shell:** Tauri 2.x (상주 + 전역 핫키 + 경량 footprint)
- **Backend:** Rust — tokio · sqlx(SQLite) + migrations · reqwest(Notion·Google Calendar REST) · octocrab(GitHub) · keyring · tracing
- **Frontend:** Vite + React + TS · Tailwind v4 · shadcn/ui · cmdk(팔레트) · TanStack Query · Zustand
- **IPC 타입안전:** tauri-specta (Rust→TS 타입 생성, `src/bindings.ts`)
- **자동화 엔진:** Codex CLI (`codex exec`) via `tokio::process`, git worktree 격리

## 시작하기

> 전체 빌드·검증 명령은 **`docs/reference/commands.md`(정본 인덱스)** 를 본다.
> 아래는 최소 진입점만.

```bash
pnpm install          # 의존성 설치 (pnpm-lock.yaml 기준)
pnpm tauri dev        # 앱 부팅(개발 모드) — 통합 동작 확인의 기준 명령
```

Rust 단위 테스트 / 린트:

```bash
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## 문서

| 파일                             | 내용                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `docs/HANDOFF.md`                | **현재 상태 + 세션 핸드오프** — 처음 들어오면 여기부터                      |
| `PLAN.md`                        | Phase 0–20 플랜 + §1 **INVARIANTS 7개**(절대 규칙)                          |
| `AGENTS.md`                      | 이 앱을 만드는 에이전트(Ralph/Codex/Claude)의 working agreement             |
| `CLAUDE.md`                      | Claude 진입점(thin) — "작업 전 읽을 것" 인덱스                              |
| `docs/architecture.md`           | 데이터 모델, 3-rail, AgentRunner, 멀티프로젝트/레포, SSOT, IPC              |
| `docs/decisions.md`              | 결정·트레이드오프 원장(Phase별 한 줄)                                       |
| `docs/reference/commands.md`     | **빌드·검증 명령 정본 인덱스**                                              |
| `docs/specs/`                    | Phase 상세 스펙(10 / 11 / 12–20)                                            |
| `DESIGN.md`                      | **시각 디자인 정본** — Cohere 스타일(white editorial). 토큰·컴포넌트·반응형 |
| `docs/archive/design-raycast.md` | 폐기된 Raycast 다크 방향(이력 보존)                                         |
