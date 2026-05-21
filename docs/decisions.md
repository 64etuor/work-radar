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
- **영역(area) AI 자동 태그 = 제안 레일(2026-05-21).** 각 braindump 포스트잇에 라이프 도메인을 AI가 추론해 `suggestedArea`로 부여(닫힌 taxonomy 9 + other: health/work/studies/environment/recreation/romance/family/friends/finances/other = Wheel of Life). 사람이 `area`로 확정/수정. INVARIANT #1 준수 — area는 아이젠하워 quadrant(결정 레일)와 **별개 축**이고 AI는 제안만(자동 확정 아님). AI는 세트 밖 카테고리 생성 금지(닫힘); 사용자 커스텀 영역은 추후. personal/work `kind`와도 별개 축. 데이터 모델(architecture.md)은 Phase 1부터 필드 보유, **AI 추론·칩 표시는 Phase 9 enrich**.
- **Today's Todo 레일 + 매트릭스→Today 승격(2026-05-21).** 우측 고정 레일(기본 표시; 세로 모니터=하단 시트)에 오늘 집중 항목 큐레이션. 매트릭스 카드를 레일로 드래그 또는 카드 액션 "Today 추가"로 승격. **Today 승격은 로컬(SQLite) 액션 → Acceptance 게이트 불요**(notion_*/calendar 외부 승격과 구분). 승격 시 카드는 **매트릭스에서 제외(이동)**, 원 `quadrant`는 Q1~Q4 배지로 유지(사분면에 들어간 카드는 그 사분면을 태그로 지님). 항목 **완료 체크 + 미완료 다음날 rollover**(완료는 제외). `Promotion(target:"today", forDate)` + 날짜 스코프(오늘). Phase 1에 레일+로컬 승격 도입, **전체 Today 운영 뷰(일정·PR attention·Work Debt)는 Phase 11**. (2026-05-21 기본값 갱신: 이전 "사분면 유지+양쪽 노출" → "매트릭스에서 빼고 Today 전용".) Today 항목엔 **매트릭스로 되돌리기(승격 취소)** 액션 — 원 quadrant 복원(없으면 unclassified), 카운터 리셋.
- **Today 경과일 카운터 `+N`(2026-05-21).** 각 Today 항목에 옮긴 날부터 누적되는 배지: `+N = (오늘 − forDate) + 1`(옮긴 날 +1, 다음날 +2 …). 미완료로 이월될수록 증가, 완료 시 종료. 미룬 날수(부채)를 가시화 — Phase 11 Work Debt 지표 입력.
- **Routines(루틴) 영역 + 5영역 레이아웃 재설계(2026-05-21).** 보드에 반복 작업 영역 추가: 스케줄 매일/매주 요일(수·금 등)/매주(금), 오늘 해당 루틴만 표시, **완료는 날짜별(`RoutineCheck`)·다음날 리셋**. WorkSignal/매트릭스와 별개 엔티티(반복은 결정 큐에 안 쌓임). 보드를 **5영역**으로 재배치: 캡처(하단) → 미분류(좌) → 2×2(중앙) → 실행(우: Today 위·Routines 아래). 반응형 3단계: 가로 3컬럼 / 중간폭 우측 Today·Routines 세그먼트 탭 / 세로 세로스택+접기. (DESIGN.md "App Surface — 배치 규칙"에 ASCII 레이아웃.)
