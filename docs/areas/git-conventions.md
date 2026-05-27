# Git & PR Conventions

## Conventional Commits

`{type}({scope}): {message}` — 명령형 한 줄 제목.

허용 type: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`.

scope는 모듈/컴포넌트 단위(예: `feat(news): add RSS adapter`, `fix(board): restore Esc focus`).

## 이슈 참조는 PR 제목/본문에만

커밋 메시지에 이슈 번호를 넣지 않는다.

## 한 PR = 한 관심사

feature와 광범위 refactor를 섞지 않는다. 무관 파일 정리도 같은 PR에 포함하지 않는다.
(`AGENTS.md` Forbidden Shortcuts.)

## PR 본문 = 템플릿 사용

`.github/PULL_REQUEST_TEMPLATE.md`를 채운다:

- 문제와 기대 영향
- 무엇이 바뀌었나
- 왜 현재 아키텍처에 맞나(area 문서 참조)
- INVARIANT 체크(`docs/areas/decision-rails.md`의 7개)
- 위험·롤백·마이그레이션 노트
- 실행한 검증 명령(`docs/reference/commands.md`) **출력 포함**
- 문서/`docs/adr/` 또는 `docs/decisions.md` 업데이트
- 의도적 deferred follow-up

## Push 규칙 (이 레포 한정)

- **항상 `dev`에 push.** 작업/커밋/푸시는 `dev` 브랜치에서.
- **`main`은 PR-only**(dev → main 머지로만 갱신).
- `.husky/pre-push` 훅이 `main` 직접 푸시를 차단(긴급 우회: `git push --no-verify origin main`,
  사용 금지).
- 서버측 보호는 private+free 플랜이라 불가 → **로컬 husky 훅으로만 강제**(머신 로컬·우회 가능).
- `gh` 활성 계정이 가끔 `yanghapark`로 튀니 `gh auth switch --user 64etuor`로 고정.

## Pre-commit 훅

`.husky/pre-commit`은 다음을 실행:

- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
- `pnpm typecheck`

agent 기본 PATH에 cargo 없음 → `export PATH="$HOME/.cargo/bin:$PATH" && git commit ...`.
상세: `docs/areas/shell-tooling.md`.

`cargo fmt` 타이밍 주의: **`git add` 전에** 실행. 자세한 가드는 `shell-tooling.md` §4.

## CI

`.github/workflows/ci.yml` (현재 구성):

- `rust` job: fmt --check, clippy `-D warnings`, test
- `frontend` job: typecheck, build, vitest, eslint

추가 게이트(structural enforcement: bindings.ts drift, doc budget, INVARIANT grep)는
`docs/decisions.md`에 계획만 있고 **아직 미적용** — PR 게이트는 현재 reviewer 패스로 보강.

## Phase 종료 시

- INVARIANTS reviewer 패스(self-approve 금지). `oh-my-claudecode:critic` 등.
- 구조적/비싼 결정은 `docs/adr/`에 ADR로 기록하고, 작은 Phase 트레이드오프는
  `docs/decisions.md`에 한 줄로 기록.
- done-criteria 전부 green일 때만 다음 Phase.

## Dependabot

`.github/dependabot.yml`은 계획만(아직 미적용 — `docs/decisions.md` 2026-05-21 항목 참조).

## 정본 / 참조

- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/adr/README.md`
- `.husky/pre-commit`, `.husky/pre-push`
- `.github/workflows/ci.yml`
- `~/.claude/projects/-Users-davidpark-private-project-work-radar/memory/work-radar-push-to-dev-only.md`
