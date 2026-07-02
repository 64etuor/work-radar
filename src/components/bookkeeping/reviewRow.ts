/// 검토 큐 read-row 표시용 순수 헬퍼 — 사유 칩 절단(+N)·분류 경로 라벨·
/// 의심 행 판별·메모 커밋 판단. 컴포넌트에서 로직을 분리해 vitest로 직접 검증한다.
import type { BookkeepingTransaction } from "@/bindings";

import { reviewReasonCodes } from "./bookkeepingLabels";

/** read-row에서 한 줄에 보여줄 최대 사유 칩 수. 초과분은 "+N" 칩으로 접는다. */
export const REVIEW_REASON_CHIP_LIMIT = 3;

export interface ReviewChipTruncation {
  visible: string[];
  hiddenCount: number;
}

/**
 * 사유 코드 목록을 표시용으로 절단한다. 중복 코드는 한 번만 세고,
 * limit 초과분은 hiddenCount("+N" 칩)로 돌려준다.
 */
export function truncateReviewChips(
  codes: readonly string[],
  limit: number = REVIEW_REASON_CHIP_LIMIT,
): ReviewChipTruncation {
  const unique = [...new Set(codes)];
  if (unique.length <= limit) return { visible: unique, hiddenCount: 0 };
  return { visible: unique.slice(0, limit), hiddenCount: unique.length - limit };
}

/** 분류 표시 라벨: "카테고리 › 소분류" (소분류 없으면 카테고리만). */
export function categoryPathLabel(category: string, subcategory: string | null): string {
  return subcategory ? `${category} › ${subcategory}` : category;
}

/**
 * 사람의 주의가 필요한 review reason 코드 — 코드베이스가 실제로 emit하는 코드에서 유도.
 * (gmail.rs/bookkeeping.rs: low_confidence·possible_duplicate·cancellation_notice,
 *  mmbak.rs: source_deleted·source_direction_changed,
 *  line_items.rs: line_item_sum_mismatch, mcp/mod.rs: low_merchant_confidence.)
 * `date_from_received_at`(날짜를 수신시각에서 추론한 정보성 메타데이터)는 제외.
 */
export const ATTENTION_REASON_CODES: ReadonlySet<string> = new Set([
  "possible_duplicate",
  "low_confidence",
  "low_merchant_confidence",
  "cancellation_notice",
  "source_deleted",
  "source_direction_changed",
  "line_item_sum_mismatch",
]);

/**
 * 의심 행 판별 — attention 사유 코드가 하나라도 있거나 이미 중복으로 연결된 행.
 * 의심 그룹은 개별 확정 버튼을 유지하고, 나머지(정상)는 그룹 헤더의 일괄 확정으로 처리한다.
 */
export function isSuspicious(
  tx: Pick<BookkeepingTransaction, "reviewReasonsJson" | "duplicateOfTransactionId">,
): boolean {
  if (tx.duplicateOfTransactionId) return true;
  return reviewReasonCodes(tx.reviewReasonsJson).some((code) => ATTENTION_REASON_CODES.has(code));
}

/**
 * 인라인 메모 커밋 판단 — 정규화(trim, 빈 문자열=null 동치) 후 실제로 달라졌을 때만 저장.
 * no-op 저장(같은 값 재입력, 공백만 추가)이 뮤테이션/토스트를 만들지 않게 한다.
 */
export function shouldCommitNoteDraft(currentNote: string | null, draft: string): boolean {
  return draft.trim() !== (currentNote ?? "").trim();
}
