//! OS 로컬 타임존/시각 SSOT — **설정 없음, 항상 OS 설정을 따른다(by design)**.
//!
//! 앱의 모든 "로컬 시간" 파생은 이 모듈을 거친다: 루틴 Google 동기화(tzid + RRULE UNTIL),
//! 리마인더 발사시각, mmbak 임포트 날짜 버킷, OKR/스프린트/루틴의 "오늘", 캘린더 로컬
//! 정규화·오프셋 문자열. **`chrono::Local`을 프로덕션에서 직접 쓰지 말 것** — IANA 이름이
//! 필요한 소비처(Google tzid, RRULE)와 오프셋만 필요한 소비처가 여기서 같은 zone을 보게
//! 하는 것이 이 모듈의 존재 이유다(반쪽은 Local, 반쪽은 감지 zone이면 폴백/오버라이드
//! 상황에서 "오늘"이 두 갈래로 갈라진다).
//!
//! 감지 실패/미인식 tzid는 **UTC 폴백**(중립값 — 특정 지역 하드코딩 없음). 타임존 설정
//! UI는 의도적으로 만들지 않는다: 데스크톱 앱의 진실은 OS 설정이고, OS를 바꾸면 앱이
//! 자연스럽게 따라온다(2026-07-10 사용자 결정, docs/decisions.md).

use chrono::{DateTime, NaiveDate, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;

/// 사용자(OS) 타임존(IANA). 감지 실패 시 UTC.
pub(crate) fn user_timezone() -> Tz {
    resolve_user_timezone(iana_time_zone::get_timezone().ok().as_deref())
}

/// 순수 결정 로직(테스트용): 감지된 tz 이름 → `Tz`. 미감지(None)/빈/미인식은 UTC.
fn resolve_user_timezone(detected: Option<&str>) -> Tz {
    detected
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC)
}

/// 지금 이 순간의 OS 로컬 시각(IANA zone 부착 — per-instant DST 정확).
pub(crate) fn now_local() -> DateTime<Tz> {
    Utc::now().with_timezone(&user_timezone())
}

/// OS 로컬 기준 오늘.
pub(crate) fn local_today() -> NaiveDate {
    now_local().date_naive()
}

/// OS 로컬 기준 오늘 'YYYY-MM-DD' (문자열 소비처용 — 루틴 due-calc 등).
pub(crate) fn local_today_string() -> String {
    local_today().format("%Y-%m-%d").to_string()
}

/// 시스템 로컬 UTC 오프셋 문자열("+09:00" 형태). `Tz` 오프셋의 `Display`는 약어("KST")라
/// 반드시 `fix()`를 거친다 — RFC3339 조립에 약어가 새어들면 파싱이 깨진다.
pub(crate) fn local_offset_string() -> String {
    now_local().offset().fix().to_string()
}

/// naive 로컬 wall-clock → OS 로컬 존 부착. DST 모호(fall-back)는 earliest 해석,
/// 존재하지 않는 시각(spring-forward gap)은 None — 호출자가 폴백을 정한다.
pub(crate) fn attach_local(naive: &NaiveDateTime) -> Option<DateTime<Tz>> {
    user_timezone().from_local_datetime(naive).earliest()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 알려진 IANA 이름은 그대로 해석된다(시스템 감지가 흔히 돌려주는 형태).
    #[test]
    fn resolves_known_iana_zone() {
        assert_eq!(
            resolve_user_timezone(Some("America/New_York")),
            Tz::America__New_York
        );
        assert_eq!(resolve_user_timezone(Some("Asia/Seoul")), Tz::Asia__Seoul);
    }

    // 미감지/빈/미인식 tzid는 UTC로 폴백(중립값 — 지역 하드코딩 없음).
    #[test]
    fn falls_back_to_utc_on_unknown_or_missing() {
        assert_eq!(resolve_user_timezone(Some("Mars/Phobos")), Tz::UTC);
        assert_eq!(resolve_user_timezone(Some("")), Tz::UTC);
        assert_eq!(resolve_user_timezone(None), Tz::UTC);
    }

    // OS 감지 경로 스모크 — 값은 환경 의존이나 panic 없이 유효한 Tz를 돌려준다.
    #[test]
    fn user_timezone_resolves_without_panic() {
        let _tz = user_timezone();
    }

    // 오프셋 문자열은 항상 "+HH:MM"/"-HH:MM" — Tz Display 약어("KST")가 새면 RFC3339가 깨진다.
    #[test]
    fn local_offset_string_is_numeric_rfc3339_offset() {
        assert_numeric_offset(&local_offset_string());
    }

    // 머신 존과 무관한 파라메트릭 계약 고정: 하프아워(+05:30)·음수 오프셋도 ±HH:MM 6자
    // (chrono FixedOffset Display 보증을 우리 계약으로 잠근다, critic MINOR-3).
    #[test]
    fn fixed_offset_display_contract_covers_half_hour_and_negative() {
        let kolkata = chrono::FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap();
        assert_eq!(kolkata.to_string(), "+05:30");
        let newfoundland_dst = chrono::FixedOffset::west_opt(2 * 3600 + 30 * 60).unwrap();
        assert_eq!(newfoundland_dst.to_string(), "-02:30");
        assert_numeric_offset(&kolkata.to_string());
        assert_numeric_offset(&newfoundland_dst.to_string());
    }

    fn assert_numeric_offset(s: &str) {
        let bytes = s.as_bytes();
        assert_eq!(s.len(), 6, "offset {s:?} must be ±HH:MM");
        assert!(bytes[0] == b'+' || bytes[0] == b'-', "offset {s:?}");
        assert_eq!(bytes[3], b':', "offset {s:?}");
        assert!(
            s[1..3].parse::<u32>().is_ok() && s[4..6].parse::<u32>().is_ok(),
            "offset {s:?}"
        );
    }

    // attach_local: 평범한 시각은 존 부착 + 같은 wall-clock 유지.
    #[test]
    fn attach_local_keeps_wall_clock() {
        let naive = chrono::NaiveDate::from_ymd_opt(2026, 7, 10)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let attached = attach_local(&naive).expect("noon must exist in every zone");
        assert_eq!(attached.naive_local(), naive);
    }

    // 로컬 계열 파생은 전부 같은 zone(user_timezone)에서 나온다 — SSOT 일관성 스모크.
    #[test]
    fn today_and_now_agree() {
        assert_eq!(local_today(), now_local().date_naive());
        assert_eq!(
            local_today_string(),
            local_today().format("%Y-%m-%d").to_string()
        );
    }
}
