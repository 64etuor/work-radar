---
status: live
owner: repo-maintainers
last_reviewed: 2026-07-22
source_of_truth_scope: CFO Bot(Hermes) ↔ Work Radar 가계부 판단 파이프라인 계약 — 입력 소스·저장 스키마·리뷰 기준·taxonomy·중복 precheck·민감정보 금지·MCP 툴 표면·시간당 폴링 루프
---

# Bookkeeping CFO-Bot Contract — Hermes ↔ Work Radar

이 문서는 **CFO Bot(Hermes)** 이 가계부 데이터를 판단하고 Work Radar에서 안전하게 관리하는
계약이다. 역할 분리가 핵심:

- **CFO Bot(Hermes):** OCR/이메일 추출, merchant/category/항목 추론, 저신뢰 판정, 중복 precheck,
  시간당 폴링 오케스트레이션, 사용자가 승인한 거래·예산·반복 지출 관리.
- **Work Radar:** 저장·감사·dedup·리뷰큐·스키마 검증. 외부 서비스 호출이 아닌 **로컬 SQLite 쓰기**.

경계 정본은 `docs/areas/mcp-server-conventions.md`(특히 finance/bookkeeping 도메인 위임 예외).
데이터 레이어는 `docs/areas/data-layer-conventions.md`. 이 문서는 그 위에서 **가계부 도메인 계약**만 다룬다.

## 1. 역할 경계 (불변)

- raw email body / 영수증 이미지 / 파일 경로 / 토큰 / credential은 **Work Radar로 전달 금지.**
  MCP save/read 툴 스키마에 해당 필드가 **존재하지 않는다**(거부됨). Hermes는 추출·정제 후
  **사람이 검토 가능한 짧은 sanitized 필드만** 보낸다.
- **로컬 읽기·쓰기 툴은 모든 MCP caller에 개방**(ADR-0012). 각 호스트의 tool-call 승인 UI가
  사람 게이트이며, Work Radar 안의 Hermes 세션에는 `WORK_RADAR_MCP_CALLER=hermes`와 동일 app-data
  DB 경로를 고정한 내장 MCP descriptor가 자동 주입된다. caller env는 외부 서비스 direct-write
  라우팅 표식이지 로컬 SQLite 권한 경계가 아니다.
- **읽기 결과는 sanitized 메타데이터만 제공**(2026-07-04 사용자 결정 — 다른 로컬 에이전트가
  `--mcp-stdio`를 직접 spawn해 원장을 읽는다). sanitized 메타데이터만: note(사용자 내용/메모)·
  자산·결제 메타는 싣되 소스 원문 `description`·raw body·token은 DTO 타입에 존재하지 않는다.
  §7 최소권한 대비 트레이드오프: 로컬 프로세스에 cross-project 금융 메타 읽기가 열린다 —
  MCP 서버 자체엔 전송 능력이 없고(stdio) 쓰기/승인 경로는 불변이라는 전제의 의도적 완화.
- 자동 유입 행은 항상 `review_status='needs_review'`로 큐에 들어간다. 2026-07-22 위임 이후에는
  사람이 직접 또는 호스트 승인 뒤 Hermes가 approved/ignored로 정리할 수 있다. low-confidence도
  최초 저장 단계에서는 반드시 리뷰 대기다.

## 2. 저장 스키마 — 필드 의미

거래는 `bookkeeping_transactions` 1행 + 선택적 `bookkeeping_transaction_line_items`. 사용자 export
컬럼과의 매핑:

| export          | 필드                                                                 | 비고                                                         |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 날짜(날짜+시각) | `spent_at`(YYYY-MM-DD) + `spent_at_time`(HH:MM:SS, 선택)             | 날짜/시각 분리 저장                                          |
| 자산            | `account`                                                            | 예: "하나은행"                                               |
| 분류(원본 라벨) | `raw_category`                                                       | 예: "🪑 생활용품" — **원본 보존**                            |
| 분류(해석 코드) | `category_code` / `category`                                         | taxonomy 코드(§4) + 사람용 라벨                              |
| 소분류          | `subcategory` / `subcategory_code`                                   |                                                              |
| 내용            | `description`                                                        |                                                              |
| 수입/지출       | `direction`                                                          | `expense` \| `income` — **금액은 항상 양수**, 부호는 이 필드 |
| 메모            | `note`                                                               |                                                              |
| 금액            | `amount_minor`                                                       | KRW는 원 단위 정수(i32, >0)                                  |
| 화폐            | `currency`                                                           | 3자리(기본 KRW)                                              |
| (강한 dedup 키) | `order_no` / `payment_no`                                            | 영수증에 있으면 전달                                         |
| (판단 근거)     | `confidence`(0..1) / `field_confidence`(필드별) / `review_reasons[]` |                                                              |

**금액 규칙:** 음수 저장 금지. 수입도 `amount_minor>0` + `direction='income'`. 월 합계는 지출/수입/
순액(net)으로 분리 집계되고, 카테고리 차트는 지출만 본다.

Work Radar GUI는 저장된 거래를 사람이 전체 필드 편집할 수 있는 권위 표면이다. 삭제는
`deleted_at` 소프트 삭제로 처리해 원장/요약 기본 목록에서 숨기고 휴지통에서 복원 가능하게 하며,
Gmail 재유입 upsert는 `deleted_at`과 `review_status`를 덮지 않는다. 필드별 수동 잠금은 두지 않고,
Hermes의 `source_ref` 중복 precheck(skip-on-duplicate)에 위임한다.

## 3. 리뷰 기준 (CFO → review_reasons)

Hermes는 다음을 `review_reasons[]`(코드 + 짧은 detail)로 표시한다. Work Radar는 line-item 합계
불일치를 자동으로 추가한다:

- `low_confidence` — 전체 또는 필드 confidence가 임계 이하.
- `possible_duplicate` — 저장 전 dedup precheck(§5)에서 후보가 나옴.
- `line_item_sum_mismatch` — line item 합 ≠ `amount_minor`. **Work Radar가 자동 계산/토글**
  (set line items 시 추가/해소). hard reject 아님(반올림/할인/부분 OCR 정당).
- `ambiguous_merchant` / `ambiguous_category` — 추론 불확실.

detail은 PII/raw 금지 — 짧은 사유만.

## 4. 카테고리 taxonomy + alias

- 시드 taxonomy(코드 정본): 식비(외식/카페/배달/식료품), 교통(대중교통/택시/주유·충전),
  쇼핑(생활용품/의류/전자기기), 구독·SW, 의료·건강, 주거·관리비, 업무비, 수입(급여/용돈/기타),
  미분류(`uncategorized` 코드, 라벨 "미분류" = 미해석 sentinel).
- `wr_bookkeeping_get_category_rules`로 taxonomy + alias 규칙을 받아 **코드를 일관되게** 채운다.
- `category_code`를 직접 줄 수도 있고(권위), 생략하면 Work Radar가 `raw_category`/merchant를
  alias·라벨 매칭으로 해석한다(이모지/공백 무시). 미매칭 → `uncategorized`.
- `category_code`는 **soft ref**(taxonomy에 없는 코드도 거부되지 않음 — 신규/in-flight 허용).
- 사용자가 분류를 보정하면 override 이력이 남고(`bookkeeping_category_overrides`), **이후 재유입(Gmail
  re-sync)이 보정을 덮어쓰지 않는다**(judgment 필드 existing-wins upsert).

## 5. 중복 precheck 계약

저장 전 `wr_bookkeeping_find_duplicate_candidates`를 호출한다:

- 입력: `spent_at`, `amount_minor`, `merchant?`, `order_no?`, `payment_no?`, `source_ref?`,
  `project_id?`, `exclude_transaction_id?`.
- 점수: source_ref 일치=1.0 · 주문/결제번호 일치=0.95 · 금액+같은날(+상호)=0.8/0.95 ·
  금액+±3일=0.6/0.7. 0점 후보는 제외, 상위 10건.
- 후보가 높으면 Hermes는 (a) 저장을 보류하고 사람에게 묻거나, (b) 저장 후
  `wr_bookkeeping_flag_duplicate(id, duplicate_of)`로 링크와 `possible_duplicate` 사유를 표시한 뒤
  검토 상태를 결정한다.
- `source_ref`(Gmail message id 등)가 있으면 동일 키 재유입은 Work Radar가 upsert로 자동 dedup.
  `source_ref`가 없을 때만 fuzzy precheck가 1차 방어선.

## 6. MCP 툴 표면 (시작 시 고정 — `registered_tool_set_is_locked` 테스트로 잠금)

WRITE(로컬, 전 caller — 호스트 승인 UI가 사람 게이트):

- `wr_bookkeeping_save_receipt` — 정규화·판단된 거래 저장(필드는 §2; raw image/body/token 미수용;
  신규 판단 필드는 모두 **optional**이라 구버전 Hermes 호환). line_items 포함 가능(합계 불일치=리뷰 사유).
- `wr_bookkeeping_flag_duplicate` — 중복 후보 링크와 리뷰 사유 추가.
- `wr_bookkeeping_update_transaction` / `wr_bookkeeping_set_review_status` — 거래 필드 수정과
  `needs_review|approved|ignored` 결정.
- `wr_bookkeeping_trash_transaction` / `wr_bookkeeping_restore_transaction` — 복구 가능한 휴지통 이동·복원.
- `wr_bookkeeping_set_line_items` — 항목 replace-all과 합계 불일치 리뷰 사유 재계산.
- `wr_bookkeeping_set_budget` / `wr_bookkeeping_remove_budget` — 월별 카테고리 예산 설정·해제.
- `wr_bookkeeping_create_recurring_expense` / `wr_bookkeeping_set_recurring_expense_status` /
  `wr_bookkeeping_ensure_recurring_occurrences` / `wr_bookkeeping_post_recurring_occurrence` /
  `wr_bookkeeping_set_recurring_occurrence_status` — 반복 지출 규칙 생성과 `active|paused|archived` 전환,
  월 발생분 materialize, 승인 거래 전표 처리, `planned|posted|skipped` 상태 관리. `posted` 발생분은
  연결된 승인 거래의 중복 생성을 막기 위해 이전 상태로 되돌릴 수 없다.

READ(모든 MCP caller 개방 — 2026-07-04, sanitized 메타데이터만):

- `wr_bookkeeping_list_recent_transactions` / `wr_bookkeeping_list_review_queue` — limit clamp 1..100.
- `wr_bookkeeping_monthly_summary` — 지출/수입/순액 + 리뷰 상태 카운트.
- `wr_bookkeeping_get_category_rules` — taxonomy + alias.
- `wr_bookkeeping_find_duplicate_candidates` — §5.
- `wr_bookkeeping_budget_status` / `wr_bookkeeping_list_budgets` / `wr_bookkeeping_list_recurring_expenses` /
  `wr_bookkeeping_list_recurring_occurrences` — 예산·반복 지출 상태 조회.
  `wr_bookkeeping_list_budgets`는 후속 수정·삭제에 필요한 stable budget id를 포함한다.
- `wr_bookkeeping_list_trash` / `wr_bookkeeping_list_line_items` — 복원 대상과 거래 항목 조회.

표면 변경 = 명시적 코드 변경 + tool-set lock 테스트 갱신 + 이 문서 갱신(lockstep).

## 7. 시간당 폴링 오케스트레이션 (Hermes 책임)

권장 루프(시간당):

1. per-source cursor 이후만 fetch(현재 시점 이후) — 무제한 backfill 금지(bounded page).
2. 각 후보를 추출·판단(merchant/category/direction/confidence/line items).
3. `find_duplicate_candidates`로 precheck.
4. `save_receipt`로 candidate 저장(항상 `needs_review`). low-confidence/중복 의심은 review_reason.
5. 사람이 approved 하기 전에는 monthly summary가 needs_review로 구분 표시.

> ⚠️ 시각 타임존: Hermes는 `날짜는 프런트가 주입`(data-layer-conventions) 관례를 따라 **로컬
> 날짜/시각으로 분리해** 보낸다(`spent_at`=YYYY-MM-DD 로컬, `spent_at_time`=HH:MM:SS).
> 순액(net)은 단일 통화(KRW) 가정 — 혼합 통화 월은 net이 무의미하니 통화별로 본다.

> ⚠️ 분류 학습: 수동 분류 보정은 `bookkeeping_category_alias`를 강화해 다음 유입의
> `category_code`/`subcategory_code` 힌트와 신뢰도만 개선한다. 학습된 alias는 결정 레일을
> 대체하지 않으며, 새 거래는 계속 `needs_review`로 들어온다(자동 승인 금지).

## 정본 / 참조

- `docs/areas/mcp-server-conventions.md` — MCP 경계·Hermes 예외·표면 제약.
- `docs/areas/data-layer-conventions.md` — 마이그레이션·SSOT·날짜 주입.
- `src-tauri/src/mcp/mod.rs` — 툴 표면(`registered_tool_set_is_locked`).
- `src-tauri/src/commands/bookkeeping.rs` — 저장·해석·dedup 코어.
- `src-tauri/migrations/0051..0055_bookkeeping_*.sql` — 스키마 정본.
- `docs/plans/2026-06-18-bookkeeping-judgment-pipeline.md` — 구현 계획(Phase A–H).
