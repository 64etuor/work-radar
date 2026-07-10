//! 시간 윈도우 유틸 (오늘/임의 범위 → RFC3339 [start,end] 한 쌍). 순수 + 시스템 로컬 오프셋 조회.

/// 오늘 윈도우 [00:00:00, 23:59:59] (RFC3339, 주어진 로컬 오프셋). 순수.
pub fn today_window(date: &str, offset: &str) -> (String, String) {
    (
        format!("{date}T00:00:00{offset}"),
        format!("{date}T23:59:59{offset}"),
    )
}

/// 임의 [start_date, end_date] 범위 윈도우 [start 00:00:00, end 23:59:59] (RFC3339, 주어진 오프셋). 순수.
/// 주/월 뷰는 이 윈도우 하나로 **단일 Google range 호출**(N일×1콜 금지). 경계 산출은 프런트(주 시작
/// 요일/월 경계)가 정하고, Rust는 그 [start,end]를 RFC3339 윈도우로 감싸기만 한다(today_window의 일반화).
pub fn range_window(start_date: &str, end_date: &str, offset: &str) -> (String, String) {
    (
        format!("{start_date}T00:00:00{offset}"),
        format!("{end_date}T23:59:59{offset}"),
    )
}

/// 시스템 로컬 UTC 오프셋 문자열("+09:00" 등). OS 로컬 SSOT(`crate::timezone`) 위임(순수 아님).
pub fn local_offset() -> String {
    crate::timezone::local_offset_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// today_window: 주어진 오프셋으로 [00:00:00, 23:59:59] RFC3339.
    #[test]
    fn today_window_builds_rfc3339_bounds() {
        assert_eq!(
            today_window("2026-05-21", "+09:00"),
            (
                "2026-05-21T00:00:00+09:00".into(),
                "2026-05-21T23:59:59+09:00".into()
            )
        );
        assert_eq!(
            today_window("2026-05-21", "-05:00"),
            (
                "2026-05-21T00:00:00-05:00".into(),
                "2026-05-21T23:59:59-05:00".into()
            )
        );
    }

    /// range_window(P7): 임의 [start,end] → [start 00:00:00, end 23:59:59] RFC3339, 주어진 오프셋.
    /// 일/주/월 각 범위가 단일 윈도우 한 쌍으로 감싸지는지(주/월도 단발 range 콜) 경계 검증.
    #[test]
    fn range_window_day_week_month_bounds() {
        // 일(日) 뷰: start == end == 같은 날 → today_window와 동일 경계.
        assert_eq!(
            range_window("2026-05-21", "2026-05-21", "+09:00"),
            (
                "2026-05-21T00:00:00+09:00".into(),
                "2026-05-21T23:59:59+09:00".into()
            )
        );
        // 주(週) 뷰: 월요일 시작 ~ 일요일 끝(7일). 2026-05-18(월)~2026-05-24(일).
        assert_eq!(
            range_window("2026-05-18", "2026-05-24", "+09:00"),
            (
                "2026-05-18T00:00:00+09:00".into(),
                "2026-05-24T23:59:59+09:00".into()
            )
        );
        // 월(月) 뷰: 1일 ~ 말일(31일). 2026-05-01 ~ 2026-05-31.
        assert_eq!(
            range_window("2026-05-01", "2026-05-31", "+09:00"),
            (
                "2026-05-01T00:00:00+09:00".into(),
                "2026-05-31T23:59:59+09:00".into()
            )
        );
        // 음수 오프셋(타임존)도 동일 처리.
        assert_eq!(
            range_window("2026-02-01", "2026-02-28", "-05:00"),
            (
                "2026-02-01T00:00:00-05:00".into(),
                "2026-02-28T23:59:59-05:00".into()
            )
        );
    }
}
