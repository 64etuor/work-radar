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
            let anchor_week = week_start(anchor);
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
