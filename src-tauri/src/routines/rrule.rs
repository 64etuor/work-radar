//! 루틴 → Google Calendar RRULE 매핑 (순수 함수).
//!
//! Plan §3 매핑표·테스트 매트릭스 정본.
//! 이 함수는 시간·DB·네트워크에 의존하지 않는다 — 입력→출력만.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Weekday as ChronoWeekday};
use thiserror::Error;

/// 풍부 monthly 패턴. plan §2 schema에 대응 (TEXT enum).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthlyPattern {
    DayOfMonth,
    NthWeekday,
}

/// 루틴 반복 주기 — 외부 도메인 enum(`models::routines::RoutineFreq`)과 1:1.
/// rrule.rs를 모델에 의존시키지 않기 위해 로컬 enum으로 재선언.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Biweekly,
    Monthly,
}

/// 요일 — `models::routines::Weekday`와 동일 의미. 로컬 재선언.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    fn rrule_code(self) -> &'static str {
        match self {
            Self::Mon => "MO",
            Self::Tue => "TU",
            Self::Wed => "WE",
            Self::Thu => "TH",
            Self::Fri => "FR",
            Self::Sat => "SA",
            Self::Sun => "SU",
        }
    }

    fn from_chrono(w: ChronoWeekday) -> Self {
        match w {
            ChronoWeekday::Mon => Self::Mon,
            ChronoWeekday::Tue => Self::Tue,
            ChronoWeekday::Wed => Self::Wed,
            ChronoWeekday::Thu => Self::Thu,
            ChronoWeekday::Fri => Self::Fri,
            ChronoWeekday::Sat => Self::Sat,
            ChronoWeekday::Sun => Self::Sun,
        }
    }
}

/// `routine_to_rrule` 입력.
///
/// `reference_date`는 daily/weekly DTSTART 산출 기준 (보통 routine.created_at의 날짜 부분).
/// biweekly/monthly에선 무시되고 `anchor_date`가 사용됨.
#[derive(Debug, Clone)]
pub struct RRuleInput<'a> {
    pub freq: Freq,
    pub weekdays: &'a [Weekday],
    /// 'YYYY-MM-DD'. biweekly/monthly 필수, daily/weekly에선 옵션.
    pub anchor_date: Option<&'a str>,
    /// 'HH:MM' 로컬. None → 09:00 fallback (`DEFAULT_TIME`).
    pub time_of_day: Option<&'a str>,
    /// 분. None → 30 fallback (`DEFAULT_DURATION_MIN`).
    pub duration_min: Option<u32>,
    pub monthly_pattern: Option<MonthlyPattern>,
    pub monthly_nth_week: Option<i32>,
    pub tzid: &'a str,
    /// daily/weekly DTSTART 계산 기준 ('YYYY-MM-DD').
    pub reference_date: &'a str,
}

/// 매핑 출력.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RRuleSpec {
    /// 'YYYYMMDDTHHMMSS' (로컬 wall-clock, Z 없음).
    pub dtstart_local: String,
    pub tzid: String,
    /// 'FREQ=...' (RRULE: prefix 제외).
    pub rrule: String,
    pub duration_min: u32,
    /// 각 'YYYYMMDDTHHMMSS'. 호출자가 정렬·전달 책임.
    pub exdates: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RRuleError {
    #[error("invalid HH:MM time: {0}")]
    InvalidTime(String),
    #[error("invalid YYYY-MM-DD date: {0}")]
    InvalidDate(String),
    #[error("weekly requires at least one weekday")]
    WeeklyNoWeekdays,
    #[error("biweekly requires anchor_date")]
    BiweeklyMissingAnchor,
    #[error("biweekly requires at least one weekday")]
    BiweeklyNoWeekdays,
    #[error("monthly requires anchor_date")]
    MonthlyMissingAnchor,
    #[error("monthly requires monthly_pattern")]
    MonthlyPatternMissing,
    #[error("monthly nth_weekday requires exactly one weekday")]
    NthWeekdayRequiresSingleWeekday,
    #[error("monthly nth_weekday requires monthly_nth_week")]
    NthWeekdayMissingNthWeek,
    #[error("monthly nth_weekday: nth_week must be -1 or 1..=5")]
    NthWeekdayInvalidNthWeek,
}

/// Google `events.insert` 페이로드용 part들 — `start.dateTime`/`end.dateTime`/`recurrence` 배열.
/// timeZone은 호출자(`CreateEventInput::time_zone`)에서 `RRuleSpec::tzid` 그대로 사용.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventParts {
    /// 'YYYY-MM-DDTHH:MM:SS' (wall-clock, offset 없음).
    pub start_iso: String,
    pub end_iso: String,
    /// ['RRULE:FREQ=...', 'EXDATE;TZID=<tzid>:<dt1>,<dt2>,...'] — exdates 없으면 RRULE 한 줄만.
    pub recurrence_lines: Vec<String>,
}

impl RRuleSpec {
    /// Google API 호출용 변환. start_iso는 `dtstart_local`(compact RFC5545)에 구분자를 끼워넣은 형태.
    /// end_iso는 start + `duration_min`. recurrence_lines는 RRULE/EXDATE 라인.
    pub fn to_event_parts(&self) -> Result<EventParts, RRuleError> {
        let start_iso = compact_to_iso(&self.dtstart_local)?;
        let end_iso = add_minutes_iso(&start_iso, self.duration_min)?;

        let mut lines = Vec::with_capacity(2);
        lines.push(format!("RRULE:{}", self.rrule));
        if !self.exdates.is_empty() {
            let joined = self.exdates.join(",");
            lines.push(format!("EXDATE;TZID={}:{}", self.tzid, joined));
        }
        Ok(EventParts {
            start_iso,
            end_iso,
            recurrence_lines: lines,
        })
    }
}

const DEFAULT_TIME: &str = "09:00";
const DEFAULT_DURATION_MIN: u32 = 30;

/// 메인 매핑.
pub fn routine_to_rrule(input: &RRuleInput<'_>, exdates: &[&str]) -> Result<RRuleSpec, RRuleError> {
    let time_str = input.time_of_day.unwrap_or(DEFAULT_TIME);
    let (hh, mm) = parse_hhmm(time_str)?;
    let duration_min = input.duration_min.unwrap_or(DEFAULT_DURATION_MIN);

    let (dtstart_date, rrule) = match input.freq {
        Freq::Daily => {
            let d = parse_ymd(input.anchor_date.unwrap_or(input.reference_date))?;
            (d, "FREQ=DAILY".to_string())
        }
        Freq::Weekly => {
            if input.weekdays.is_empty() {
                return Err(RRuleError::WeeklyNoWeekdays);
            }
            let ref_d = parse_ymd(input.anchor_date.unwrap_or(input.reference_date))?;
            let dt = next_matching_weekday(ref_d, input.weekdays);
            let byday = join_byday(input.weekdays);
            (dt, format!("FREQ=WEEKLY;BYDAY={byday}"))
        }
        Freq::Biweekly => {
            if input.weekdays.is_empty() {
                return Err(RRuleError::BiweeklyNoWeekdays);
            }
            let anchor = parse_ymd(input.anchor_date.ok_or(RRuleError::BiweeklyMissingAnchor)?)?;
            // anchor가 weekdays에 포함되지 않으면 forward normalize.
            let dt = next_matching_weekday(anchor, input.weekdays);
            let byday = join_byday(input.weekdays);
            (dt, format!("FREQ=WEEKLY;INTERVAL=2;BYDAY={byday}"))
        }
        Freq::Monthly => {
            let anchor = parse_ymd(input.anchor_date.ok_or(RRuleError::MonthlyMissingAnchor)?)?;
            let pattern = input
                .monthly_pattern
                .ok_or(RRuleError::MonthlyPatternMissing)?;
            let rrule = match pattern {
                MonthlyPattern::DayOfMonth => {
                    format!("FREQ=MONTHLY;BYMONTHDAY={}", anchor.day())
                }
                MonthlyPattern::NthWeekday => {
                    if input.weekdays.len() != 1 {
                        return Err(RRuleError::NthWeekdayRequiresSingleWeekday);
                    }
                    let nth = input
                        .monthly_nth_week
                        .ok_or(RRuleError::NthWeekdayMissingNthWeek)?;
                    if nth == 0 || !(-1..=5).contains(&nth) {
                        return Err(RRuleError::NthWeekdayInvalidNthWeek);
                    }
                    format!("FREQ=MONTHLY;BYDAY={nth}{}", input.weekdays[0].rrule_code())
                }
            };
            (anchor, rrule)
        }
    };

    let dtstart_local = format_dtstart(dtstart_date, hh, mm);

    let mut converted = Vec::with_capacity(exdates.len());
    for ex in exdates {
        converted.push(exdate_local(ex, input.time_of_day)?);
    }

    Ok(RRuleSpec {
        dtstart_local,
        tzid: input.tzid.to_string(),
        rrule,
        duration_min,
        exdates: converted,
    })
}

/// EXDATE 단일 항목 변환 헬퍼.
/// `routine_exdates.date`('YYYY-MM-DD') + `routine.time_of_day`('HH:MM' 또는 None)
/// → 'YYYYMMDDTHHMMSS'. None → 09:00 fallback (DTSTART와 일치).
pub fn exdate_local(date_ymd: &str, time_hm: Option<&str>) -> Result<String, RRuleError> {
    let d = parse_ymd(date_ymd)?;
    let (hh, mm) = parse_hhmm(time_hm.unwrap_or(DEFAULT_TIME))?;
    Ok(format_dtstart(d, hh, mm))
}

fn parse_hhmm(s: &str) -> Result<(u32, u32), RRuleError> {
    let bytes = s.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return Err(RRuleError::InvalidTime(s.to_string()));
    }
    let hh: u32 = s[0..2]
        .parse()
        .map_err(|_| RRuleError::InvalidTime(s.to_string()))?;
    let mm: u32 = s[3..5]
        .parse()
        .map_err(|_| RRuleError::InvalidTime(s.to_string()))?;
    if hh > 23 || mm > 59 {
        return Err(RRuleError::InvalidTime(s.to_string()));
    }
    Ok((hh, mm))
}

fn parse_ymd(s: &str) -> Result<NaiveDate, RRuleError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| RRuleError::InvalidDate(s.to_string()))
}

fn format_dtstart(d: NaiveDate, hh: u32, mm: u32) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}00",
        d.year(),
        d.month(),
        d.day(),
        hh,
        mm
    )
}

/// 'YYYYMMDDTHHMMSS' → 'YYYY-MM-DDTHH:MM:SS' (구분자 삽입). 15 chars 강제.
fn compact_to_iso(compact: &str) -> Result<String, RRuleError> {
    if compact.len() != 15 || compact.as_bytes()[8] != b'T' {
        return Err(RRuleError::InvalidDate(compact.to_string()));
    }
    let y = &compact[0..4];
    let mo = &compact[4..6];
    let d = &compact[6..8];
    let hh = &compact[9..11];
    let mm = &compact[11..13];
    let ss = &compact[13..15];
    // 숫자 검증.
    for chunk in [y, mo, d, hh, mm, ss] {
        if !chunk.bytes().all(|b| b.is_ascii_digit()) {
            return Err(RRuleError::InvalidDate(compact.to_string()));
        }
    }
    Ok(format!("{y}-{mo}-{d}T{hh}:{mm}:{ss}"))
}

/// 'YYYY-MM-DDTHH:MM:SS' + N분 → 동일 포맷.
fn add_minutes_iso(iso: &str, minutes: u32) -> Result<String, RRuleError> {
    let dt = NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S")
        .map_err(|_| RRuleError::InvalidDate(iso.to_string()))?;
    let added = dt + Duration::minutes(i64::from(minutes));
    Ok(added.format("%Y-%m-%dT%H:%M:%S").to_string())
}

fn join_byday(weekdays: &[Weekday]) -> String {
    weekdays
        .iter()
        .map(|w| w.rrule_code())
        .collect::<Vec<_>>()
        .join(",")
}

/// reference_date부터 시작해 weekdays 중 하나에 매칭되는 첫 날짜를 반환 (최대 7일 forward).
/// reference_date 자체가 매칭이면 그대로 반환. weekdays는 비어있지 않아야 한다(호출자 보증).
fn next_matching_weekday(reference: NaiveDate, weekdays: &[Weekday]) -> NaiveDate {
    debug_assert!(
        !weekdays.is_empty(),
        "next_matching_weekday: weekdays must be non-empty (caller guarantee)"
    );
    let allowed: Vec<Weekday> = weekdays.to_vec();
    for offset in 0..7 {
        let d = reference + Duration::days(offset);
        if allowed.contains(&Weekday::from_chrono(d.weekday())) {
            return d;
        }
    }
    // weekdays가 비어있지 않다면 unreachable — 호출자가 빈 weekdays를 사전 차단.
    reference
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(freq: Freq) -> RRuleInput<'a> {
        RRuleInput {
            freq,
            weekdays: &[],
            anchor_date: None,
            time_of_day: Some("09:00"),
            duration_min: Some(30),
            monthly_pattern: None,
            monthly_nth_week: None,
            tzid: "Asia/Seoul",
            reference_date: "2026-05-29",
        }
    }

    // 1) daily 자정 (00:00) — KST 자정 경계 회귀.
    #[test]
    fn daily_midnight() {
        let inp = RRuleInput {
            time_of_day: Some("00:00"),
            ..input(Freq::Daily)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260529T000000");
        assert_eq!(s.rrule, "FREQ=DAILY");
        assert_eq!(s.duration_min, 30);
        assert_eq!(s.tzid, "Asia/Seoul");
    }

    // 2) daily 23:59 — 23:59 wall-clock 회귀.
    #[test]
    fn daily_end_of_day() {
        let inp = RRuleInput {
            time_of_day: Some("23:59"),
            ..input(Freq::Daily)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260529T235900");
    }

    // 3) weekly 단일 요일 — reference_date(2026-05-29 금)부터 다음 월요일.
    #[test]
    fn weekly_single_mon() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            ..input(Freq::Weekly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260601T090000"); // 6/1 월
        assert_eq!(s.rrule, "FREQ=WEEKLY;BYDAY=MO");
    }

    // 4) weekly 복수 요일 — reference(금)에 매칭(금 포함) → 그날.
    #[test]
    fn weekly_multi_mwf() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon, Weekday::Wed, Weekday::Fri],
            ..input(Freq::Weekly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260529T090000"); // reference=금, 매칭
        assert_eq!(s.rrule, "FREQ=WEEKLY;BYDAY=MO,WE,FR");
    }

    // 5) weekly 모든 요일 — daily 의미지만 RRULE은 그대로 WEEKLY+BYDAY=...
    #[test]
    fn weekly_all_seven() {
        let inp = RRuleInput {
            weekdays: &[
                Weekday::Mon,
                Weekday::Tue,
                Weekday::Wed,
                Weekday::Thu,
                Weekday::Fri,
                Weekday::Sat,
                Weekday::Sun,
            ],
            ..input(Freq::Weekly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU");
    }

    // 6) biweekly anchor가 weekdays 요일이면 그대로 DTSTART.
    #[test]
    fn biweekly_anchor_on_weekday() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            anchor_date: Some("2026-05-25"), // 월요일
            ..input(Freq::Biweekly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260525T090000");
        assert_eq!(s.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    }

    // 7) biweekly anchor가 weekdays에 없으면 forward normalize (이후 첫 매칭일).
    #[test]
    fn biweekly_anchor_weekday_mismatch_normalizes_forward() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            anchor_date: Some("2026-05-24"), // 일요일
            ..input(Freq::Biweekly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260525T090000"); // 다음 월
        assert_eq!(s.rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
    }

    // 8) biweekly anchor 없음 → error.
    #[test]
    fn biweekly_missing_anchor_errors() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            anchor_date: None,
            ..input(Freq::Biweekly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::BiweeklyMissingAnchor);
    }

    // 9) monthly day_of_month=1.
    #[test]
    fn monthly_day_of_month_1st() {
        let inp = RRuleInput {
            anchor_date: Some("2026-05-01"),
            monthly_pattern: Some(MonthlyPattern::DayOfMonth),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.dtstart_local, "20260501T090000");
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYMONTHDAY=1");
    }

    // 10) monthly day_of_month=15.
    #[test]
    fn monthly_day_of_month_15th() {
        let inp = RRuleInput {
            anchor_date: Some("2026-05-15"),
            monthly_pattern: Some(MonthlyPattern::DayOfMonth),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYMONTHDAY=15");
    }

    // 11) monthly day_of_month=31 — 2월 처리는 Google이 알아서, RRULE 그대로 전달.
    #[test]
    fn monthly_day_of_month_31st() {
        let inp = RRuleInput {
            anchor_date: Some("2026-05-31"),
            monthly_pattern: Some(MonthlyPattern::DayOfMonth),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYMONTHDAY=31");
    }

    // 12) monthly nth_weekday: 2nd Tue.
    #[test]
    fn monthly_nth_weekday_2nd_tue() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Tue],
            anchor_date: Some("2026-05-12"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: Some(2),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYDAY=2TU");
    }

    // 13) monthly nth_weekday: 1st Mon.
    #[test]
    fn monthly_nth_weekday_1st_mon() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            anchor_date: Some("2026-05-04"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: Some(1),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYDAY=1MO");
    }

    // 14) monthly nth_weekday: -1 (last) Fri.
    #[test]
    fn monthly_nth_weekday_last_fri() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Fri],
            anchor_date: Some("2026-05-29"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: Some(-1),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYDAY=-1FR");
    }

    // 15) monthly nth_weekday 5th (존재 안 할 수도 있음 — RRULE 그대로 전달, Google이 skip).
    #[test]
    fn monthly_nth_weekday_5th_thu() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Thu],
            anchor_date: Some("2026-04-30"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: Some(5),
            ..input(Freq::Monthly)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.rrule, "FREQ=MONTHLY;BYDAY=5TH");
    }

    // 16) monthly nth_weekday weekdays 길이 0 또는 >1 → error.
    #[test]
    fn monthly_nth_weekday_requires_single_weekday() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon, Weekday::Tue],
            anchor_date: Some("2026-05-01"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: Some(1),
            ..input(Freq::Monthly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::NthWeekdayRequiresSingleWeekday);
    }

    // 17) monthly nth_weekday nth_week=0 → error.
    #[test]
    fn monthly_nth_weekday_invalid_nth_zero() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            anchor_date: Some("2026-05-01"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: Some(0),
            ..input(Freq::Monthly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::NthWeekdayInvalidNthWeek);
    }

    // 18) EXDATE 다중 변환 + 헬퍼 None 시 09:00 fallback.
    #[test]
    fn exdate_helper_fallback_and_multi() {
        // 단일 fallback.
        assert_eq!(exdate_local("2026-03-15", None).unwrap(), "20260315T090000");
        // 시각 명시.
        assert_eq!(
            exdate_local("2026-03-15", Some("18:30")).unwrap(),
            "20260315T183000"
        );
        // 매핑 함수에서 다중 — 입력 순서 보존(호출자 정렬 책임).
        let inp = RRuleInput {
            time_of_day: Some("18:30"),
            ..input(Freq::Daily)
        };
        let s = routine_to_rrule(&inp, &["2026-06-01", "2026-06-08"]).unwrap();
        assert_eq!(
            s.exdates,
            vec!["20260601T183000".to_string(), "20260608T183000".to_string()]
        );
    }

    // 19) 잘못된 시각 포맷.
    #[test]
    fn invalid_time_format() {
        let inp = RRuleInput {
            time_of_day: Some("9:00"), // 4글자
            ..input(Freq::Daily)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert!(matches!(err, RRuleError::InvalidTime(_)));

        let inp2 = RRuleInput {
            time_of_day: Some("24:00"),
            ..input(Freq::Daily)
        };
        assert!(matches!(
            routine_to_rrule(&inp2, &[]).unwrap_err(),
            RRuleError::InvalidTime(_)
        ));
    }

    // 20) 잘못된 날짜 포맷.
    #[test]
    fn invalid_date_format() {
        let inp = RRuleInput {
            anchor_date: Some("2026/05/01"),
            monthly_pattern: Some(MonthlyPattern::DayOfMonth),
            ..input(Freq::Monthly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert!(matches!(err, RRuleError::InvalidDate(_)));
    }

    // 21) duration_min None → 30 fallback.
    #[test]
    fn duration_default_fallback() {
        let inp = RRuleInput {
            duration_min: None,
            ..input(Freq::Daily)
        };
        let s = routine_to_rrule(&inp, &[]).unwrap();
        assert_eq!(s.duration_min, 30);
    }

    // ── PR 1 critic nits: 누락된 RRuleError 배리언트 negative-path 커버 ──

    // 22) weekly 빈 weekdays → WeeklyNoWeekdays.
    #[test]
    fn weekly_empty_weekdays_errors() {
        let inp = RRuleInput {
            weekdays: &[],
            ..input(Freq::Weekly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::WeeklyNoWeekdays);
    }

    // 23) biweekly 빈 weekdays → BiweeklyNoWeekdays (anchor 체크보다 우선).
    #[test]
    fn biweekly_empty_weekdays_errors() {
        let inp = RRuleInput {
            weekdays: &[],
            anchor_date: Some("2026-05-25"),
            ..input(Freq::Biweekly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::BiweeklyNoWeekdays);
    }

    // 24) monthly anchor 없음 → MonthlyMissingAnchor (pattern 체크보다 우선).
    #[test]
    fn monthly_missing_anchor_errors() {
        let inp = RRuleInput {
            anchor_date: None,
            monthly_pattern: Some(MonthlyPattern::DayOfMonth),
            ..input(Freq::Monthly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::MonthlyMissingAnchor);
    }

    // 25) monthly_pattern 없음 → MonthlyPatternMissing.
    #[test]
    fn monthly_pattern_missing_errors() {
        let inp = RRuleInput {
            anchor_date: Some("2026-05-15"),
            monthly_pattern: None,
            ..input(Freq::Monthly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::MonthlyPatternMissing);
    }

    // 26) nth_weekday + monthly_nth_week 없음 → NthWeekdayMissingNthWeek.
    #[test]
    fn monthly_nth_weekday_missing_nth_week_errors() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            anchor_date: Some("2026-05-04"),
            monthly_pattern: Some(MonthlyPattern::NthWeekday),
            monthly_nth_week: None,
            ..input(Freq::Monthly)
        };
        let err = routine_to_rrule(&inp, &[]).unwrap_err();
        assert_eq!(err, RRuleError::NthWeekdayMissingNthWeek);
    }

    // ── EventParts / ISO 변환 ──

    // 27) to_event_parts: daily 30분 — start_iso + end_iso + RRULE 1줄.
    #[test]
    fn event_parts_daily_30min() {
        let inp = RRuleInput {
            time_of_day: Some("07:00"),
            duration_min: Some(30),
            ..input(Freq::Daily)
        };
        let spec = routine_to_rrule(&inp, &[]).unwrap();
        let parts = spec.to_event_parts().unwrap();
        assert_eq!(parts.start_iso, "2026-05-29T07:00:00");
        assert_eq!(parts.end_iso, "2026-05-29T07:30:00");
        assert_eq!(parts.recurrence_lines, vec!["RRULE:FREQ=DAILY".to_string()]);
    }

    // 28) to_event_parts: weekly + duration 90분 + EXDATE 2건 → EXDATE line 동봉.
    #[test]
    fn event_parts_weekly_with_exdates() {
        let inp = RRuleInput {
            weekdays: &[Weekday::Mon],
            time_of_day: Some("18:30"),
            duration_min: Some(90),
            ..input(Freq::Weekly)
        };
        let spec = routine_to_rrule(&inp, &["2026-06-01", "2026-06-08"]).unwrap();
        let parts = spec.to_event_parts().unwrap();
        assert_eq!(parts.start_iso, "2026-06-01T18:30:00");
        assert_eq!(parts.end_iso, "2026-06-01T20:00:00");
        assert_eq!(parts.recurrence_lines.len(), 2);
        assert_eq!(parts.recurrence_lines[0], "RRULE:FREQ=WEEKLY;BYDAY=MO");
        assert_eq!(
            parts.recurrence_lines[1],
            "EXDATE;TZID=Asia/Seoul:20260601T183000,20260608T183000"
        );
    }

    // 29) duration이 시간/날짜 경계를 넘는 경우.
    #[test]
    fn event_parts_duration_crosses_midnight() {
        let inp = RRuleInput {
            time_of_day: Some("23:30"),
            duration_min: Some(60),
            ..input(Freq::Daily)
        };
        let spec = routine_to_rrule(&inp, &[]).unwrap();
        let parts = spec.to_event_parts().unwrap();
        assert_eq!(parts.start_iso, "2026-05-29T23:30:00");
        assert_eq!(parts.end_iso, "2026-05-30T00:30:00", "자정 넘어 다음 날로");
    }

    // 30) compact_to_iso: 잘못된 길이/문자 → InvalidDate.
    #[test]
    fn compact_to_iso_validates_input() {
        assert!(compact_to_iso("2026-05-29").is_err()); // 길이 부족
        assert!(compact_to_iso("20260529X090000").is_err()); // T 자리 X
        assert!(compact_to_iso("20260529T09000X").is_err()); // 숫자 아님
        assert_eq!(
            compact_to_iso("20260529T090000").unwrap(),
            "2026-05-29T09:00:00"
        );
    }
}
