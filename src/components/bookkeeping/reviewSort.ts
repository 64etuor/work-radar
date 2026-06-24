export type ReviewQueueOrder = "default" | "confidence_asc";

export function reviewOrderToQueryParam(order: ReviewQueueOrder): string | null {
  return order === "confidence_asc" ? "confidence_asc" : null;
}
