@AGENTS.md

# Work Radar — Claude 진입점

이 파일은 **thin router**다. 지속적 규칙은 `AGENTS.md`(working agreement)에,
도메인별 규율은 `docs/areas/<area>.md`에, Phase 계획은 `PLAN.md`에 있다. 이
파일에 규칙을 중복하지 않는다.

## 작업 전 — 도메인 라우팅

먼저 **`docs/areas/area-map.md`**(라우팅 테이블 정본)에서 변경 범위가 어느 도메인을
건드리는지 확인한다. 해당 도메인 행이 가리키는 문서만 로드한다.

빠른 라우팅(상세는 area-map):

- `src-tauri/src/commands/**` → `docs/areas/ipc-conventions.md`
- `src-tauri/src/mcp/**` 또는 `--mcp-stdio` → `docs/areas/mcp-server-conventions.md`
- `src-tauri/migrations/**` 또는 `src-tauri/src/db.rs` → `docs/areas/data-layer-conventions.md`
- `src-tauri/src/news/**` → `docs/areas/news-feature.md`
- `src/components/board/**` → `docs/areas/frontend-board.md` + `DESIGN.md` §App Surface
- `src/components/ui/**` 또는 Dialog/Dropdown/Select 추가 → `docs/areas/shadcn-migration.md`
- `src/components/{settings,*View}/**` → `docs/areas/frontend-shell.md`
- `governance/**` 또는 `.boule/**` (Boule 하네스) → `governance/docs/INDEX.md` (프런트도어) + `governance/docs/STATUS.md` (현재 큐)
- 병렬 에이전트 디스패치 / 자동 루프 → `docs/areas/parallel-agent-safety.md`
- 커밋·푸시·CI / husky / cargo PATH → `docs/areas/shell-tooling.md` + `docs/areas/git-conventions.md`
- Phase 시작 전 → `PLAN.md` (해당 Phase) + `docs/areas/decision-rails.md` (INVARIANTS)

## 필수 문서 인덱스

- `docs/reference/commands.md` — 빌드·검증 명령(정본). 이 파일에 명령 중복 금지.
- `DESIGN.md` — 시각 디자인 정본 (Cohere white editorial).
- `docs/architecture.md` — 시스템 구조·모듈 경계.
- `docs/adr/` — 구조적 결정 기록. accepted/rejected ADR 본문은 freeze.
- `docs/decisions.md` — 작은 Phase 트레이드오프/운영 breadcrumb 한 줄 기록.

## Git / PR

상세는 `docs/areas/git-conventions.md`. 요점: Conventional Commits, push는 `dev`만,
`main`은 PR-only, 한 PR=한 관심사, PR 본문에 INVARIANT 체크 + 실행한 검증 출력.

## Claude-specific

- **self-approve 금지.** INVARIANT 위반 여부는 별도 reviewer 패스(critic 등).
- **검증은 실제 실행 증거로.** 체크박스 = 관찰 결과. prose 우회 금지.
- **가장 작은 변경.** 요청 범위 밖 리팩터·정리 금지.
- **구조적 결정은 `docs/adr/`, 작은 Phase 트레이드오프는 `docs/decisions.md`에** 기록.
