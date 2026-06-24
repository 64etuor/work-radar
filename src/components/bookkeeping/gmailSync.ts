/**  기본 Gmail 검색어: 비워두면 서버가 per-project durable 커서로 증분 동기화한다(권장 경로). */
export const GMAIL_DEFAULT_QUERY = "";

/**  커서를 한 번 무시하고 다시 훑는 전체 재스캔 윈도우(명시적 cursor override, 복구용). */
export const GMAIL_FULL_RESCAN_QUERY = "newer_than:90d";

/**
 *  빈/공백 검색어는 null로 — 서버가 durable 커서(`after:<cursor>`)를 쓰게 한다.
 *  비어있지 않으면 트림된 명시적 검색어를 그대로 보내 커서를 일회성으로 override 한다.
 */
export function normalizeGmailQuery(query: string): string | null {
  const trimmed = query.trim();
  return trimmed === "" ? null : trimmed;
}
