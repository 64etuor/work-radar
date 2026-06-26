//! 사용자 타임존 SSOT.
//!
//! 루틴 도메인의 두 시간 경계 — Google 동기화(`google_sync`: 이벤트 `start.timeZone` + RRULE `UNTIL`
//! 변환)와 리마인더 발사시각(`reminders::compute_fire_at`: 로컬 벽시계 → UTC) — 가 **같은 단일 출처**를
//! 쓰게 해, 같은 루틴의 캘린더 미러와 알림이 항상 같은 zone을 따르게 한다. (이전엔 동기화=하드코딩
//! `Asia/Seoul`, 리마인더=시스템 `Local`로 어긋났다 — 비KST/여행 사용자에서 불일치.)
//!
//! 현재는 시스템 IANA tz를 감지한다. 설정 UI는 후속(그때 이 함수만 "설정값 우선, 기본=시스템"으로
//! 바꾸면 호출처는 무변경). 감지 실패/미인식 tzid는 `Asia/Seoul`로 fail-closed(기존 기본 동작 보존).

use chrono_tz::Tz;

/// 사용자 타임존(IANA). 시스템 tz를 감지하고 실패 시 `Asia/Seoul`로 폴백.
pub(crate) fn user_timezone() -> Tz {
    resolve_user_timezone(iana_time_zone::get_timezone().ok().as_deref())
}

/// 순수 결정 로직(테스트용): 감지된 tz 이름 → `Tz`. 미감지(None)/빈/미인식은 `Asia/Seoul`.
fn resolve_user_timezone(detected: Option<&str>) -> Tz {
    detected
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or(Tz::Asia__Seoul)
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

    // 미감지/빈/미인식 tzid는 Asia/Seoul로 fail-closed(기존 하드코딩 기본 보존).
    #[test]
    fn falls_back_to_seoul_on_unknown_or_missing() {
        assert_eq!(resolve_user_timezone(Some("Mars/Phobos")), Tz::Asia__Seoul);
        assert_eq!(resolve_user_timezone(Some("")), Tz::Asia__Seoul);
        assert_eq!(resolve_user_timezone(None), Tz::Asia__Seoul);
    }

    // OS 감지 경로 스모크 — 값은 환경 의존이나 panic 없이 유효한 Tz를 돌려준다.
    #[test]
    fn user_timezone_resolves_without_panic() {
        let _tz = user_timezone();
    }
}
