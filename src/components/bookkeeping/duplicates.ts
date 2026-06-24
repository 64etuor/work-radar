import type { BookkeepingTransaction, FindBookkeepingDuplicateCandidatesInput } from "@/bindings";

/**  리뷰 행에서 "이 거래"를 기준으로 중복 후보를 찾기 위한 질의를 만든다(자기 자신은 제외). */
export function duplicateQueryFromTransaction(
  tx: BookkeepingTransaction,
): FindBookkeepingDuplicateCandidatesInput {
  return {
    projectId: tx.projectId,
    spentAt: tx.spentAt,
    amountMinor: tx.amountMinor,
    merchant: tx.merchant,
    orderNo: tx.orderNo,
    paymentNo: tx.paymentNo,
    source: tx.source,
    sourceRef: tx.sourceRef,
    excludeTransactionId: tx.id,
  };
}

/**  0..1 점수를 읽기 쉬운 백분율로. 점수가 없으면 em dash. */
export function formatDuplicateScore(score: number | null): string {
  if (score == null) return "—";
  return `${Math.round(score * 100)}%`;
}
