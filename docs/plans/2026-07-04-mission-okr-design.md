# Mission / OKR 페이지 — 설계 (2026-07-04)

## 목적

장기 Mission과 분기 OKR을 한 페이지에서 관리하는 **실행 추적형** 기능.
매일의 braindump(신호)와는 **수동 링크 없이** 연결한다 — Objective에 Life Wheel
area·project를 매핑해두면 기존 신호 태깅만으로 자동 집계된다.

사용자 결정(브레인스토밍 확정):

- 핵심 용도 = 실행 추적(진짜 OKR): 진척 수치, 체크인 주기, 분기 회고.
- 계층 = **Mission → 분기 Objective/KR** 2단. 연간 목표 계층 없음.
- braindump 연결 = **수동 링크 최소화**: Objective↔area/project 매핑으로 자동 집계.
  카드→KR 직접 태깅은 이번 범위 밖(모델은 확장 가능하게만).
- KR 측정 = **수치형 + 마일스톤형** 둘 다.
- 체크인 리듬 = **주간 체크인**(값 + 자신감 + 한 줄 노트). 리마인더/알림 없음 —
  Weekly Review에 미체크인 프롬프트 카드 1개만.

## 데이터 모델 (마이그레이션 0066) — 승인됨

전부 마이그레이션으로만 추가. 신호 스키마는 무변경.

- **`missions`** — 사실상 1행. `id`, `statement`, `note`, `updated_at`.
  이력 미보관(YAGNI).
- **`objectives`** — `id`, `quarter`(텍스트 키, 예 `"2026-Q3"`), `title`,
  `description`, `sort_rank`, `status`(`active`/`closed`),
  `closed_reflection`(nullable), `linked_area_keys`(JSON 배열, Life Wheel area 키),
  `linked_project_ids`(JSON 배열), `created_at`, `updated_at`.
  분기 전환 = quarter 문자열 필터(셀렉터). 매핑은 objectives가 소유(조인 테이블 없음).
- **`key_results`** — `id`, `objective_id`(FK CASCADE), `title`,
  `kind`(`metric`/`milestone`), `target_value`/`current_value`/`unit`(수치형,
  nullable), `milestones`(JSON `[{label, done}]`, 마일스톤형), `sort_rank`,
  `created_at`, `updated_at`. **진척률은 파생 계산**(metric=current/target,
  milestone=done 비율) — 저장하지 않는다.
- **`okr_check_ins`** — `id`, `key_result_id`(FK CASCADE), `week_start`(날짜),
  `value_snapshot`(체크인 시점 진척 스냅샷, Rust가 채움),
  `confidence`(`on_track`/`at_risk`/`off_track`), `note`, `created_at`.
  `UNIQUE(key_result_id, week_start)`, 재체크인 upsert.

## IPC (tauri-specta) — 승인됨

`src-tauri/src/models/okr.rs` + `src-tauri/src/commands/okr.rs` 신규.
전부 `Result<_, AppError>`, `collect_commands![]` 등록 → `bindings.ts` 재생성.
수치는 f64/i32 (specta i64 금지). 외부 네트워크 없음.

- Mission: `get_mission`, `set_mission`
- Objective: `list_objectives(quarter)`, `create_objective`,
  `update_objective`(단일 update — 로컬 단일 사용자, per-field 불필요),
  `close_objective(reflection)`, `delete_objective`
- KR: `create_key_result`, `update_key_result`(현재값·마일스톤 토글 포함),
  `delete_key_result`
- 체크인: `upsert_check_in(key_result_id, week_start, confidence, note)` —
  `value_snapshot`은 Rust가 그 시점 KR에서 읽어 채움. `list_check_ins(quarter)`
- 자동 집계: `objective_signal_stats(quarter)` — objective별
  `linked_area_keys`/`linked_project_ids`로 signals 조인, 주간/분기 누적
  {캡처 수, 완료 수, 스케줄된 분}. 기존 `signal_time_totals` SQL 패턴 재사용.

## UI

새 최상위 뷰 **Mission** (`src/components/MissionView.tsx` + 하위는
`src/components/okr/`). `App.tsx` `renderView()` + `useUIStore` 네비 등록,
기존 \*View 패턴 준수(`docs/areas/frontend-shell.md`). 시각은 `DESIGN.md`
(Cohere white editorial) + shadcn/ui + typo-\* 토큰.

레이아웃(위→아래):

1. **Mission 헤더** — statement 한 문장 크게(에디토리얼 타이포), 클릭 인라인 편집.
2. **분기 셀렉터 + 진행률 요약** — 현재 분기 기본, 과거 분기 열람. 분기 경과율
   대비 전체 진척 한 줄.
3. **Objective 카드 목록**(2~4개) — 카드마다: 제목/설명, 매핑된 area 칩·project 칩,
   파생 진척 바, **자동 집계 라인**("이번 주 캡처 n · 완료 n · nh"), KR 행들.
   - KR 행: 제목, metric이면 `current/target unit` 인라인 수정, milestone이면
     체크리스트 팝오버, 파생 진척 바, 최근 체크인 confidence 도트
     (초록/노랑/빨강).
4. **주간 체크인 패널** — 이번 주(월요일 기준 week_start) 체크인 안 된 KR 목록을
   한 화면에서 일괄 기록: 값 확인/수정 → confidence 3버튼 → 노트 한 줄.
   완료 시 카드의 confidence 도트 갱신.
5. **분기 마감** — closed 처리 시 reflection 한 줄 입력, 카드들은 읽기 전용
   아카이브 렌더(체크인 이력 스파크라인).

Objective 편집 다이얼로그: 제목/설명 + Life Wheel 태그 멀티셀렉트(기존
LifeWheelPalette 태그 소스 재사용) + project 멀티셀렉트.

**Weekly Review 연동**: WeeklyView 상단에 프롬프트 카드 1개 — 이번 주 미체크인
KR이 있으면 "OKR 체크인 n개 남음 → Mission으로" 링크. 그 이상의 침투 없음.

## 검증

- Rust: `cargo test`(store/집계/upsert 유닛) + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`
- 프런트: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`(진척 파생 계산,
  week_start 계산 유닛)
- `bindings.ts` drift 없음(재생성 커밋)
- 슬라이스마다 codex critic(read-only) ACCEPT 후 커밋

## 슬라이스

1. **S1 백엔드 기반**: 마이그레이션 0066 + models/okr.rs + store 레이어 + 유닛 테스트
2. **S2 IPC**: commands/okr.rs 전체 + specta 등록 + bindings 재생성 + 집계 쿼리 테스트
3. **S3 프런트 기반**: query 레이어(`src/lib/query/okr.ts`) + MissionView 스켈레톤 + 네비 등록
4. **S4 OKR UI**: Objective/KR CRUD UI + 체크인 패널 + 분기 셀렉터/마감
5. **S5 연동 마무리**: 자동 집계 표시 + Weekly Review 프롬프트 카드 + 폴리시/디자인 정리

범위 밖(명시적 deferred): 신호→KR 직접 링크, 체크인 리마인더/알림, 연간 목표 계층,
Mission 이력.
