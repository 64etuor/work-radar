/**
 * 연속 타임라인 절대 분(minute) 축 — 순수 날짜/시간 헬퍼.
 *
 * 본 코드베이스의 scheduledAt/이벤트 start는 전부 로컬-오프셋 ISO("YYYY-MM-DDTHH:MM:SS[+09:00]")로
 * 기록된다 — 날짜/시:분은 문자열 slice로 읽는다(`new Date(iso)` 재파싱은 UTC 변환 자정 off-by-one
 * 위험, todayBlocks.localDateOf와 동일 근거). 날짜 산술만 Date.UTC(타임존 무관 정수 산술)로 한다.
 */

/** 로컬-ISO에서 로컬 날짜(YYYY-MM-DD)만 추출. */
export function localDateOf(iso: string): string {
  return iso.slice(0, 10);
}

function utcMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** date − anchorDate (일 단위 정수). */
export function dayDiff(date: string, anchorDate: string): number {
  return Math.round((utcMidnight(date) - utcMidnight(anchorDate)) / 86_400_000);
}

/** date + n일 (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  const d = new Date(utcMidnight(date) + n * 86_400_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** 로컬 ISO → 앵커 날짜 00:00 기준 절대 분. 앵커 이전 시작은 음수(렌더는 overflow 클리핑). */
export function absMin(iso: string, anchorDate: string): number {
  const h = Number(iso.slice(11, 13));
  const m = Number(iso.slice(14, 16));
  return dayDiff(localDateOf(iso), anchorDate) * 1440 + h * 60 + m;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 해당 날짜의 로컬 UTC 오프셋("+09:00"). 정오 기준 파싱 — DST 경계 off-by-one 회피
 * (기존 weekdayForDate와 동일 근거). KST는 상수지만 DST 지역 정합성 확보.
 */
export function tzOffsetForDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const min = -new Date(y, m - 1, d, 12).getTimezoneOffset();
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 앵커 + 절대 분 → RFC3339 로컬 ISO(해당 날짜의 오프셋). 백엔드 parse_from_rfc3339 호환. */
export function isoFromAbsMin(anchorDate: string, min: number): string {
  const dayIdx = Math.floor(min / 1440);
  const within = min - dayIdx * 1440;
  const date = addDays(anchorDate, dayIdx);
  const h = Math.floor(within / 60);
  const m = within % 60;
  return `${date}T${pad(h)}:${pad(m)}:00${tzOffsetForDate(date)}`;
}
