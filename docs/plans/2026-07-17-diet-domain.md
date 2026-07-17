# Diet Domain — 식단·재고·장보기·주문내역 (PRD → work-radar 축소 매핑)

날짜: 2026-07-17. 원 PRD: 개인 식단·식재료 구매 에이전트 시스템 v0.1 (대화 첨부).

## 결정 요약

- **DB는 work-radar SQLite** (Hermes 아님 — Hermes는 MCP 클라이언트). 근거: PRD §5.2가
  스스로 "Hermes 메모리는 거래 원장이 아니다"라 명시; work-radar에 MCP proposal-only 경계·
  audit·keychain·가계부·캘린더/루틴이 이미 존재.
- **스택 치환:** PostgreSQL/Temporal/FastAPI/OR-Tools/마이크로서비스 → SQLite 마이그레이션 +
  Rust 커맨드 + 순수 계산 커널(`src-tauri/src/diet.rs`) + MCP 툴. household/RLS = YAGNI 컷.
- **결제/주문 자동화는 범위 밖** (사용자 직접 구현 예정). 이 트랙은 **기록·계산까지만**:
  주문 내역은 수동/외부 기록용 원장(`grocery_orders`), 체크아웃 경로 없음.
- **PRD 보존 원칙:** LLM은 제안만·계산은 결정론(커널) / 스냅샷 불변(계획·섭취 시점 영양 고정) /
  재고 append-only 이벤트 + FEFO / 목표는 append-only 버전.

## 스코프 (이 트랙)

| Slice | 내용                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | 마이그레이션 `0073_diet_foundation.sql` + 순수 커널 `diet.rs`(영양 계산·FEFO·목표 검증, 단위테스트) + `models/diet.rs`                     |
| 2     | `commands/diet/{foods,recipes,goals,plans,logs,pantry,orders,shopping}.rs` IPC 커맨드 + lib.rs 등록 + bindings                             |
| 3     | MCP `mcp/tools/diet.rs` — read(오늘 식단/일일 영양/재고/유통기한/장보기/식품검색) + 사실기록 write(`wr_diet_record_meal`) + surface 스냅샷 |

Deferred (명시): 프런트 DietView(별도 트랙), K-FIND 대량 임포트(별도 참조 DB attach 검토),
식단 자동 생성 최적화 엔진(후보·제약 커널은 이번에, 조합 최적화는 후속), 쿠팡 연동 전부,
**섭취 기록→재고 자동 차감 연동**(`record_meal_log`는 pantry를 건드리지 않는다 — 의도적 분리;
차감은 명시적 `consume_pantry` 호출, `pantry_events.meal_log_id`로 연결. 자동 차감은 후속 결정).

## 명시적 결정 (critic 리뷰 반영, 2026-07-17)

- **다중-쓰기 커맨드는 단일 tx가 계약.** `receive_order_line` = 조건부 `received=0→1` UPDATE가
  게이트인 단일 tx(로트+purchased 이벤트 합류 — 크래시 창/TOCTOU에서 이중 계상 불가);
  `record_meal_log` planned 경로 = 상태 전이+INSERT 단일 tx. consume/adjust/waste도 읽기를
  tx 안으로. `pantry_lots.remaining_qty_g >= 0` CHECK는 동시성 최종 방어선 — 제거 금지.
- **장보기 pending 의미**: 취소되지 않은 주문의 `received=0` 라인(주문 상태 ⊥ 라인 입고).
- **optional 재료도 장보기 필요량에 포함**(레시피 영양 합산과 일관 — 뺄 거면 레시피에서 빼라).
- **0073은 DDL-only(CREATE TABLE/INDEX)**라 sqlx 마이그레이터가 1회 실행을 보장 — 별도
  멱등성 테스트 비대상(0019 선례는 INSERT seed가 있는 마이그레이션에 적용).

## 스키마 설계 (0073)

- `foods` — 표준 식품(100g당 영양 컬럼 인라인; EAV nutrient 테이블 YAGNI 컷). `source`/`source_ref`로 출처 보존.
- `food_aliases` — 검색 별칭(정규화 UNIQUE).
- `diet_goals` — append-only 목표 버전(effective_date; 활성=오늘 이하 최신).
- `recipes` + `recipe_ingredients` — 재료는 g 정규화(`qty_g`), 영양은 쿼리타임 커널 계산.
- `meal_plans`(목표 스냅샷 컬럼) + `planned_meals` + `planned_meal_items`(**추가 시점 영양 스냅샷** — 이후 food/recipe 수정이 과거 계획을 바꾸지 않음).
- `meal_logs` — 실제 섭취 단일 원장(계획 연결 optional, 자유 외식 기록 가능, 만족도/포만감). 일일 실적 = meal_logs 합산.
- `pantry_lots`(로트 단위 재고, 유통기한) + `pantry_events`(append-only: purchased/consumed/adjusted/wasted/expired). 차감은 FEFO.
- `grocery_orders` + `grocery_order_lines` — 주문 내역 원장(merchant 자유 텍스트, 쿠팡 한정 아님). `receive_order_line` → pantry lot 입고 + `purchased` 이벤트.

금액은 KRW 정수(i32 — specta i64 금지). 날짜/시각 TEXT(RFC3339/`YYYY-MM-DD`), 로컬 날짜는
프런트/호출자가 주입(data-layer-conventions "날짜는 프런트가 주입").

## 결정레일 검토

- 로컬 SQLite 기록만 — 외부 mutate 없음 → Acceptance 게이트 비대상(INVARIANT #2 명시 예외).
- MCP write는 §1.1 캡처 레인 원칙: `wr_diet_record_meal` = "먹었다"는 **사실 기록**.
  식단 승인/목표 변경/재고 보정/계획 편집은 MCP 표면에 넣지 않는다(파생 판단값 직접 설정 금지).
- 네트워크 0 (이 트랙 전체).

## 검증 계약

`cargo test`(커널+store 단위테스트+MCP 스냅샷) + `cargo clippy --all-targets -- -D warnings` +
`cargo fmt --check` + bindings drift + `pnpm typecheck`(**마지막 재실행** — cargo test가
bindings 재생성하므로 stale-green 방지) + critic 별도 패스.
