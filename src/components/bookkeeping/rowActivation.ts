import type { BookkeepingTransaction, OverrideBookkeepingCategoryInput } from "@/bindings";

import { effectiveCategoryCode } from "./bookkeepingDrafts";

/** 인라인 quick-edit 경로임을 audit 로그에서 구분하기 위한 사유 코드. */
export const INLINE_CATEGORY_OVERRIDE_REASON = "inline_quick_edit";

const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="combobox"], [role="listbox"], [role="option"], [role="menuitem"], label';

/**
 * 행 클릭이 안쪽 인터랙티브 요소(버튼/셀렉트 등)에서 시작했는지 판별.
 * true면 행 활성화(편집 열기)를 건너뛴다 — 인라인 분류 셀렉트/삭제 버튼 클릭이
 * 편집 폼까지 열어버리는 이중 동작을 막는다.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * 인라인 분류 변경 → override 커맨드 입력을 만든다.
 * 비교는 편집 폼과 동일한 유효 분류(`effectiveCategoryCode` — 레거시 행은
 * `category` fallback)로 한다. 값이 그대로면 null(no-op) — 레거시 행에서 보이는
 * 값을 그대로 다시 고르는 클릭이 오해를 부르는 override/audit 행을 만들지 않게.
 * 상위 분류가 바뀌면 소분류는 더 이상 유효하지 않으므로 함께 초기화한다.
 */
export function buildInlineCategoryOverride(
  tx: Pick<BookkeepingTransaction, "id" | "categoryCode" | "category">,
  nextCategoryCode: string,
): OverrideBookkeepingCategoryInput | null {
  if (!nextCategoryCode || nextCategoryCode === effectiveCategoryCode(tx)) return null;
  return {
    transactionId: tx.id,
    categoryCode: nextCategoryCode,
    subcategoryCode: null,
    reason: INLINE_CATEGORY_OVERRIDE_REASON,
  };
}
