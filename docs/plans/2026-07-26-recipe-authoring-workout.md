# Recipe Authoring + Workout Domain — 설계 정본

날짜: 2026-07-26. 발주: "음식 db에 레시피도 저장할 수 있게 db 확장하자. 레시피는 내가 에이전트
통해서 내 입맛에 맞게 계속 수정할거니까 mcp도 노출되야돼. 추가 아이디어가 있다면(식단 관리 및
운동) 제안해서 작업해봐"

선행 정본: `docs/plans/2026-07-17-diet-domain.md`(스냅샷 불변·FEFO·append-only 원칙).
이 문서는 그 원칙을 **깨지 않고** 레시피 저작(authoring)과 운동 도메인을 얹는다.

## 1. 문제 — 레시피 테이블은 이미 있는데 "반복 튜닝"이 불가능하다

`0073`이 `recipes` + `recipe_ingredients`를 이미 만들었고 MCP에 create/update/list 3툴이 있다.
그런데 발주의 핵심("에이전트를 통해 내 입맛에 맞게 **계속** 수정")을 놓고 보면 구조적으로 막혀 있다:

| 갭                                             | 결과                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `instructions`가 단일 TEXT 블롭                | 에이전트가 3단계만 못 고친다 — 매번 전문 재작성                                                         |
| 재료가 `qty_g` **only** (`NOT NULL CHECK > 0`) | 소금 1꼬집·간장 1큰술·마늘 3쪽을 적을 수 없다. **입맛 튜닝의 대부분이 양념 튜닝인데 그 축이 표현 불가** |
| 개정 이력 없음                                 | "계속 수정"이 되돌리기 불가. 무엇을 왜 바꿨는지 소실                                                    |
| 맛 피드백이 레시피로 되먹임되지 않음           | `meal_logs.satisfaction`은 그 끼니 만족도일 뿐, 레시피 축별 조정 근거가 아니다                          |
| `update_recipe` = 전체 교체(replace-all)       | 에이전트 편집마다 lost-update 창 — 그 사이 내 UI 편집이 사라진다                                        |

## 2. 결정 요약

- **레시피 저작은 1급 도메인으로 승격.** 단계(steps) 테이블 분리 + 비-g 단위 + 개정 이력 +
  축별 맛 피드백. 마이그레이션 `0075_recipe_authoring.sql`.
- **MCP는 patch형.** 전체 교체 툴 대신 재료 1개·단계 1개 단위 mutate. 모든 patch에
  `expected_rev_no`(optional) 낙관적 동시성.
- **조리는 원샷 커맨드.** `cook_recipe` = FEFO 재고 차감 + `consumed` 이벤트 + `meal_log` 기록을
  **단일 tx**. `0073` 계획이 "자동 차감은 후속 결정"으로 미뤄둔 걸 명시적 커맨드로 해소하되
  `record_meal_log`은 그대로 재고를 안 건드린다 → **이중 계상 경로가 생기지 않는다.**
- **운동은 별도 도메인**(`0076_workout_foundation.sql`), 풀스택(커널+IPC+MCP+뷰).
- **운동 도메인은 "실적 기록 + 체성분"만.** 계획·스케줄은 기존 `routines`/Today가 이미 한다.
- **식단↔운동 연동은 read-only 파생만.** `diet_goals`를 활동량으로 자동 수정하지 않는다.
- 네트워크 0(이 트랙 전체). 전 write가 로컬 SQLite.

## 3. 스키마 — `0075_recipe_authoring.sql`

### 3.1 `recipe_steps` (신규)

```
id, recipe_id → recipes(id) ON DELETE CASCADE,
sort_rank REAL NOT NULL,          -- 표시용 단계번호는 쿼리타임 파생
body TEXT NOT NULL,
duration_minutes INTEGER,          -- 타이머용
note TEXT                          -- 튜닝 메모("여기서 불 줄이면 안 눌러붙음")
```

`UNIQUE(recipe_id, step_no)`를 **쓰지 않는다.** SQLite에 deferred constraint가 없어서 중간
삽입·재정렬 시 재번호 UPDATE가 자기 자신과 충돌한다. `sort_rank REAL` + 조회 시
`ROW_NUMBER() OVER (ORDER BY sort_rank)`로 1-based 번호를 파생한다(레포의 `sort_rank` 선례와 일관).

에이전트/사람은 **파생 번호(`step_no`)로 지목**한다 — "3단계 고쳐"가 자연스러워야 하므로
커맨드가 `step_no` → 내부 id로 해석한다. 삽입은 `after_step_no`로 받아 중간 rank를 계산한다.

**기존 `instructions` 블롭 처리:** 마이그레이션이 non-empty `instructions`를 레시피당 단계 1개로
백필한다(데이터 무손실). 이후 `instructions` 컬럼은 **은퇴** — 커맨드·MCP·모델 표면에서 제거하고
컬럼만 남긴다(STRICT 테이블 컬럼 DROP은 테이블 재생성이 필요해 비용이 크다). 단계와 블롭이
동시에 "조리법 정본"이 되는 이중 진실원을 만들지 않는 게 목적이다.

### 3.2 `recipe_ingredients` 확장

```
+ qty REAL              -- 표기 수량 (1.5)
+ unit TEXT             -- 'g','ml','tbsp','tsp','cup','clove','ea','pinch','slice'
+ to_taste INTEGER NOT NULL DEFAULT 0 CHECK (to_taste IN (0,1))
```

`qty_g`는 **영양 계산의 SSOT로 그대로 유지**(`NOT NULL CHECK > 0`). `qty`/`unit`은 표기 + 입력
경로이고, 커널이 환산해 `qty_g`를 채운다. 환산 불가면 커맨드가 거부한다(조용한 0 금지).

`to_taste=1`은 "간 맞춰서" 표기용 플래그다. 영양 계산은 여전히 `qty_g`(사용자/에이전트가 넣은
명목값)를 쓴다 — to_taste를 영양에서 빼면 나트륨이 구조적으로 과소계상된다.

### 3.3 `unit_conversions` (신규)

```
id, unit TEXT NOT NULL, food_id TEXT NULL → foods(id) ON DELETE CASCADE,
grams_per_unit REAL NOT NULL CHECK (grams_per_unit > 0), note TEXT
-- food_id NULL = 전역 기본
CREATE UNIQUE INDEX uq_unit_conv_global ON unit_conversions(unit) WHERE food_id IS NULL;
CREATE UNIQUE INDEX uq_unit_conv_food   ON unit_conversions(unit, food_id) WHERE food_id IS NOT NULL;
```

**`UNIQUE(unit, food_id)` 테이블 제약을 쓰면 안 된다** — SQLite는 UNIQUE에서 NULL을 서로 구별하므로
전역 행(`food_id IS NULL`)이 무제한 중복된다. 그러면 `INSERT OR IGNORE` seed가 재실행 시 중복을
쌓고, 커널 lookup이 비결정적으로 갈린다. 위처럼 **부분 유니크 인덱스 2개**로 갈라야 한다.

커널 lookup 순서: **food-specific → 전역 → 실패(에러)**. 밀도 차이(소금 1tsp ≈ 6g vs 물 5g)를
식품별 행으로 덮는다.

**seed(사용자 결정 2026-07-26):** 전역 기본을 `INSERT OR IGNORE`로 넣는다 — 없으면 첫 레시피부터
막힌다. `g=1, ml=1, tsp=5, tbsp=15, cup=240, pinch=0.4, ea=50, slice=20, clove=5`.
`ea`/`slice`/`clove`는 명백히 식품별로 틀리므로 **전역값은 폴백일 뿐**이고 실제 식품 행이 이기게
설계한다. seed는 INSERT를 포함하므로 `0019` 선례에 따라 **멱등성 테스트 대상**이다.

### 3.4 `recipe_revisions` (신규)

```
id, recipe_id → recipes(id) ON DELETE CASCADE,
rev_no INTEGER NOT NULL,
snapshot_json TEXT NOT NULL,      -- 그 리비전의 **결과 상태** 전문(메타+재료+단계)
change_summary TEXT,              -- "간장 1큰술 → 2/3큰술 (너무 짰음)"
changed_by TEXT NOT NULL DEFAULT 'user' CHECK (changed_by IN ('user','agent')),
created_at
UNIQUE(recipe_id, rev_no)
```

- `rev 1` = 생성 시점. 매 mutate가 새 rev를 append한다.
- **되돌리기 = 과거 rev 스냅샷을 새 rev로 재적용**(append-only). 이력을 재작성하지 않는다 —
  레포 전역의 append-only/스냅샷 불변 철학과 동일.
- diff는 저장하지 않고 쿼리타임 계산(커널). 저장하면 스냅샷과 어긋날 수 있다.
- `recipes.rev_no`가 현재 리비전 캐시 컬럼. 낙관적 동시성 토큰으로도 쓴다.

### 3.5 `recipe_feedback` (신규)

```
id, recipe_id → recipes(id) ON DELETE CASCADE,
rev_no INTEGER,                    -- 어느 리비전을 먹고 남긴 평가인지
meal_log_id → meal_logs(id) ON DELETE SET NULL,
rating INTEGER CHECK (rating BETWEEN 1 AND 5),
salt_delta       INTEGER CHECK (BETWEEN -2 AND 2),
spice_delta      INTEGER CHECK (BETWEEN -2 AND 2),
sweet_delta      INTEGER CHECK (BETWEEN -2 AND 2),
sour_delta       INTEGER CHECK (BETWEEN -2 AND 2),
richness_delta   INTEGER CHECK (BETWEEN -2 AND 2),
doneness_delta   INTEGER CHECK (BETWEEN -2 AND 2),
comment TEXT, created_at
```

축을 JSON 블롭이 아니라 **인라인 컬럼**으로 두는 것이 이 설계의 핵심이다. 에이전트가
`AVG(salt_delta) WHERE rev_no >= N`을 SQL로 집계해서 "최근 3회 +1.3 → 간장을 줄인다"는
결정론적 근거를 얻는다. JSON이면 못 한다. (`foods`가 영양을 인라인 컬럼으로 두고 "EAV nutrient
테이블은 YAGNI 컷"한 선례와 동일 판단.)

부호 규약: **`+`는 "그 방향이 과했다"**(salt_delta +2 = 너무 짰다), `−`는 "부족했다". 커널의
튜닝 힌트 계산과 MCP 툴 설명에 같은 문장으로 고정한다.

### 3.6 `recipes` 확장

```
+ source_url TEXT           -- 출처(유튜브/블로그)
+ yield_g REAL              -- 완성 총량 — 1인분 g 파생·스케일링에 사용
+ notes TEXT                -- 상시 튜닝 메모(단계에 안 붙는 총평)
+ rev_no INTEGER NOT NULL DEFAULT 1
```

## 4. 커널 — `src-tauri/src/diet.rs` 확장 (순수 함수, 단위테스트)

- `resolve_qty_g(qty, unit, food_id, conversions) -> Result<f64>` — lookup 순서 고정, 실패는 에러.
- `scale_recipe(recipe, target_servings) -> ScaledRecipe` — 재료 g 비례 스케일 + 영양 재계산.
- `recipe_snapshot(recipe) -> snapshot_json` / `apply_snapshot(snapshot) -> RecipeDraft` —
  리비전 왕복. **왕복 불변식(round-trip) 테스트**가 계약.
- `revision_diff(a, b) -> Vec<RecipeDiffEntry>` — 재료 추가/삭제/수량변경/단계변경 분류.
- `taste_hints(feedback[]) -> Vec<TasteHint>` — 축별 가중 평균(최근 가중) → "salt: reduce" 수준의
  **제안**만. 자동 수정은 하지 않는다(결정레일: 에이전트/사람이 정한다).
- `pantry_coverage(recipe, lots, pending) -> Coverage` — 재고 커버리지 % + 부족분 g.
- `suggest_recipes(recipes, lots, goal, today) -> Vec<Suggestion>` — **결정론 정렬**:
  ① 재고 커버리지 ② 유통기한 임박 재료 소진 점수(FEFO 압력) ③ 목표 대비 적합도(kcal/단백질).
  LLM 아님. 동점은 이름 순으로 안정 정렬(테스트 결정론).

## 5. IPC 커맨드 (레시피)

`src-tauri/src/commands/diet/recipes.rs` 확장:

| 커맨드                                                            | 성격                                               |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| `patch_recipe(id, expected_rev_no?, fields…)`                     | 준 필드만 수정 → 새 rev                            |
| `set_recipe_ingredient` / `remove_recipe_ingredient`              | 재료 1개 upsert/삭제 (qty+unit 입력 가능) → 새 rev |
| `set_recipe_step` / `remove_recipe_step` / `reorder_recipe_steps` | 단계 1개 단위 → 새 rev                             |
| `list_recipe_revisions(id)` / `get_recipe_revision(id, rev_no)`   | 이력 조회 + diff                                   |
| `revert_recipe(id, rev_no)`                                       | 과거 rev를 **새 rev로 재적용**                     |
| `add_recipe_feedback` / `list_recipe_feedback`                    | 축별 맛 피드백 기록/조회 + `taste_hints` 파생      |
| `scaled_recipe(id, servings)`                                     | 스케일 재료 + 재고 부족분                          |
| `cook_recipe(...)`                                                | §6                                                 |
| `recipe_suggestions(date?, limit?)`                               | 재고 기반 추천                                     |
| `upsert_unit_conversion` / `list_unit_conversions`                | 환산 테이블 관리                                   |

`create_recipe`/`update_recipe`는 유지하되 입력에서 `instructions`를 제거하고 `steps`를 받는다.
**모든 mutate는 리비전 append를 포함한 단일 tx**(리비전 없는 mutate = 계약 위반).

## 6. `cook_recipe` — 단일 tx 계약

입력: `recipe_id`, `servings`, `date`(프런트 주입), `at`, `meal_type`, `planned_meal_id?`,
`consume_pantry: bool`(기본 true), `note?`.

한 tx 안에서:

1. 커널로 스케일 재료 g + 영양 스냅샷 계산 (tx 진입 전 검증 완료)
2. `consume_pantry`면 재료별 FEFO 차감 — 부족하면 **전체 롤백**(부분 차감 금지) + 부족분을 에러에 실어 노출
3. `meal_logs` INSERT (영양 = 커널 스냅샷)
4. 재료별 `pantry_events(kind='consumed', meal_log_id=…)` INSERT
5. `planned_meal_id`가 있으면 상태 전이 `planned → eaten`

`record_meal_log`은 **그대로 재고를 건드리지 않는다** — 재고 차감 경로는 `consume_pantry`(명시)와
`cook_recipe`(조리) 둘뿐이고, 후자는 `meal_log_id`로 연결되므로 감사에서 이중 계상이 식별된다.
`pantry_lots.remaining_qty_g >= 0` CHECK가 동시성 최종 방어선(제거 금지).

## 7. MCP 표면 (레시피)

`src-tauri/src/mcp/tools/diet_manage.rs` 확장 — diet 도메인 전권 위임(2026-07-17 사용자 결정)
아래이므로 새 위임 결정은 필요 없다. read/write 모두 로컬 SQLite.

read: `wr_diet_get_recipe`(전문+현재 rev+피드백 집계+튜닝 힌트) · `wr_diet_recipe_revisions` ·
`wr_diet_recipe_scaled` · `wr_diet_recipe_suggestions`

write: `wr_diet_patch_recipe` · `wr_diet_set_recipe_ingredient` · `wr_diet_remove_recipe_ingredient` ·
`wr_diet_set_recipe_step` · `wr_diet_remove_recipe_step` · `wr_diet_reorder_recipe_steps` ·
`wr_diet_revert_recipe` · `wr_diet_add_recipe_feedback` · `wr_diet_cook_recipe` ·
`wr_diet_upsert_unit_conversion`

- 모든 patch 툴에 `expected_rev_no: Option<i32>` — 불일치 시 거부(낙관적 동시성). 에이전트 편집과
  내 UI 편집이 겹치는 창을 닫는다. 툴 설명(description)에 "`wr_diet_get_recipe`로 읽은 `revNo`를
  그대로 넘겨라"를 명시한다 — optional로 둔 이유는 UI/단발 호출 편의이고, 에이전트 편집 루프에서는
  넘기는 게 정상 경로다.
- `deny_unknown_fields`를 **중첩 struct마다** 적용(serde 비상속). 스키마 스냅샷이 실제
  `additionalProperties:false` 박힘을 확인.
- `surface_tests` 이름 스냅샷 갱신 + 스키마 스냅샷.
- `delete_recipe`류는 표면에 없음(기존 `set_recipe_archived`만 — 앱 UI confirm 전용 유지).

## 8. 운동 도메인 — `0076_workout_foundation.sql`

```
exercises          (id, name, modality CHECK(strength|cardio|mobility|sport),
                    primary_muscle, equipment, met REAL, default_unit,
                    source, source_ref, archived, created_at, updated_at)
exercise_aliases   (exercise_id, alias, normalized UNIQUE)     -- foods/food_aliases 패턴 재사용
workout_sessions   (id, date, started_at, ended_at, title,
                    perceived_exertion INTEGER CHECK(1..10), note, created_at, updated_at)
workout_sets       (id, session_id → CASCADE, exercise_id, sort_rank INTEGER,
                    reps INTEGER, weight_kg REAL, duration_sec INTEGER,
                    distance_m REAL, rest_sec INTEGER, rpe INTEGER CHECK(1..10), note)
body_metrics       (id, measured_on, weight_kg, body_fat_pct, skeletal_muscle_kg,
                    waist_cm, note, source, created_at)         -- 시계열
body_profile       (id CHECK(id='singleton'), birth_year, height_cm,
                    sex CHECK(male|female|other), updated_at)   -- 단일행
```

**경계 결정 2개 (중요):**

1. **계획·스케줄을 만들지 않는다.** 기존 `routines`(습관 트래킹 + 캘린더 미러)가 이미 그 일을
   한다. 운동 도메인은 **실적 기록 + 체성분**만. `workout_sessions.routine_id` 링크도 두지
   않는다 — KR↔루틴 자동집계에서 겪은 파생 이중계상 위험을 반복하지 않는다(필요해지면 별도 결정).
2. **`diet_goals`를 활동량으로 자동 수정하지 않는다.** 목표는 append-only 스냅샷이고, 파생
   판단값을 자동으로 설정하는 것은 결정레일 INVARIANT #1 위반이다. 연동은 **read-only 파생**뿐.

**seed(사용자 제공값, 2026-07-26):** `body_profile` = `birth_year=1987, height_cm=171, sex='male'`,
`body_metrics` 첫 행 = `measured_on='2026-07-26', weight_kg=69, source='seed'`.
체중은 변하므로 profile이 아니라 **시계열**에 들어간다. INSERT 포함 → 멱등성 테스트 대상.

### 8.1 커널 — `src-tauri/src/workout.rs` (신규, 순수)

- `session_volume(sets) -> Volume` — 총 톤수(∑reps×weight), 세트 수, 종목별 분해.
- `estimated_1rm(reps, weight) -> f64` — Epley. 종목별 최고 기록 추적.
- `energy_burned(sets, met, weight_kg) -> f64` — `MET × kg × hours`. 결정론.
- `bmr(profile, weight_kg, on_date) -> f64` — Mifflin-St Jeor. 나이는 `on_date.year - birth_year`.
- `daily_energy_balance(intake_kcal, bmr, workout_kcal) -> Balance` — 순수 산술 파생.
- `weight_trend(metrics, window) -> Trend` — 이동평균(일별 노이즈 제거).

프로필/체중이 없으면 BMR을 **계산하지 않는다**(`None`) — 추정치를 조용히 꾸미지 않고 UI/MCP가
"프로필 필요"를 노출한다.

### 8.2 IPC + MCP (운동)

IPC `src-tauri/src/commands/workout/{exercises,sessions,sets,body}.rs`:
종목 upsert/검색/아카이브, 세션 CRUD, 세트 add/patch/remove/reorder, 체성분 기록/조회,
프로필 조회/수정, 파생(주간 볼륨, 종목별 PR, 에너지 밸런스).

MCP `src-tauri/src/mcp/tools/workout.rs`:
read = `wr_workout_recent_sessions` · `wr_workout_session` · `wr_workout_volume_summary` ·
`wr_workout_body_trend` · `wr_workout_search_exercises`
write = `wr_workout_start_session` · `wr_workout_patch_session` · `wr_workout_add_set` ·
`wr_workout_patch_set` · `wr_workout_remove_set` · `wr_workout_record_body_metric` ·
`wr_workout_upsert_exercise` · `wr_workout_set_body_profile`

**새 도메인이므로 `mcp-server-conventions.md` §1.1에 위임 예외 절을 추가한다** —
"운동 domain 위임 예외(2026-07-26): 사용자 발주로 실적 기록 전권 위임. 전 write가 로컬 SQLite
(외부 mutate 0), 세션·세트·체성분은 관측 사실, 계획/스케줄 표면 없음(routines가 소유),
`diet_goals` mutate 능력 없음, 사람 게이트는 호스트 승인 UI(ADR-0012)."
`workout_sessions` 삭제류는 표면에 두지 않는다(앱 UI confirm 전용).

## 9. 프런트

- **DietView 레시피 개편**(`LibrarySection` + 신규 `RecipeEditor`): 단계 편집(추가/삭제/재정렬,
  분 단위 타이머), 재료 unit 입력, 리비전 타임라인(diff + 되돌리기), 축별 피드백 입력,
  추천 카드, "조리" 버튼(→ `cook_recipe`).
- **WorkoutView**(신규) + `nav.ts` 등록: 오늘 세션 기록(빠른 세트 입력: 종목 → reps×weight 반복),
  히스토리, 주간 볼륨, 체중/체성분 추이, **바디 프로필 편집**(사용자 요청: "나중에 바디프로필
  관리까지 되면 좋겠네" — 뷰를 만드는 슬라이스에서 같이 넣는 게 싸다).
- DietView/WorkoutView에 에너지 밸런스 표시(프로필 없으면 안내).
- 뷰 루트는 `height: 100%`(뷰포트 단위 금지 — `view-shell` 클립 회귀 가드), lazy 스플리팅 패턴 준수.

## 10. 슬라이스 — 각 슬라이스가 게이트 green + critic 별도 패스

| S   | 내용                                                                        |
| --- | --------------------------------------------------------------------------- |
| 1   | `0075` + 커널(환산·스케일·스냅샷 왕복·diff·힌트·커버리지·추천) + models     |
| 2   | 레시피 IPC 커맨드 + **프런트 최소 적응**(steps 편집 — typecheck green 유지) |
| 3   | 레시피 MCP patch형 툴 + surface/스키마 스냅샷                               |
| 4   | `cook_recipe` 단일 tx + 추천 IPC/MCP                                        |
| 5   | DietView 레시피 UX 본편(리비전 타임라인·피드백·추천·조리)                   |
| 6   | `0076` + `workout.rs` 커널 + models                                         |
| 7   | 운동 IPC + MCP(+ 컨벤션 §1.1 위임 절)                                       |
| 8   | WorkoutView + nav + 바디 프로필 편집                                        |
| 9   | 에너지 밸런스 파생 + 양쪽 뷰 표시                                           |
| —   | `area-map.md` 행 갱신(19 확장 + 운동 신규 행), `docs/decisions.md` 한 줄    |

S2가 `instructions` 제거로 프런트를 깨뜨리므로 **같은 슬라이스에서 최소 적응**을 포함한다
(슬라이스 경계에서 게이트가 red가 되면 안 된다). S5가 UX 본편을 담당한다.

## 11. 결정레일 검토

- 전 write가 로컬 SQLite → 외부 mutate 0 → Acceptance 게이트 비대상(INVARIANT #2 명시 예외).
- diet는 기존 전권 위임 아래, 운동은 이 문서에서 새 위임 절을 추가(사용자 발주 근거 명시).
- **파생 판단값 자동 설정 없음:** `taste_hints`는 제안만(자동 레시피 수정 없음),
  `daily_energy_balance`는 순수 파생 읽기, `diet_goals`는 사람만 쓴다.
- 스냅샷 불변 유지: `planned_meal_items`/`meal_logs` 영양은 여전히 추가 시점 스냅샷 —
  레시피 리비전이 과거 계획·기록의 수치를 바꾸지 않는다. **이 불변식에 회귀 테스트를 둔다.**
- append-only 유지: 리비전·재고 이벤트·피드백 모두 append. 되돌리기도 새 rev.
- 네트워크 0.

## 12. 검증 계약

슬라이스마다: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`
(husky pre-commit 전에 `cargo fmt`, `git add` 순서 주의) + bindings drift +
`pnpm typecheck` + `pnpm lint` + `pnpm vitest run`.

**`pnpm typecheck`는 항상 마지막에 재실행** — `cargo test`가 `bindings.ts`를 재생성하므로
stale-green이 발생한다(선례: 예산 탭 트랙에서 critic 적발).

핵심 회귀 테스트:

- 리비전 스냅샷 **왕복 불변식**(snapshot → apply → snapshot 동일)
- 레시피 수정이 **과거 `meal_logs`/`planned_meal_items` 영양을 바꾸지 않음**
- `cook_recipe` 재고 부족 시 **전체 롤백**(부분 차감 0건)
- `cook_recipe` + `record_meal_log` 조합에서 **이중 차감 없음**
- `expected_rev_no` 불일치 거부
- 단위 환산 lookup 순서(food-specific > 전역 > 에러)
- seed 마이그레이션 **멱등성**(`0019` 선례)
- 추천 정렬 **결정론**(동점 안정 정렬)
- BMR: 프로필/체중 없으면 `None`(조용한 추정 금지)
