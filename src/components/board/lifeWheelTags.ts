/** 신호의 area 태그 키 배열 해석. areaTags(JSON 배열) 우선, 없으면 primary area 단일. 공용. */
export function parseAreaTagKeys(raw: string | null, primary: string | null): string[] {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Fall back to primary tag below.
    }
  }
  return primary ? [primary] : [];
}
