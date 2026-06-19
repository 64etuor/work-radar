# 가계부 리뷰/편집/삭제 개편 — Design Spec

- **date:** 2026-06-19
- **area:** Bookkeeping (가계부) — `docs/areas/area-map.md` row 18 → `docs/areas/bookkeeping-cfo-contract.md`
- **scope:** work-radar 단일 레포 (Stream A). Hermes(텔레그램 CFO) 쪽 변경은 **이 spec 범위 밖**.
- **status:** approved-for-implementation (forks 2개 사용자 승인 완료)

## 1. 문제

Hermes(CFO Bot)가 Gmail에서 추출·판단한 거래를 `wr_bookkeeping_save_receipt`로 저장하면
`review_status='needs_review'`로 큐에 쌓인다(계약 §1, 자동 확정 없음). 현재 리뷰 UI는:

1. **편집 불가.** 거래는 읽기전용 카드(`TransactionRow`, `BookkeepingView.tsx:1403–1476`). 메모·카테고리·금액 등을 못 고친다.
2. **진짜 "삭제"가 없음.** 행 액션은 `승인`/`무시`뿐. `무시`=`update_bookkeeping_review_status(id,'ignored')` — 상태만 바꾸고 행은 남는다. hard delete IPC 없음.
3. **최근이력이 삭제 후에도 남음 (버그).** `RecentTransactionsCard`(`BookkeepingView.tsx:841–874`)는 `useBookkeepingTransactions(null, …)`(전 상태)를 **필터 없이** `slice(0,8)` 렌더 → `ignored`(=삭제로 체감) 거래가 계속 보인다. `ReviewQueueCard`는 `needs_review`만 필터하므로 위에선 사라지지만 아래엔 남는다.

근본 원인은 **"삭제 개념 부재 + 최근뷰 무필터"**. 소프트 모델(needs_review→approved/ignored)은 감사·dedup을 위해 의도된 것이지만(계약 §1/§5), 사용자에게 노출되는 삭제/편집 경로가 없다.

## 2. 결정 (사용자 승인)

- **삭제 = 소프트 삭제 + 휴지통(복원 가능).** 행을 보존해 dedup(`source_ref` idempotency)을 깨지 않음 → Gmail 재동기화로 안 되살아남. (hard delete 아님.)
- **편집 = 전체 필드.** 카드 → 인라인 편집 폼. OCR/Gmail 오인식 교정 위해 금액·날짜·가맹점까지 수정 가능.
- **정합성 보강(경량).** Hermes는 저장 전 `find_duplicate_candidates`로 source_ref 일치(score 1.0)를 잡으면 **재저장을 skip**한다(검증 완료). 따라서 무거운 필드별 편집 잠금은 넣지 않고, **재유입 upsert가 사용자 권위 상태(`deleted_at`·`review_status`)를 덮지 않도록** 하는 값싼 불변만 추가한다. 필드 편집 보호는 Hermes skip-on-duplicate에 위임(수용된 트레이드오프).

## 3. 데이터 모델 — migration `0057_bookkeeping_soft_delete.sql`

```sql
ALTER TABLE bookkeeping_transactions ADD COLUMN deleted_at TEXT NULL;
CREATE INDEX bookkeeping_transactions_deleted_at_idx
  ON bookkeeping_transactions(deleted_at);
```

- 새 컬럼 1개(nullable). 상태 enum(`needs_review|approved|ignored`)·MCP 툴 표면 **불변** → `registered_tool_set_is_locked` 안전.
- 마이그레이션은 immutable(sqlx checksum) — 추가만.

## 4. 백엔드 — `src-tauri/src/commands/bookkeeping.rs` + `models/bookkeeping.rs`

### 4.1 신규 IPC 3개 (tauri-specta, `bindings.ts` 재생성=`cargo test`)

1. **`update_bookkeeping_transaction(input) -> BookkeepingTransaction`**
   - `UpdateBookkeepingTransactionInput { id, merchant?, description?, amount_minor?, currency?, spent_at?, spent_at_time?, direction?, note?, account?, category_code?, subcategory_code?, payment_method_kind?, payment_method_label?, payment_method_last4?, expense_kind?, order_no?, payment_no? }` (모두 optional patch; `#[serde(deny_unknown_fields)]`; **PK id는 String**, specta i64 금지).
   - 검증: `amount_minor > 0`(i32), `direction ∈ {expense,income}`, `currency` 3자, `spent_at`=YYYY-MM-DD, `spent_at_time`=HH:MM:SS|null. 위반 → `AppError`.
   - 카테고리(`category_code`/`subcategory_code`) 변경은 **기존 `override_bookkeeping_category` 경로 재사용**(override 이력 + `category`/`subcategory` 라벨 재해석). 다른 필드는 직접 UPDATE.
   - `amount_minor` 변경 시 line-item 합 불일치(`line_item_sum_mismatch`) 사유 **재계산/토글**(계약 §3, 기존 로직 재사용).
   - `updated_at` 갱신. 감사로그 append(`list_bookkeeping_audit`가 읽는 테이블).

2. **`delete_bookkeeping_transaction(id) -> BookkeepingTransaction`** — `deleted_at = datetime('now')`(소프트). 감사로그.
3. **`restore_bookkeeping_transaction(id) -> BookkeepingTransaction`** — `deleted_at = NULL`. 감사로그.

### 4.2 조회 필터

- **`list_bookkeeping_transactions(status, project_id)`** — `WHERE deleted_at IS NULL` **추가**(삭제 행은 절대 메인 리스트에 안 나옴). 시그니처 불변.
- **신규 `list_bookkeeping_trash(project_id) -> BookkeepingTransaction[]`** — `WHERE deleted_at IS NOT NULL OR review_status='ignored'` ORDER BY `COALESCE(deleted_at, reviewed_at, updated_at)` DESC. (user-deleted + Hermes 중복/무시 = 한 휴지통.)

### 4.3 재유입 upsert 보강 (값싼 불변) — `upsert_bookkeeping_transaction_from_ingest_inner` (≈`:380–497`)

`ON CONFLICT(source, source_ref) DO UPDATE SET …`(`:420`)에 대해:

- **`deleted_at`을 SET 절에 넣지 않는다** → 삭제된 행이 재유입돼도 deleted 유지(안 되살아남).
- **`review_status`를 리셋하지 않는다** → 이미 `approved`/`ignored`한 행이 재유입돼도 안 튕겨나감. (현재 SET 절에 `review_status`가 있으면 제거하거나 `COALESCE(기존, …)`로 가드. 없으면 현상 유지 확인만.)
- 판단 메타데이터(`confidence`/`field_confidence_json`/`review_reasons_json`/`category_code` 제안)는 기존대로 갱신 OK.
- **비범위:** `note`/`amount_minor`/`merchant`/`spent_at` 등 필드 편집 잠금은 **추가하지 않음**(Hermes skip-on-duplicate에 위임). 코드 주석으로 트레이드오프 명시.

## 5. 프런트 — `src/components/bookkeeping/BookkeepingView.tsx` + `src/lib/query/bookkeeping.ts`

### 5.1 3-버킷 구조 (최근이력 버그 정본 수정)

| 섹션 | 데이터 | 액션 |
| --- | --- | --- |
| **검토 (Hermes 인박스)** | `useBookkeepingTransactions("needs_review", projectId)` | **인라인 편집 폼** + `확정`(approve)/`삭제`(soft) |
| **확정 거래 (원장/최근)** | `useBookkeepingTransactions("approved", projectId)` | 가독 리스트, 클릭→펼침 편집, `삭제` |
| **휴지통 (접힘·기본 닫힘)** | `useBookkeepingTrash(projectId)` | 사유 라벨(삭제됨/중복·무시) + `복원` |

- **버그 fix:** 확정 거래(구 "최근 거래")는 더 이상 무필터 전체가 아니라 `approved` & not-deleted. `ignored`/deleted는 **휴지통으로만** 간다.
- `무시` 단독 액션은 은퇴(수동 액션 = `확정`/`삭제`). `ignored` 상태값 자체는 Hermes dedup용으로 유지.
- `복원`: deleted → `restore_bookkeeping_transaction`; ignored → `update_bookkeeping_review_status(needs_review)`.

### 5.2 편집 폼 (카드 → 폼)

- **검토** = 바로 수정 가능한 인라인 폼. **확정 원장** = 가독 리스트, 행 클릭/펼침 시 같은 폼. (입력칸 도배 방지.)
- 편집 필드: 가맹점·금액(+통화)·날짜·시각·수입/지출(토글)·카테고리(taxonomy 피커 `bookkeeping_list_taxonomy` 재사용)·소분류·메모·내용(설명)·자산·결제수단(kind/label/last4)·비용유형·주문번호/결제번호. 저장 → `update_bookkeeping_transaction`.
- 읽기전용 표시: source/sourceRef·confidence·review_reasons·duplicate 배지·createdAt 등.
- shadcn(Input/Select/Toggle/Button) + DESIGN.md(Cohere white editorial) + `typo-*`/디자인 토큰 준수(design-tokens 게이트=TSX). 인라인 하드코드 색/폰트 금지.

### 5.3 쿼리 훅 (`src/lib/query/bookkeeping.ts`)

- 신규: `useUpdateBookkeepingTransaction`, `useDeleteBookkeepingTransaction`, `useRestoreBookkeepingTransaction`, `useBookkeepingTrash(projectId)`.
- 무효화: 변경 시 `["bookkeeping"]` prefix 무효화 유지(현 `useInvalidateBookkeeping`). 필요 시 summary/trash 키 포함. (스코프 최적화는 nice-to-have, 필수 아님.)

## 6. 검증 (done-criteria = 실행 증거)

명령 정본 = `docs/reference/commands.md`.

- Rust: `cargo test`(+ `bindings.ts` drift 0) · `cargo clippy --all-targets -- -D warnings` · `cargo fmt --check`.
- 프런트: `pnpm typecheck` · `pnpm lint` · `pnpm vitest run` · design-tokens 게이트.
- **행동 변경 테스트(필수):**
  1. soft-delete 후 `list_bookkeeping_transactions`에 안 나옴 / `list_bookkeeping_trash`에 나옴 / `restore` 후 복귀.
  2. `update_bookkeeping_transaction` 필드 영속 + 검증(amount>0, direction).
  3. 재유입 upsert가 `deleted_at`·`review_status` 보존(삭제·확정 행을 같은 source_ref로 재-ingest → 상태 불변).
  4. 뷰 필터: needs_review/approved/trash 분리 + `ignored`가 원장에서 빠짐.
- Tauri 통합: `pnpm tauri dev` 부팅 + 라이브 스모크(편집/확정/삭제/복원)는 **사용자/cmux**(네이티브 WKWebView).

## 7. 문서/계약

- `docs/areas/bookkeeping-cfo-contract.md`에 한 단락 추가: 소프트 삭제(`deleted_at`)·GUI 전체 필드 편집·재유입이 사용자 권위 상태 보존. **MCP 툴 표면 변경 아님**(lockstep 갱신 불필요).
- `docs/decisions.md`에 한 줄(소프트삭제+휴지통+편집 트레이드오프).

## 8. 범위 밖 (deferred)

- **Hermes/Stream B:** `legacy_possible_duplicate` 태깅, 영속 cursor 와이어링(MCP cursor get/set 툴), 폴링 주기 hourly↔daily 정합, `mark_duplicate` 호출 확인 — 전부 **Hermes cron 프롬프트** 소관, 사용자가 직접 처리.
- 무거운 필드별 편집 잠금(`manually_edited_at` CASE-WHEN upsert 가드) — 필요 시 후속.
- line-item 개별 편집 UI(금액 합 재계산만 처리, 항목 CRUD는 후속).
- 텔레그램 인터랙티브 리뷰 루프(현재 단방향 리포트, 리뷰는 WR GUI).

## 9. 위험·롤백

- 마이그레이션 = nullable 컬럼 추가(안전·전방향). 롤백은 컬럼 무시로 충분.
- UI 변경은 `BookkeepingView.tsx`/`bookkeeping.ts`에 국소. MCP 툴 표면 불변 → Hermes 계약 무영향.
- INVARIANTS(`docs/areas/decision-rails.md`) 7종 위반 여부는 **별도 critic 패스**로 확인(self-approve 금지).
