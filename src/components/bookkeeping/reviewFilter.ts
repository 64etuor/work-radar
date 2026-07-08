export type BookkeepingReviewFilter = {
  query: string;
  fromDate: string;
  toDate: string;
};

export type BookkeepingReviewFilterRow = {
  merchant: string;
  category: string;
  subcategory?: string | null;
  categoryCode?: string | null;
  subcategoryCode?: string | null;
  amountMinor: number;
  currency: string;
  spentAt: string;
  spentAtTime?: string | null;
  description?: string | null;
  note?: string | null;
  rawCategory?: string | null;
  reviewReasonsJson: string;
};

export function matchesBookkeepingReviewFilter(
  row: BookkeepingReviewFilterRow,
  filter: BookkeepingReviewFilter,
): boolean {
  if (filter.fromDate && row.spentAt < filter.fromDate) return false;
  if (filter.toDate && row.spentAt > filter.toDate) return false;

  const query = filter.query.trim().toLowerCase();
  if (!query) return true;

  return reviewFilterHaystack(row).includes(query);
}

function reviewFilterHaystack(row: BookkeepingReviewFilterRow): string {
  const reasons = parseReviewReasonText(row.reviewReasonsJson);
  return [
    row.merchant,
    row.category,
    row.subcategory,
    row.categoryCode,
    row.subcategoryCode,
    String(row.amountMinor),
    row.currency,
    row.spentAt,
    row.spentAtTime,
    row.description,
    row.note,
    row.rawCategory,
    reasons,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

function parseReviewReasonText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return value;
    return parsed
      .flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const reason = item as { code?: unknown; detail?: unknown };
        return [reason.code, reason.detail].filter(
          (part): part is string => typeof part === "string",
        );
      })
      .join(" ");
  } catch {
    return value;
  }
}
