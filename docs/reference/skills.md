# Skills — work-radar 프로젝트 스킬 인덱스

프로젝트 스코프 스킬은 `.claude/skills/<name>/SKILL.md`에 있고 `.codex/skills/`에 미러된다.
(생성형 프로세스 스킬 — TDD, debugging, planning, worktrees, code-review 등 — 은 superpowers /
gstack / oh-my-claudecode로 **전역 제공**되므로 여기 두지 않는다. 여기 있는 건 **스택 특화** 스킬만.)

스킬은 워크플로를 가속할 뿐, `AGENTS.md` / `PLAN.md` / 캐노니컬 문서를 **오버라이드하지 않는다**.
충돌 시 캐노니컬 문서가 우선.

## Authored (work-radar 전용)

| 스킬                    | 언제 쓰나                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `tauri-specta-ipc`      | Tauri 2 IPC command/event 추가·변경. specta 타입드 바인딩(Rust→`src/bindings.ts`), `cargo test` 재생성, 수기 TS 타입 금지.           |
| `sqlx-sqlite`           | SQLite 스키마·쿼리·마이그레이션·FTS5·dedup upsert. 마이그레이션 전용 변경, SSOT 규칙.                                                |
| `octocrab-keyring`      | GitHub(octocrab)/Notion(reqwest) 호출 + 토큰을 keychain(keyring)에. bounded retry+backoff+jitter. (Phase 2/3/4)                      |
| `codex-worktree-runner` | Codex 잡 실행 — worktree 격리 + bounds(timeout/turns/cost/kill) + 재트리거 캡 + read-only 샌드박스 + Acceptance 게이트. (Phase 7–10) |

## Vendored (외부, MIT — 각 폴더에 `LICENSE` + SKILL.md 상단 attribution)

| 스킬                 | 출처 (MIT)                         | 커버                                                                                     |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `tailwind-v4-shadcn` | `secondsky/claude-skills`          | Vite + Tailwind v4 `@theme`(CSS-first) + shadcn/ui 게엇챠.                               |
| `rust-idioms`        | `leonardomso/rust-skills`          | 관용 Rust: ownership / async·tokio / error handling / 테스트.                            |
| `code-review-stack`  | `awesome-skills/code-review-skill` | 스택별 리뷰 레퍼런스(Rust async, React, TypeScript, TanStack v5). 비관련 언어 모듈 제거. |

> 벤더 스킬은 verbatim 보존(업스트림 reference). 업데이트는 업스트림 재pull로.
> 라이선스 불명확이던 후보(Tauri 39종 suite `dchuk/...`, TanStack `DeckardGer/...`)는 복사 대신
> 위 authored 스킬(`tauri-specta-ipc` 등)로 자체 작성.
