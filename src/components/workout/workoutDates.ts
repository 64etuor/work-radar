/**
 * 'YYYY-MM-DD' 날짜 산술. 로컬 오늘은 호출자가 `localToday()`로 주입하고, 여기서는 순수 문자열
 * 연산만 한다 — 뷰 안에서 `new Date()`를 직접 부르면 React Compiler가 purity 위반으로 잡는다.
 */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((v) => Number.parseInt(v, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ymd;
  // UTC 기준으로 더한다 — 입력이 이미 로컬 날짜 문자열이라 DST 경계에서 하루가 밀리지 않는다.
  const base = Date.UTC(y, m - 1, d);
  const shifted = new Date(base + days * 86_400_000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

/** 표시용 짧은 날짜(2026-07-26 → 7/26). */
export function shortDate(ymd: string): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  return `${Number.parseInt(parts[1], 10)}/${Number.parseInt(parts[2], 10)}`;
}
