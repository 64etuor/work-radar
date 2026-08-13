/**
 * 표시 로케일/포맷 단일 노브 (범용화 P4).
 *
 * UI 문안이 아직 한국어 고정(i18n 미도입)이므로 포맷 로케일도 `ko-KR`로 고정해 기존 출력을
 * 보존한다. 언어 설정/i18n 도입 시 이 상수만 설정값으로 바꾸면 앱 전체의 요일·월일·통화
 * 표기가 함께 전환된다. 새 화면에서 요일/월일 라벨을 배열로 하드코딩하지 말고 이 모듈을 쓴다.
 */
export const APP_LOCALE = "ko-KR";

const weekdayFormat = new Intl.DateTimeFormat(APP_LOCALE, { weekday: "short" });
const monthDayFormat = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "long",
  day: "numeric",
});

/** 2024-01-01(월요일) 기준 파생 — 요일 라벨 배열 하드코딩 중복 제거. */
function weekdayLabel(offsetFromMonday: number): string {
  return weekdayFormat.format(new Date(2024, 0, 1 + offsetFromMonday));
}

/** 월요일 시작 짧은 요일 라벨 7개 (달력 헤더용 — 앱은 월요일 주 시작). */
export const WEEKDAY_SHORT_MON_FIRST: readonly string[] = Array.from({ length: 7 }, (_, i) =>
  weekdayLabel(i),
);

/** `Date#getDay()`(0=일요일) 인덱스용 일요일 시작 라벨. */
export const WEEKDAY_SHORT_SUN_FIRST: readonly string[] = Array.from({ length: 7 }, (_, i) =>
  weekdayLabel((i + 6) % 7),
);

/** bindings `Weekday`(snake_case) 코드 → 짧은 라벨. */
export const WEEKDAY_SHORT_BY_CODE: Record<string, string> = {
  mon: weekdayLabel(0),
  tue: weekdayLabel(1),
  wed: weekdayLabel(2),
  thu: weekdayLabel(3),
  fri: weekdayLabel(4),
  sat: weekdayLabel(5),
  sun: weekdayLabel(6),
};

/** 월-일 라벨 ("7월 10일" ko / "July 10" en — 로케일 파생). */
export function formatMonthDay(month: number, day: number): string {
  // 연도는 표기에 쓰이지 않는다 — 2/29까지 유효하도록 윤년(2000) 고정.
  return monthDayFormat.format(new Date(2000, month - 1, day));
}
