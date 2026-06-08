//! 캘린더 긴급도(제목/키워드 퍼지 매칭) — **표시 힌트(suggested_*) 전용 순수 로직**.
//!
//! ⚠️ INVARIANT #1: 여기 어떤 함수도 확정 `quadrant`(사람 결정 위치)를 만들거나 바꾸지 않는다.
//!    카드 title/keywords를 캘린더 이벤트 title과 퍼지 매칭해, 연관 이벤트가 임박하면 그 카드의
//!    **제안(suggested) 사분면 힌트만** 위로 가중한다(자동 이동/자동 분류 0). 가중 결과를 어디에
//!    쓸지(=suggested_quadrant 컬럼)는 호출부가 결정하며, confirmed quadrant 컬럼은 절대 미접근.
//!
//! 순수 함수(`calendar_urgency_score` / `urgency_escalated_quadrant`)로 빼서 cargo test로 검증한다.

use crate::models::{CalendarEvent, Quadrant};

/// 매칭을 고려하는 시간 지평(초). 이 너머의 이벤트는 긴급도에 기여하지 않는다(과거 이벤트도 0).
/// 72시간 = 3일 — "임박" 윈도(가중은 가까울수록 큼). bounded(무한 지평 금지).
pub const URGENCY_HORIZON_SECS: i64 = 72 * 3600;

/// 토큰을 매칭 후보로 인정하는 최소 길이(문자). 1~2자 토큰(조사/관사/숫자 노이즈)은 제외해
/// 우연 매칭을 줄인다(퍼지 — 완벽 매칭 불필요, 노이즈 차단만).
const MIN_TOKEN_LEN: usize = 2;

/// 문자열을 매칭용 토큰 집합으로 정규화: 소문자 + 영숫자(유니코드 alphanumeric) 경계로 분할 +
/// 짧은 토큰 제거. 한국어/영문 혼용을 단순 처리한다(외부 의존성 없이 — 가장 작은 변경).
fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= MIN_TOKEN_LEN)
        .map(|t| t.to_string())
        .collect()
}

/// 카드(title + keywords)와 이벤트 title의 **퍼지 매칭 여부**. 완벽 매칭 불필요 — 둘 중 하나라도
/// 공통 토큰이 있거나 한쪽 토큰이 다른 쪽 텍스트의 부분문자열이면 매칭(노이즈는 MIN_TOKEN_LEN로 차단).
fn fuzzy_match(card_tokens: &[String], event_title: &str) -> bool {
    if card_tokens.is_empty() {
        return false;
    }
    let event_lc = event_title.to_lowercase();
    let event_tokens = tokenize(event_title);
    for ct in card_tokens {
        // 정확 토큰 공유.
        if event_tokens.iter().any(|et| et == ct) {
            return true;
        }
        // 부분문자열(한쪽이 다른 쪽을 포함) — "데모준비" vs "데모" 류.
        if event_lc.contains(ct.as_str()) {
            return true;
        }
        if event_tokens.iter().any(|et| ct.contains(et.as_str())) {
            return true;
        }
    }
    false
}

/// 이벤트 시작 epoch초(로컬 무관 — RFC3339/날짜 둘 다 chrono로 파싱). 파싱 실패면 None.
fn event_start_epoch(ev: &CalendarEvent) -> Option<i64> {
    // timed = RFC3339(오프셋 포함) → 그대로 파싱.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&ev.start) {
        return Some(dt.timestamp());
    }
    // all-day = YYYY-MM-DD → 그날 자정(UTC 기준 근사 — 긴급도는 일 단위 가중이라 충분).
    if let Ok(d) =
        chrono::NaiveDate::parse_from_str(ev.start.get(0..10).unwrap_or(&ev.start), "%Y-%m-%d")
    {
        return d.and_hms_opt(0, 0, 0).map(|ndt| ndt.and_utc().timestamp());
    }
    None
}

/// 이벤트 종료 epoch초(다중일 span 매칭용). 파싱 실패면 시작과 동일 취급(None→start fallback은 호출부).
/// P7 critic 인계: CalendarView는 이벤트를 시작일로만 버킷팅하지만, 긴급도 매칭은 [start,end] span을
/// 직접 본다(이미 진행 중인 다중일 이벤트도 "임박"으로 인정).
fn event_end_epoch(ev: &CalendarEvent) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&ev.end) {
        return Some(dt.timestamp());
    }
    if let Ok(d) =
        chrono::NaiveDate::parse_from_str(ev.end.get(0..10).unwrap_or(&ev.end), "%Y-%m-%d")
    {
        return d.and_hms_opt(0, 0, 0).map(|ndt| ndt.and_utc().timestamp());
    }
    None
}

/// 카드 title/keywords를 캘린더 이벤트 title과 퍼지 매칭해 **긴급도 점수**(0.0..=1.0)를 낸다(순수).
/// - 매칭되는 이벤트가 없거나 모두 지평(72h) 밖/과거면 0.0.
/// - 매칭 이벤트가 가까울수록 점수↑(now에서 시작까지 남은 시간을 지평으로 정규화: 임박=1.0, 지평=0.0).
/// - 다중일 이벤트는 [start,end] span이 now..지평과 겹치면 "임박"으로 본다(이미 진행 중이면 1.0).
/// - 여러 이벤트가 매칭되면 가장 높은(가장 임박한) 점수를 쓴다.
///
/// `keywords`는 카드 보조 키워드(없으면 빈 슬라이스). title과 합쳐 토큰화한다.
pub fn calendar_urgency_score(
    title: &str,
    keywords: &[String],
    events: &[CalendarEvent],
    now_epoch_secs: i64,
) -> f64 {
    let mut card_text = title.to_string();
    for k in keywords {
        card_text.push(' ');
        card_text.push_str(k);
    }
    let card_tokens = tokenize(&card_text);
    if card_tokens.is_empty() {
        return 0.0;
    }

    let horizon_end = now_epoch_secs + URGENCY_HORIZON_SECS;
    let mut best = 0.0_f64;
    for ev in events {
        if !fuzzy_match(&card_tokens, &ev.title) {
            continue;
        }
        let Some(start) = event_start_epoch(ev) else {
            continue;
        };
        let end = event_end_epoch(ev).unwrap_or(start).max(start);
        // span [start,end]가 [now, horizon_end]와 겹치지 않으면 기여 없음(과거/먼 미래 제외).
        if end < now_epoch_secs || start > horizon_end {
            continue;
        }
        // 이미 진행 중(start<=now<=end)이면 최대 임박. 아니면 남은 시간을 지평으로 선형 정규화.
        let score = if start <= now_epoch_secs {
            1.0
        } else {
            let remaining = (start - now_epoch_secs) as f64;
            (1.0 - remaining / URGENCY_HORIZON_SECS as f64).clamp(0.0, 1.0)
        };
        if score > best {
            best = score;
        }
    }
    best
}

/// 긴급도 점수 → **제안(suggested) 사분면 힌트** 가중(순수). base는 enrich가 이미 제안한 힌트(없을 수
/// 있음). 점수가 임계치를 넘으면 더 위(긴급)로 끌어올린 *제안값*을 돌려준다.
///
/// ⚠️ 반환값은 **suggested_quadrant**에만 쓰인다(호출부 계약) — 확정 `quadrant`는 절대 건드리지 않는다.
/// 매핑(보수적, 한 단계만 끌어올림 — 자동 q1 단정 회피):
/// - score ≥ 0.66 (≤ ~1일): q2 이하/미설정 → q1_do_now 제안. (이미 q1이면 유지.)
/// - score ≥ 0.33 (≤ ~2일): 미설정/q3/q4 → q2_schedule 제안. (q1/q2면 유지 — 강등 금지.)
/// - 그 외: base 그대로(가중 없음).
pub fn urgency_escalated_quadrant(base: Option<Quadrant>, score: f64) -> Option<Quadrant> {
    /// 사분면의 "긴급도 랭크"(높을수록 위). 강등 금지(가중은 위로만)에 쓴다.
    fn rank(q: Quadrant) -> u8 {
        match q {
            Quadrant::Q1DoNow => 4,
            Quadrant::Q2Schedule => 3,
            Quadrant::Q3QuickContain => 2,
            Quadrant::Q4Drop => 1,
            Quadrant::Unclassified => 0,
        }
    }
    let target = if score >= 0.66 {
        Some(Quadrant::Q1DoNow)
    } else if score >= 0.33 {
        Some(Quadrant::Q2Schedule)
    } else {
        return base; // 가중 임계치 미만 — 무변경.
    };
    match (base, target) {
        // base가 더 긴급하면(또는 같으면) 강등하지 않는다(위로만 가중).
        (Some(b), Some(t)) if rank(b) >= rank(t) => Some(b),
        _ => target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CalendarEvent;

    /// 테스트용 이벤트(제목 + RFC3339 start/end). all-day 아님.
    fn ev(title: &str, start: &str, end: &str) -> CalendarEvent {
        CalendarEvent {
            id: "e".into(),
            recurring_event_id: None,
            calendar_id: "c".into(),
            calendar_summary: "cal".into(),
            title: title.into(),
            start: start.into(),
            end: end.into(),
            all_day: false,
            location: None,
            url: None,
            project_id: "p".into(),
            project_color: "#2D6CDF".into(),
            project_text_color: "#FFFFFF".into(),
        }
    }

    /// 2026-05-23T00:00:00Z 기준 now(테스트 고정점).
    fn now() -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-05-23T00:00:00Z")
            .unwrap()
            .timestamp()
    }

    /// 핵심 단언(plan 검증): 미분류 카드 1개 + **제목이 매칭되는** 캘린더 이벤트를 임박(N시간 이내)으로
    /// 두면 긴급도 점수가 매칭 이벤트 없을 때(0.0)보다 **상승**한다.
    #[test]
    fn score_rises_when_matching_event_is_imminent() {
        let now = now();
        // 매칭 이벤트 없음 → 0.0.
        let no_match = calendar_urgency_score(
            "데모 준비",
            &[],
            &[ev(
                "치과 예약",
                "2026-05-23T06:00:00Z",
                "2026-05-23T07:00:00Z",
            )],
            now,
        );
        assert_eq!(no_match, 0.0, "매칭 이벤트 없으면 0");

        // 제목 매칭 + 6시간 뒤(임박) → 점수 상승.
        let imminent = calendar_urgency_score(
            "데모 준비",
            &[],
            &[ev(
                "팀 데모 발표",
                "2026-05-23T06:00:00Z",
                "2026-05-23T07:00:00Z",
            )],
            now,
        );
        assert!(
            imminent > no_match,
            "매칭+임박이면 점수가 매칭 없을 때(0)보다 상승해야: {imminent} > {no_match}"
        );
        assert!(imminent > 0.9, "6시간 뒤면 거의 최대 임박: {imminent}");
    }

    /// 같은 매칭 이벤트라도 **멀수록 점수가 낮다**(가까울수록 가중↑).
    #[test]
    fn nearer_event_scores_higher() {
        let now = now();
        let near = calendar_urgency_score(
            "데모 준비",
            &[],
            &[ev(
                "데모 발표",
                "2026-05-23T12:00:00Z",
                "2026-05-23T13:00:00Z",
            )],
            now,
        );
        let far = calendar_urgency_score(
            "데모 준비",
            &[],
            &[ev(
                "데모 발표",
                "2026-05-25T12:00:00Z",
                "2026-05-25T13:00:00Z",
            )],
            now,
        );
        assert!(near > far, "가까운 이벤트가 더 긴급: {near} > {far}");
    }

    /// 지평(72h) 밖 / 과거 이벤트는 기여하지 않는다(0.0). bounded 윈도.
    #[test]
    fn out_of_horizon_and_past_events_score_zero() {
        let now = now();
        // 5일 뒤(지평 밖).
        let far = calendar_urgency_score(
            "데모 준비",
            &[],
            &[ev(
                "데모 발표",
                "2026-05-28T12:00:00Z",
                "2026-05-28T13:00:00Z",
            )],
            now,
        );
        assert_eq!(far, 0.0, "지평 밖이면 0");
        // 어제 끝난 이벤트(과거).
        let past = calendar_urgency_score(
            "데모 준비",
            &[],
            &[ev(
                "데모 발표",
                "2026-05-22T12:00:00Z",
                "2026-05-22T13:00:00Z",
            )],
            now,
        );
        assert_eq!(past, 0.0, "과거면 0");
    }

    /// 다중일(span) 이벤트: 시작은 과거지만 지금 진행 중이면 임박(1.0)으로 본다(P7 critic 인계).
    #[test]
    fn multiday_event_in_progress_is_imminent() {
        let now = now();
        let score = calendar_urgency_score(
            "컨퍼런스 발표 자료",
            &[],
            &[ev(
                "개발자 컨퍼런스",
                "2026-05-22T09:00:00Z", // 어제 시작
                "2026-05-24T18:00:00Z", // 내일까지 (진행 중)
            )],
            now,
        );
        assert_eq!(score, 1.0, "진행 중 다중일 이벤트는 최대 임박");
    }

    /// keywords로도 매칭된다(title 외 보조 키워드).
    #[test]
    fn matches_via_keywords() {
        let now = now();
        let score = calendar_urgency_score(
            "자료 정리",
            &["스프린트".to_string()],
            &[ev(
                "스프린트 리뷰",
                "2026-05-23T08:00:00Z",
                "2026-05-23T09:00:00Z",
            )],
            now,
        );
        assert!(score > 0.0, "keywords로 매칭되면 점수>0: {score}");
    }

    /// urgency_escalated_quadrant: **suggested 힌트만** 위로 가중하고, 강등하지 않는다.
    #[test]
    fn escalation_only_raises_suggested_hint() {
        // 높은 점수: 미설정 → q1 제안.
        assert!(matches!(
            urgency_escalated_quadrant(None, 0.9),
            Some(Quadrant::Q1DoNow)
        ));
        // 중간 점수: 미설정 → q2 제안.
        assert!(matches!(
            urgency_escalated_quadrant(None, 0.4),
            Some(Quadrant::Q2Schedule)
        ));
        // 낮은 점수: 무변경(base 유지).
        assert!(urgency_escalated_quadrant(None, 0.1).is_none());
        assert!(matches!(
            urgency_escalated_quadrant(Some(Quadrant::Q3QuickContain), 0.1),
            Some(Quadrant::Q3QuickContain)
        ));
        // 강등 금지: base가 이미 q1이면 중간 점수에도 q1 유지.
        assert!(matches!(
            urgency_escalated_quadrant(Some(Quadrant::Q1DoNow), 0.4),
            Some(Quadrant::Q1DoNow)
        ));
        // q3 base + 중간 점수 → q2로 끌어올림(위로만).
        assert!(matches!(
            urgency_escalated_quadrant(Some(Quadrant::Q4Drop), 0.4),
            Some(Quadrant::Q2Schedule)
        ));
    }
}
