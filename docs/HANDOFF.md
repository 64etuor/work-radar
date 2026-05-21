# Work Radar — 세션 핸드오프 (현재: Phase 1 시작 직전)

> 새 세션은 **이 파일 + 아래 정본들**을 먼저 읽고 시작한다. 이전 대화 컨텍스트 없이도 진행 가능하도록 작성됨.

## 지금 상태

- **Phase 0(스켈레톤 & 스파인) 완료·검증·커밋됨.** 레포 `64etuor/work-radar`(Private), main·dev 푸시, CI 그린.
  - Tauri 2 + Vite + React 19 + TS + Tailwind v4 + cmdk + TanStack Query + Zustand.
  - Rust: tokio · sqlx(SQLite)+migrations · keyring 3.x · tauri-specta(=2.0.0-rc.25).
  - SQLite 스키마 v1(6테이블 + FTS5), `list_projects` IPC 라운드트립, 전역 핫키 창 토글.
- **디자인 = Cohere(white editorial).** 정본 = 루트 `DESIGN.md`. 프런트 토큰 `wr-*`(`src/styles.css`).
- **Phase 1 계획 확정(코드 미구현).** 캡처 보드 = 5영역(미분류·2×2·Today·Routines·캡처), 매트릭스가 주 영역.
  인터랙션 레퍼런스 프로토타입 완성·검증(세로/가로 반응형): `docs/prototypes/capture-board.html`.
- **다음 = Phase 1 (Capture Board) 구현** — `dev` 브랜치에서.

## 먼저 읽을 정본

1. `PLAN.md` — §1 INVARIANTS(절대규칙 7개) + Phase 1 Deliverables/Done-criteria
2. `DESIGN.md` — 특히 **"App Surface — Capture Board"** 섹션
3. `docs/architecture.md` — 데이터 모델(WorkSignal/Promotion/Acceptance), 3-rail, SSOT
4. `docs/decisions.md` — Phase 0 + Phase 1 인터랙션 결정
5. `AGENTS.md` — working agreement
6. `docs/prototypes/capture-board.html` — **인터랙션 레퍼런스**(브라우저로 열기). 불투명 화이트 5영역 보드
   (드래그 분류 · Today 승격 · 루틴 체크 · 반응형)가 그대로 구현 목표.

## Phase 1 스코프 (한 번에 한 Phase, PLAN.md Phase 1 done-criteria만)

핵심 결정(상세는 `decisions.md` "Phase 1 인터랙션"):

- **캡처 보드 = 현행 불투명 앱 창**(흰 캔버스 Cohere). 전역 핫키 토글, Esc 닫기. 투명 데스크톱 오버레이는 폐기.
- **5영역 레이아웃:** 캡처(하단) → 미분류 INBOX(좌) → 아이젠하워 2×2(중앙, **주 영역 ~60%, min 440px**) → 실행(우: Today 위·Routines 아래).
- **분류 = 사람 결정 레일(INVARIANT #1):** 카드는 **항상 unclassified로 생성**. 드래그 분류(주) + `1/2/3/4` 가속.
  사분면에 들어가면 **Q1~Q4 태그(배지) 획득**(이동해도 유지).
- **촤라락**(진입 staggered fan-out) + 입력 시 **톡(pop)**.
- **개인/업무 태그:** 입력 맨 앞 토큰 마커 우선(개인:`개인/내/나/사적`, 업무:`업무/일/회사/직장`), 없으면 토글값, **기본 업무**.
  맨 앞 토큰 정확매칭(오탐 방지). `WorkSignal.kind` 저장 → Phase 2에서 projectId reconcile.
- **Today's Todo(우상단):** 매트릭스 카드를 드래그/액션/`T`로 승격(**로컬 = Acceptance 불요**). 승격 시 **매트릭스에서 제거**,
  Q배지 유지. 완료 체크 + **미완료 다음날 rollover**. **경과일 카운터 `+N`**(옮긴 날 +1, 이월마다 +1, 완료 시 종료).
  **매트릭스로 되돌리기(승격 취소)** 버튼 — 원 사분면 복귀(없으면 미분류), Today에서 제거.
- **Routines(우하단):** 반복 작업. 스케줄 **매일/매주 요일(수·금)/매주(금)**. 오늘 해당분만 표시, **날짜별 완료 체크**(다음날 리셋). 매트릭스와 별개 엔티티.
- **카드 액션 메뉴(⋯ / Cmd+K / 우클릭):** 백로그·안건·캘린더 = `Promotion` draft(= **Acceptance**, 외부 write는 Phase 3/11) + Today/snooze/done/archive(`T/S/D/E`).
- **반응형 3단계:** 가로 3컬럼 / 중간폭 우측 Today·Routines 합침 / **≤900px 세로 스택**. (세로·가로 모니터 모두 검증됨, overflow 0.)
- `area`/`suggestedArea`는 스키마 필드만(**AI 영역 추론은 Phase 9 enrich**). `WorkSignal` CRUD + dedup, FTS5 검색, 재시작 상태 유지.

## 운영 노트 (환경 함정)

- **Rust 툴체인:** `$HOME/.cargo/bin`. cargo 쓰기 전 매번 `export PATH="$HOME/.cargo/bin:$PATH"`.
  cargo 명령은 `src-tauri/`에서.
- **rtk 훅 주의:** `curl | sh`, `tail`, `cat`의 스트리밍 출력을 잘라 깨뜨림 → 파일로 받아 **Read 도구**로 읽기.
  백그라운드 작업 종료 요약의 exit code는 못 믿음 → 로그에 `echo "EXIT=$?"` 남기고 실제값 확인.
- **bindings.ts:** `cargo test`의 export 테스트가 생성(프런트 빌드 전 필요). 수기 IPC 타입 금지(specta).
- **GUI 검증:** 실제 창 표시/핫키/드래그 동작은 **사용자 관찰 항목**으로 명시. 헤드리스에선
  `cargo build/test/clippy` + `pnpm build`(tsc) + 필요시 `pnpm tauri dev` 부팅 로그로 검증.
- **커밋:** 모두 `dev`에 푸시됨. 작업은 dev에 직접 push(PR 불필요), main은 PR로만(아래 Git 워크플로우).

## Git 워크플로우 (중요)

- **항상 `dev`에서 작업/커밋/push.** `main`은 PR(dev → main)로만 머지(안정 스테이지).
- `git push origin main` 은 `.husky/pre-push` 훅이 **차단**(긴급 우회: `--no-verify`).
  서버측 보호는 private+free라 불가(Pro/public 필요) → 현재 로컬 훅으로만 강제.
- gh 활성 계정이 가끔 `yanghapark`로 바뀜 → `gh auth switch --user 64etuor`로 고정 후 작업.
- 레포: `64etuor/work-radar` (Private). CI(main·dev): rust fmt/clippy/test + frontend typecheck/build.

## 시작 명령(새 세션에 붙여넣기)

```
/oh-my-claudecode:ralph work-radar Phase 1 (Capture Board) 진행.
먼저 docs/HANDOFF.md 와 PLAN.md(§1 + Phase 1), DESIGN.md(App Surface — Capture Board) 읽고 그대로 따른다.
한 번에 한 Phase, PLAN.md Phase 1 done-criteria로 자가검증. INVARIANTS 7개 준수(특히 자동분류 금지).
```
