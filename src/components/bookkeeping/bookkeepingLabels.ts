import type {
  BookkeepingExpenseKind,
  BookkeepingPaymentMethodKind,
  BookkeepingReviewStatus,
} from "@/bindings";

import { EXPENSE_KIND_OPTIONS, PAYMENT_METHOD_OPTIONS } from "./bookkeepingConstants";

export function statusLabel(status: BookkeepingReviewStatus) {
  if (status === "approved") return "승인";
  if (status === "ignored") return "무시";
  return "리뷰";
}

export function sourceLabel(source: string) {
  if (source === "gmail") return "Gmail";
  if (source === "ocr") return "OCR";
  if (source === "csv") return "CSV";
  return "수동";
}

export function syncStatusLabel(status: string) {
  return status === "succeeded" ? "완료" : "실패";
}

export function directionLabel(direction: string) {
  return direction === "income" ? "수입" : "지출";
}

/// review_reasons_json(raw JSON 배열)에서 코드만 안전하게 추출. 파싱 실패 시 빈 배열.
export function reviewReasonCodes(reviewReasonsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(reviewReasonsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) =>
        r && typeof r === "object" && "code" in r ? String((r as { code: unknown }).code) : null,
      )
      .filter((c): c is string => Boolean(c));
  } catch {
    return [];
  }
}

export function expenseKindLabel(kind: BookkeepingExpenseKind) {
  return EXPENSE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

export function paymentMethodLabel(kind: BookkeepingPaymentMethodKind) {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}
