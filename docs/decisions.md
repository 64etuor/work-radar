# Work Radar — Decisions Log

각 Phase에서 내린 결정/트레이드오프를 한 줄로 남긴다 (AGENTS.md 규칙).

## Phase 0 — 스켈레톤 & 스파인

- **Tailwind v4 채택** (CSS-first, `@tailwindcss/vite` 플러그인 + `@theme`): 현재 기본 라인. v3식 `tailwind.config.js` 대신 `src/styles.css`에 토큰 정의.
- **keyring 3.x 사용** (`apple-native` feature): keyring 4.x는 `keyring-core` + 별도 backend 크레이트로 재패키징되어 feature가 비어 있음 → 안정적이고 문서화된 3.6.x API(`Entry`/`set_password`/`get_password`/`delete_credential`) 채택.
- **tauri-specta `=2.0.0-rc.25`**: Tauri 2를 지원하는 라인은 현재 2.0 RC뿐. specta/specta-typescript도 동일 RC 라인으로 고정.
- **단일 창 토글 = Raycast 모델**: Phase 0에서 별도 캡처창을 만들지 않고, 하나의 창(`main`)을 전역 핫키(Alt+Space)로 show/hide 토글. Esc로 숨김. (실제 braindump 캡처 UI는 Phase 1.)
- **decoration 없는 창 + 드래그 영역**: `decorations:false`로 Raycast 톤. 헤더에 `data-tauri-drag-region`로 이동 가능.
- **`list_projects`는 `Result<Vec<Project>, String>` 반환**: terminal failure를 프런트로 그대로 노출 (INVARIANT: 에러 삼키지 않음). 프런트는 `status==="error"`를 throw.
- **`bindings.ts` 커밋**: `cargo test`의 export 테스트가 생성. 프런트 빌드가 Rust 실행 없이도 성립하도록 생성물을 저장소에 포함.
- **DB 위치**: OS app-data 경로의 `work-radar.db`. 마이그레이션은 `migrations/`의 버전 파일로만.
- **FTS5**: signals 본문/제목 대상 external-content 가상 테이블 + insert/delete/update 동기화 트리거. libsqlite3-sys bundled가 FTS5 포함.
- **keychain 모듈은 Phase 0에서 `#[allow(dead_code)]`**: 계약/모듈만 세우고 호출부는 Phase 2(Add Project)에서 연결.

## 하네스 / 디자인 (cross-cutting, 2026-05-21)

- **디자인 시스템 피봇: Raycast → Cohere(white editorial).** 시각 디자인 정본을 루트 `DESIGN.md`로 이전(Cohere 스타일: white canvas, monumental type, pill CTA, 8/22px 라운드, coral/blue 악센트). 이전 Raycast 다크 방향은 `docs/archive/design-raycast.md`로 보존. 단, 토큰/컴포넌트만 정본이고 웹/마케팅 전용 컴포넌트(announcement-bar·trust-logo-strip·blog-filter-chip·research-table·footer-newsletter)는 데스크톱 셸 비대상.
- **프런트 토큰 restyle 완료(Cohere, light).** `src/styles.css`의 `@theme`를 Raycast 다크(`rc-*`) → Cohere(`wr-*`, white canvas/ink/coral/action-blue + radii xs~pill + display/sans/mono 폰트)로 교체, `index.html`의 `class="dark"` 제거(color-scheme: light), `App.tsx`/`command.tsx`/`RootPalette.tsx`의 토큰 클래스 일괄 전환(선택 행 stone, 라운드 sm/xs, 그룹 헤딩 mono). 검증: `pnpm build`(tsc+vite) green, 빌드 CSS에 wr-토큰·light color-scheme 확인, leftover `rc-`/다크 bg 0. 시각(흰 캔버스 렌더)은 `pnpm tauri dev` 사용자 관찰 항목.
- **에이전트 하네스 와이어링(Mirrorless_Mono 패턴 축소).** `CLAUDE.md`(thin entry, `@AGENTS.md`) + `.claude/settings.local.json`(cargo/pnpm/tauri/rtk-git/gh 권한) + `.codex/config.toml`(read-only 기본, danger 금지) + `docs/reference/commands.md`(명령 인덱스) + `.github/workflows/ci.yml`(rust: fmt/clippy/test, frontend: typecheck/build) + `.github/PULL_REQUEST_TEMPLATE.md` + `.husky/pre-commit`(fmt+typecheck) 추가. husky는 `pnpm install` 후 활성, CI/PR 템플릿은 remote 연결 시 동작(현재 remote 없음).

## Phase 1 인터랙션 — Capture Board (2026-05-21)

- **인터랙션 모델 피봇: 키보드-우선 2×2 → 공간형 포스트잇 보드.** 캡처(브레인덤프) = 포스트잇 보드 화면. 미분류가 촤라락 펼쳐지고, 드래그로 사분면 분류(드래그가 곧 사람 결정 = INVARIANT #1). 키보드 `1/2/3/4`는 가속기로 병행. 레퍼런스: `docs/prototypes/capture-board.html`.
- **구현 방향 = 현행 앱 창(불투명) 유지.** 투명 데스크톱 오버레이는 클릭스루/포커스/멀티모니터 리스크로 **폐기**(2026-05-21 사용자 결정). 보드는 앱 창을 가득 채우는 불투명 white canvas(Cohere). ⚠️ 프로토타입(`docs/prototypes/capture-board.html`)의 가짜 데스크톱 배경은 **설명용**일 뿐 — 실제 셸은 불투명 창이며, 필요 시 프로토타입을 불투명 버전으로 재스킨.
- **개인/업무 태그.** 입력 맨 앞 토큰 마커(개인:`개인/내/나/사적`, 업무:`업무/일/회사/직장`)가 우선, 없으면 세그먼트 토글값. **기본 = 업무.** 맨 앞 토큰 정확매칭으로 오탐 방지("내일"≠"내"). 칩은 색+라벨 병기(개인 pale-blue, 업무 pale-green). 데이터: `WorkSignal.kind`(personal/work) 힌트 저장 → Phase 2에서 `projectId`로 reconcile (Phase 1엔 프로젝트 없음).
- **카드 액션 메뉴는 기존 계획과 일치.** `⋯`/`Cmd+K`/우클릭 → 백로그 등록·안건 승격·캘린더 등록 = `Promotion` draft만(외부 무변경, **Acceptance 게이트**, 실제 write는 Phase 3/11) + 미루기/완료/보관(`S/D/E`). 새 모델에선 리스트가 아니라 **포스트잇에서 파생**되는 점만 변경.
- **배치:** 사분면 내 자동정렬(pack), 미분류는 가로=레일 카스케이드/세로=상단 트레이 그리드. 반응형(orientation) 자동 전환.
- **그림자 예외:** Cohere는 무거운 그림자 금지지만, over-desktop 오버레이 가독성 위해 포스트잇에 절제된 Media Lift 그림자만 허용.
