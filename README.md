# Work Radar

캘린더·GitHub PR·Notion 백로그·AI 에이전트 작업처럼 흩어진 업무 신호를 **한 화면에 모으는 데스크톱 앱**.
AI는 제안만 하고, 무엇을 할지 정하고 외부에 반영하는 일은 **사람이 승인**한다.

![Capture Board](https://yanghapark.com/projects/work-radar/work-radar-01-capture-board-2026-06-15.png)

## 주요 기능

- **Capture Board** — 들어온 신호를 아이젠하워 매트릭스로 분류하고, 직접 판단해 백로그·안건·일정으로 승격
- **Today Timeline** — 오늘 할 일을 시간 위에 배치, Google Calendar와 양방향 동기화
- **PR Radar · Worktree Diff** — 여러 저장소의 PR을 상태별(CI 실패·리뷰 대기·머지 가능)로 분류
- **Jobs (Agent)** — Codex 실행마다 시간·턴 수·비용 상한과 강제 종료, 결과는 수락/거절 기록으로 남김
- **승인 게이트** — GitHub·Notion·캘린더에 쓰는 작업은 모두 사람 승인 후 실행

## 상태

**개발 중 · 직접 쓰면서 만드는 중 (dogfooding).** `PLAN.md`의 Phase 0–20이 `dev`에 머지되어 있다.
코드는 `src-tauri/`(Rust 백엔드)와 `src/`(Vite + React 프론트)에 있고, 진행 이력은 `docs/HANDOFF.md`에 정리돼 있다.

## 스택

- **Shell:** Tauri 2
- **Backend:** Rust — tokio · sqlx(SQLite) · reqwest(Notion·Google Calendar) · octocrab(GitHub) · keyring
- **Frontend:** Vite + React + TypeScript · Tailwind v4 · shadcn/ui · TanStack Query · Zustand
- **IPC 타입 안전:** tauri-specta (Rust → TS 타입 생성)
- **자동화:** Codex CLI, git worktree 격리 · MCP 게이트웨이

## 시작하기

> **새 머신/새 사용자 설치·설정 절차는 `docs/SETUP.md`(정본)** — 요구사항, 통합(Notion/
> GitHub/Google) 설정, 기본 통화, 선택 도구 없이 돌아가는 방식(fresh-machine 계약),
> 리브랜딩 체크리스트까지. 전체 빌드·검증 명령은 **`docs/reference/commands.md`**.
> 아래는 최소 진입점만.

```bash
pnpm install          # 의존성 설치 (pnpm-lock.yaml 기준)
pnpm tauri dev        # 앱 부팅(개발 모드) — 통합 동작 확인의 기준 명령
```

> 참고: 외부 통합(Notion·GitHub·Google·Codex 등)은 전부 **선택**이고 앱 내 설정으로
> 연결한다. 아무 통합 없이도 부팅·사용 가능하다. LICENSE는 아직 미지정(
> 결정 필요 — `docs/SETUP.md` §7).

Rust 단위 테스트 / 린트:

```bash
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## 문서

| 파일                             | 내용                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `docs/SETUP.md`                  | **설치·설정 가이드(범용 사용자용)** + 리브랜딩 체크리스트                   |
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
