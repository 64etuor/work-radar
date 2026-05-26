# Work Radar — Agent Working Agreement

이 파일은 이 앱을 **만드는** 에이전트(Ralph / Codex / Claude)를 위한 **레포 전역
durable** 규칙이다. 도메인별 규율(shadcn / news / data-layer / parallel safety …)은
**중복하지 않는다** — `docs/areas/<area>.md`에 있고, `docs/areas/area-map.md`가 라우팅한다.

(앱 *내부*에서 실행되는 Codex 자동화의 런타임 규칙은 `docs/architecture.md` 참조.)

## Goal

`PLAN.md`의 Phase를 순서대로, done-criteria를 검증 가능하게 충족시키며 진행한다.
가장 작고 국소적인 변경을 선호한다. 모든 변경은 코드 헬스를 개선해야 한다.

## Scope

work-radar는 **단일 패키지** Tauri 데스크톱 앱(Rust + Vite/React). 도메인은 파일 글롭으로
구분되며(`docs/areas/area-map.md`), 변경은 스코프 내 도메인의 area 문서 규율을 따른다.

## Source of Truth (우선순위)

다음 순서로 따른다:

1. 자동화된 검사(`docs/reference/commands.md` + CI)와 그 결과
2. `AGENTS.md`(이 파일) + 변경이 닿는 도메인의 `docs/areas/<area>.md` + 그 area가 가리키는 정본 문서
3. `PLAN.md` §1 INVARIANTS = `docs/areas/decision-rails.md`(추출본)
4. `docs/decisions.md` 직전 결정(이력)
5. 닿은 영역의 기존 로컬 패턴

규칙 충돌 시 자동화 검사를 위반하지 않는 한도에서 **가장 국소적인 규칙**을 따른다.
스킬(OMC 등)은 추천일 뿐 — 위 1–5를 override 하지 않는다.

## Before Editing

- `docs/areas/area-map.md`에서 스코프가 닿는 도메인 행을 확인.
- 그 행이 가리키는 docs만 로드(범위 밖 문서를 prefetch 하지 않는다).
- 해당 Phase의 Deliverables/Done-criteria를 먼저 읽는다(`PLAN.md`).
- 기존 패턴/모듈을 재사용한 뒤 새 패턴을 도입한다.
- 결정/제안/실행 레일 경계를 침범하는지 먼저 확인(`docs/areas/decision-rails.md`).

## Implementation Rules — 레포 전역 durable

다음은 **모든 도메인**에 적용되는 불변. 도메인별 추가 규율은 area 문서에 있다.

- **외부 토큰은 OS keychain.** SQLite 평문/프런트 저장 금지(`keyring`, project별 분리).
- **외부 네트워크 호출(Notion/GitHub/Calendar/RSS)은 Rust에.** 렌더러에 토큰 노출 금지.
  상세: `docs/areas/ipc-conventions.md`.
- **IPC = tauri-specta 생성 타입(`src/bindings.ts`).** 수기 TS IPC 타입 금지.
  `bindings.ts` drift = CI 게이트.
- **bounded retry only.** 무한 retry/poll 금지. backoff + jitter + terminal failure 노출.
- **SQLite 스키마는 마이그레이션으로만.** 임의 ALTER 금지. 상세: `docs/areas/data-layer-conventions.md`.
- **코드 작업 격리:** 격리가 필요한 코드 잡은 **사용자 워킹트리 무손상**. 단, 다중 implementer
  에이전트 디스패치 패턴은 이 레포에서 별도 가드가 필요 — `docs/areas/parallel-agent-safety.md` 참조.
- **시각 디자인 정본 = `DESIGN.md`(Cohere white editorial).** 토큰은 Tailwind v4 `@theme`,
  컴포넌트는 shadcn/ui 위에. 마케팅 전용 컴포넌트(announcement-bar 등)는 앱 셸 비대상.
  도메인별 shadcn 마이그레이션 규율(grep-카운트≠대상, Dialog 포커스 복원, cmux Esc 스모크)은
  `docs/areas/shadcn-migration.md`에 있다.
- **AppError 단일 envelope.** 도메인 에러 → `AppError` `From`. `Result<_, AppError>`를 IPC 경계로.
  `cargo clippy -D warnings` + `#![deny(clippy::unwrap_used)]` 프로덕션 적용.
- **로그 PII/시크릿 금지.** 외부 응답 본문은 코드+크기만(상세: `docs/areas/ipc-conventions.md`).

## Verification

- 각 Phase done-criteria를 **실제 실행/관찰**로 채운다 (체크박스 = 증거).
- 명령은 `docs/reference/commands.md`가 정본 — 이 파일에 중복하지 않는다.
- Rust: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
- 프런트: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`.
- Tauri 통합: `pnpm tauri dev` 부팅 확인.
- 실행 못 한 검증은 **명시적으로** 못 했다고 말한다("could not run" ≠ "passed").
- 도구 신뢰성 주의: rtk-wrapped `cargo` 출력은 부정확할 수 있다 → `docs/areas/shell-tooling.md`.

## PR Expectations

PR 본문에 반드시:

- 문제와 기대 영향
- 무엇이 바뀌었나
- 왜 현재 아키텍처에 맞나(area 문서 참조)
- 위험·롤백·마이그레이션 노트
- 실행한 검증 명령(`docs/reference/commands.md` 인덱스)
- 문서/`docs/decisions.md` 업데이트
- 의도적 deferred follow-up

상세 템플릿: `.github/PULL_REQUEST_TEMPLATE.md`.

## Review Bar

코드 헬스를 분명히 개선하면 review-ready. 다음은 차단 사유:

- 정확성·보안·프라이버시 결함
- 경계/아키텍처 회귀(레일/area 침범 포함)
- 닿은 영역의 유지보수성 회귀
- 행동 변경에 테스트 없음
- INVARIANT(`docs/areas/decision-rails.md`) 위반

비차단 제안은 `Nit:`.

## Forbidden Shortcuts

- 린트/테스트/타입체크/CI를 prose로 우회.
- feature와 광범위 refactor 섞기(한 PR=한 관심사).
- 무관 파일 정리.
- owner/context 없는 TODO.
- **자동화를 결정 레일에 침투시키기** (가장 중요한 금지 — `docs/areas/decision-rails.md` INVARIANT #1).
- self-approve(같은 active context에서 작성자가 승인). reviewer/critic 별도 패스.

## Phase 종료 시

- INVARIANTS 7개 위반 여부를 별도 reviewer 패스로 확인(self-approve 금지).
- 새 결정/트레이드오프는 `docs/decisions.md`에 한 줄.
- done-criteria 전부 green일 때만 다음 Phase.

## Important Paths (index)

라우팅 정본:

- `docs/areas/area-map.md` — **도메인 → 문서 라우팅 테이블 정본**

Area 문서:

- `docs/areas/decision-rails.md` — 7 INVARIANTS (추출본 — PLAN.md §1 대체)
- `docs/areas/ipc-conventions.md` — tauri-specta·keychain·bounded retry·외부 호출
- `docs/areas/data-layer-conventions.md` — sqlx·migrations·FTS5·dedup upsert·SSOT
- `docs/areas/shadcn-migration.md` — Wave 1–5 규율, Esc 계약, overlay-stack
- `docs/areas/frontend-board.md` — capture-board 5영역, drag 분류
- `docs/areas/frontend-shell.md` — *View.tsx / settings / 공통 hooks
- `docs/areas/news-feature.md` — RSS 페처·옵션·키워드 필터
- `docs/areas/parallel-agent-safety.md` — worktree 격리 사고 가드, executor late-writes
- `docs/areas/shell-tooling.md` — rtk 파이프 truncation, cargo PATH, husky 훅
- `docs/areas/git-conventions.md` — Conventional Commits, dev-only push

전역 참조:

- `docs/reference/commands.md` — 명령 인덱스
- `docs/architecture.md` — 시스템 구조
- `DESIGN.md` — 시각 디자인 정본
- `PLAN.md` — Phase 계획(INVARIANTS는 `decision-rails.md`로 이전)
- `docs/decisions.md` — 결정 로그(append-only)
