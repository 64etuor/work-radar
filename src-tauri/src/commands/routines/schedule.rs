//! 루틴 스케줄 순수 계산 (due-calc) — 네트워크/DB 무관, 단위 테스트 가능.
//! `today/weekly.rs` 등 외부 집계가 `parse_weekdays`/`routine_due_on`을 공유한다.

use chrono::{Datelike, NaiveDate};

use crate::models::{RoutineFreq, RoutineMonthlyPattern, Weekday};

/// weekdays JSON 컬럼('["wed","fri"]') → Vec<Weekday>. 누락/형식오류는 빈 목록.
pub fn parse_weekdays(raw: Option<&str>) -> Vec<Weekday> {
    raw.and_then(|s| serde_json::from_str::<Vec<Weekday>>(s).ok())
        .unwrap_or_default()
}

/// chrono Weekday → 루틴 weekdays JSON에 쓰는 소문자 3글자 키.
fn weekday_key(d: chrono::Weekday) -> &'static str {
    use chrono::Weekday::*;
    match d {
        Mon => "mon",
        Tue => "tue",
        Wed => "wed",
        Thu => "thu",
        Fri => "fri",
        Sat => "sat",
        Sun => "sun",
    }
}

/// 한 날짜의 day-of-month가 monthly anchor day에 해당하는가 (월말 클램프).
/// anchor day 31은 30일 달에선 30일에, 2월엔 28/29일에 due가 된다(그달 말일로 클램프).
fn monthly_due(anchor: NaiveDate, date: NaiveDate) -> bool {
    let last_dom = last_day_of_month(date.year(), date.month());
    let target = anchor.day().min(last_dom);
    date.day() == target
}

/// nth_weekday monthly due-calc: 그달에서 지정 요일의 N번째(1..=5, -1=마지막) 출현이면 due.
/// 패턴 계약(요일 정확히 1개 + nth_week 존재)은 IPC 검증(`crud::validate_monthly_input`)이 보증 —
/// 여기선 불충족 시 보수적으로 false(스케줄 불명 → 표시 안 함). anchor에 의존하지 않는다.
fn nth_weekday_due(weekdays: &[Weekday], nth_week: Option<i32>, date: NaiveDate) -> bool {
    let [wd] = weekdays else {
        return false;
    };
    let Some(nth) = nth_week else {
        return false;
    };
    if weekday_enum_key(*wd) != weekday_key(date.weekday()) {
        return false;
    }
    if nth == -1 {
        // 마지막 출현: 같은 요일이 7일 뒤면 다음 달로 넘어가는 경우.
        date.day() + 7 > last_day_of_month(date.year(), date.month())
    } else {
        // 그달에서 이 요일의 몇 번째 출현인지(1-7일=1번째, 8-14일=2번째 …).
        let ordinal = (date.day() - 1) / 7 + 1;
        ordinal as i32 == nth
    }
}

/// 주어진 연/월의 말일(28..=31).
fn last_day_of_month(year: i32, month: u32) -> u32 {
    // 다음 달 1일에서 하루 빼면 이번 달 말일.
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid first-of-month");
    (first_next - chrono::Duration::days(1)).day()
}

/// **순수 due-calc** — 주어진 날짜에 루틴이 해당(due)하는지. Daily/Weekly/Biweekly/Monthly.
/// weekdays는 weekly/biweekly + monthly nth_weekday에서 의미, anchor는 biweekly(주 parity)·
/// monthly day_of_month 기준. monthly nth_weekday는 `monthly_pattern`/`monthly_nth_week`로 결정
/// (anchor 무관). anchor가 없거나 날짜 파싱 실패면 보수적으로 false(스케줄 불명 → 표시 안 함).
pub fn routine_due_on(
    freq: RoutineFreq,
    weekdays: &[Weekday],
    anchor: Option<&str>,
    monthly_pattern: Option<RoutineMonthlyPattern>,
    monthly_nth_week: Option<i32>,
    date: NaiveDate,
) -> bool {
    let wk = weekday_key(date.weekday());
    match freq {
        RoutineFreq::Daily => true,
        RoutineFreq::Weekly => weekdays.iter().any(|w| weekday_enum_key(*w) == wk),
        RoutineFreq::Biweekly => {
            // 선택 요일이면서 anchor 기준 주 parity가 맞을 때만(14일 주기).
            if !weekdays.iter().any(|w| weekday_enum_key(*w) == wk) {
                return false;
            }
            let Some(anchor) = anchor.and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            else {
                return false;
            };
            // 주 경계 parity: 각 날짜를 일요일 기준 주 인덱스로 환산해 14일(2주) parity 비교.
            // (days_since_anchor_week / 7) % 2 == 0 과 등가지만, 음수/요일 어긋남에 안정적이도록
            // 두 날짜의 "월요일 기준 주 시작"의 일수 차이로 계산한다.
            // ⚠️ parity epoch는 RRULE DTSTART와 같아야 한다: rrule.rs(routine_to_rrule)는
            // anchor가 선택 요일이 아니면 첫 매칭 요일로 forward-normalize한 날짜를 DTSTART로
            // 쓰고, Google의 INTERVAL=2 parity는 DTSTART 주 기준이다. raw anchor 주를 쓰면
            // 정규화가 주 경계를 넘은 경우 Google 미러와 정반대 주에 due가 뜬다.
            let anchor_week = week_start(biweekly_epoch(anchor, weekdays));
            let date_week = week_start(date);
            let weeks = (date_week - anchor_week).num_days() / 7;
            weeks % 2 == 0
        }
        RoutineFreq::Monthly => match monthly_pattern {
            Some(RoutineMonthlyPattern::NthWeekday) => {
                nth_weekday_due(weekdays, monthly_nth_week, date)
            }
            // day_of_month(명시) 또는 미지정(레거시 기본) → anchor day-of-month 기준.
            Some(RoutineMonthlyPattern::DayOfMonth) | None => {
                let Some(anchor) =
                    anchor.and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                else {
                    return false;
                };
                monthly_due(anchor, date)
            }
        },
    }
}

/// 루틴 **활성 구간** 게이트 (순수). `[start, end]` 둘 다 inclusive ('YYYY-MM-DD').
/// - `start` 있고 `date < start` → false (시작 전).
/// - `end` 있고 `date > end` → false (종료 후).
/// - 경계 None/빈 문자열 = 그 방향 무제한(start=None 하한 없음, end=None 무기한).
/// - 형식이 깨진 날짜는 보수적으로 통과(true) — 진입점(`crud::validate_active_period`)이 형식을
///   보장하므로 방어용(있는데 못 읽었다고 루틴을 숨기지 않는다).
///
/// `routine_due_on`(패턴 술어)과 **AND-결합**해 "그 날 due"를 만든다(due ⟺ 패턴 ∧ 구간).
/// 분리 이유: 패턴 매칭과 활성 구간은 직교한 관심사 — 각각 독립 테스트, routine_due_on 시그니처 불변.
pub fn within_active_window(start: Option<&str>, end: Option<&str>, date: NaiveDate) -> bool {
    if let Some(s) = start.filter(|s| !s.trim().is_empty()) {
        if let Ok(start_d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            if date < start_d {
                return false;
            }
        }
    }
    if let Some(e) = end.filter(|s| !s.trim().is_empty()) {
        if let Ok(end_d) = NaiveDate::parse_from_str(e, "%Y-%m-%d") {
            if date > end_d {
                return false;
            }
        }
    }
    true
}

/// biweekly parity epoch — anchor가 선택 요일이면 그대로, 아니면 첫 매칭 요일로 forward
/// (최대 6일). rrule.rs `next_matching_weekday`와 동치 — 로컬 due-calc와 Google RRULE
/// DTSTART가 같은 주를 2주 주기의 기준으로 삼게 한다.
fn biweekly_epoch(anchor: NaiveDate, weekdays: &[Weekday]) -> NaiveDate {
    for offset in 0..7 {
        let d = anchor + chrono::Duration::days(offset);
        let wk = weekday_key(d.weekday());
        if weekdays.iter().any(|w| weekday_enum_key(*w) == wk) {
            return d;
        }
    }
    anchor
}

/// 그 날이 속한 주의 월요일(주 시작) 날짜. parity 계산 기준을 요일과 무관하게 만든다.
fn week_start(d: NaiveDate) -> NaiveDate {
    let days_from_mon = d.weekday().num_days_from_monday() as i64;
    d - chrono::Duration::days(days_from_mon)
}

/// Weekday enum → 소문자 키 (weekdays JSON 매칭용).
fn weekday_enum_key(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "mon",
        Weekday::Tue => "tue",
        Weekday::Wed => "wed",
        Weekday::Thu => "thu",
        Weekday::Fri => "fri",
        Weekday::Sat => "sat",
        Weekday::Sun => "sun",
    }
}

#[cfg(test)]
mod window_tests {
    use super::within_active_window;
    use chrono::NaiveDate;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn no_bounds_always_true() {
        assert!(within_active_window(None, None, d("2026-06-25")));
    }

    #[test]
    fn before_start_false() {
        assert!(!within_active_window(
            Some("2026-06-25"),
            None,
            d("2026-06-24")
        ));
    }

    #[test]
    fn on_start_true_inclusive() {
        assert!(within_active_window(
            Some("2026-06-25"),
            None,
            d("2026-06-25")
        ));
    }

    #[test]
    fn after_end_false() {
        assert!(!within_active_window(
            None,
            Some("2026-06-25"),
            d("2026-06-26")
        ));
    }

    #[test]
    fn on_end_true_inclusive() {
        assert!(within_active_window(
            None,
            Some("2026-06-25"),
            d("2026-06-25")
        ));
    }

    #[test]
    fn within_closed_range_true() {
        assert!(within_active_window(
            Some("2026-06-01"),
            Some("2026-06-30"),
            d("2026-06-15")
        ));
    }

    #[test]
    fn outside_closed_range_false() {
        assert!(!within_active_window(
            Some("2026-06-01"),
            Some("2026-06-30"),
            d("2026-07-01")
        ));
        assert!(!within_active_window(
            Some("2026-06-01"),
            Some("2026-06-30"),
            d("2026-05-31")
        ));
    }

    #[test]
    fn blank_strings_treated_as_unbounded() {
        assert!(within_active_window(Some(""), Some("   "), d("2026-06-25")));
    }

    #[test]
    fn malformed_dates_pass_through() {
        // 진입점 검증이 형식을 보장 — 못 읽으면 보수적으로 통과(숨기지 않음).
        assert!(within_active_window(
            Some("nope"),
            Some("bad"),
            d("2026-06-25")
        ));
    }
}
