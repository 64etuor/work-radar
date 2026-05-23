//! 스프린트 타이머 (P11): 단일 글로벌 스프린트 설정 + 다음 경계 계산.
//!
//! INVARIANT #7: 설정은 per-machine `app_config`(KV) — 신규 테이블 없음. 상태 SSOT(signals) 무침범.
//! 모델 = **길이 + 경계 앵커 조합**: `interval_days`(예: 14) + `anchor`(기준요일 + 시각, 예: 금 21:00).
//! 절대 종료시각을 저장하지 않고 anchor+interval로 **매번 계산**한다 → drift 없음.
//!
//! DST 안전성: 다음 경계는 **로컬 wall-clock**(`NaiveDateTime`) 기준으로 계산한다. 절대 UTC 인스턴트를
//! 저장하지 않으므로 spring-forward/fall-back을 넘는 interval에서도 경계는 항상 "로컬 시각 금 21:00"에
//! 정렬된다(시계가 한 시간 점프해도 wall-clock 앵커는 고정). 남은 시간은 호출자(렌더러)가 동일 로컬
//! 시계로 환산하므로 일관된다. KST는 DST 없지만 로직은 DST 환경에서도 안전 — 단위테스트로 증명한다.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::nav::{get_config, set_config};
use crate::db::Db;
use crate::error::AppError;
use crate::models::Weekday;

const KEY_SPRINT: &str = "sprint.config";

/// 단일 글로벌 스프린트 설정. 길이(interval_days) + 경계 앵커(요일 + 시각).
/// 다음 경계 = 이 앵커에 정렬한 뒤 interval_days 주기로 계산한다(절대 종료시각 미저장).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SprintConfig {
    /// 스프린트 길이(일). 1 이상.
    pub interval_days: u32,
    /// 경계 기준 요일(예: 금요일).
    pub anchor_weekday: Weekday,
    /// 경계 기준 시각 'HH:MM'(로컬 wall-clock).
    pub anchor_time: String,
}

/// `Weekday` → chrono 요일(경계 정렬 계산용).
fn to_chrono_weekday(w: Weekday) -> chrono::Weekday {
    match w {
        Weekday::Mon => chrono::Weekday::Mon,
        Weekday::Tue => chrono::Weekday::Tue,
        Weekday::Wed => chrono::Weekday::Wed,
        Weekday::Thu => chrono::Weekday::Thu,
        Weekday::Fri => chrono::Weekday::Fri,
        Weekday::Sat => chrono::Weekday::Sat,
        Weekday::Sun => chrono::Weekday::Sun,
    }
}

/// 'HH:MM' → `NaiveTime`. 형식 오류는 None(호출자가 보수적으로 처리).
fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

/// 고정 cadence epoch: 앵커 요일·시각에 해당하는 **결정적 기준 경계** 하나.
/// interval이 7의 배수가 아닐 수 있으므로(예: 14일 격주) "now 근처의 다음 요일"을 seed로 쓰면
/// cadence가 흔들린다(매주가 후보가 됨). 대신 모든 `now`에 대해 **불변인** 단일 epoch를 잡고
/// 거기서 interval 정수배로 경계를 산출한다 → 격주 등 비-주간 주기도 안정적이고 drift 없음.
/// epoch = CE 1년 1월 1일 이후 처음 등장하는 anchor 요일의 anchor 시각(로컬 wall-clock).
fn cadence_epoch(target_wd: chrono::Weekday, anchor_time: NaiveTime) -> NaiveDateTime {
    let base = NaiveDate::from_ymd_opt(1, 1, 1).expect("valid CE base date");
    let days_ahead = (7 + target_wd.num_days_from_monday() as i64
        - base.weekday().num_days_from_monday() as i64)
        % 7;
    NaiveDateTime::new(base + Duration::days(days_ahead), anchor_time)
}

/// `now` **이후의** 첫 앵커 정렬 경계를 로컬 wall-clock으로 반환(순수).
///
/// 알고리즘: 고정 cadence epoch(불변)에서 interval_days 정수배로 경계 격자를 만들고,
/// `now`보다 **엄격히 이후**인 가장 이른 격자점을 고른다. epoch가 모든 호출에서 동일하므로
/// 격주(14일) 같은 비-주간 주기도 안정적으로 정렬된다(요일 + 주기 모두 보존).
///
/// `interval_days == 0`이거나 시각 파싱 실패면 None.
pub fn next_boundary(config: &SprintConfig, now: NaiveDateTime) -> Option<NaiveDateTime> {
    if config.interval_days == 0 {
        return None;
    }
    let anchor_time = parse_hhmm(&config.anchor_time)?;
    let target_wd = to_chrono_weekday(config.anchor_weekday);
    let interval_days = config.interval_days as i64;
    let interval = Duration::days(interval_days);

    let epoch = cadence_epoch(target_wd, anchor_time);
    // now가 epoch보다 항상 이후이므로(epoch=서기 1년) 격자 인덱스는 floor((now-epoch)/interval).
    let elapsed_days = (now - epoch).num_days();
    // wall-clock 일수 기준 격자 인덱스(시각 보정은 아래 while로). 음수 방지 위해 0 하한.
    let mut k = (elapsed_days / interval_days).max(0);
    let mut boundary = epoch + interval * (k as i32);
    // now 이후가 될 때까지 전진(엄격히 이후 — 경계 도달 즉시 다음 주기).
    while boundary <= now {
        k += 1;
        boundary = epoch + interval * (k as i32);
    }
    // 한 칸 당겨도 여전히 now 이후면 그게 더 이른 경계(시각 보정으로 한 칸 넘칠 수 있음).
    while boundary - interval > now {
        k -= 1;
        boundary = epoch + interval * (k as i32);
    }
    Some(boundary)
}

/// `now`부터 다음 경계까지 남은 시간(초). 경계가 과거면 음수(overdue). None이면 미설정/무효.
pub fn remaining_seconds(config: &SprintConfig, now: NaiveDateTime) -> Option<i64> {
    next_boundary(config, now).map(|b| (b - now).num_seconds())
}

/// 가벼운 검증: interval_days ≥ 1, anchor_time 'HH:MM' 파싱 가능.
/// (코드/메시지 쌍을 String으로만 돌려준다 — 큰 `AppError`를 plain fn 시그니처에 싣지 않음.)
fn validate(config: &SprintConfig) -> Result<(), (&'static str, &'static str)> {
    if config.interval_days < 1 {
        return Err((
            "sprint.invalid_interval",
            "interval_days는 1 이상이어야 합니다",
        ));
    }
    if parse_hhmm(&config.anchor_time).is_none() {
        return Err((
            "sprint.invalid_time",
            "anchor_time은 'HH:MM' 형식이어야 합니다",
        ));
    }
    Ok(())
}

/// 헤더 카운트다운 데이터: 다음 경계(로컬 RFC3339)와 남은 초(음수=overdue). 미설정 시 None.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SprintStatus {
    /// 다음 경계의 로컬 wall-clock RFC3339 문자열(오프셋 포함). 헤더 1s tick의 기준점.
    pub next_boundary: String,
    /// 산출 시점 기준 남은 초(음수=overdue). 프런트는 이 기준점에서 로컬 시계로 매초 재계산한다.
    /// specta는 i64/u64 export 금지 → i32(범위: 격주=~120만초, i32 ~21억으로 충분 + 음수=overdue).
    pub remaining_seconds: i32,
}

/// 저장된 스프린트 설정(미설정 시 None → 프런트가 empty 상태 표시).
#[tauri::command]
#[specta::specta]
pub async fn get_sprint_config(db: State<'_, Db>) -> Result<Option<SprintConfig>, AppError> {
    let Some(raw) = get_config(db.inner(), KEY_SPRINT).await? else {
        return Ok(None);
    };
    // 손상된 JSON은 미설정처럼 처리(보수적 — 헤더가 empty로 떨어짐).
    Ok(serde_json::from_str::<SprintConfig>(&raw).ok())
}

/// 스프린트 설정 저장(검증 후 JSON upsert). 단일 전역 — app_config 한 행.
#[tauri::command]
#[specta::specta]
pub async fn set_sprint_config(db: State<'_, Db>, config: SprintConfig) -> Result<(), AppError> {
    validate(&config).map_err(|(code, msg)| AppError::validation(code, msg))?;
    let json = serde_json::to_string(&config)
        .map_err(|e| AppError::validation("sprint.serialize", e.to_string()))?;
    Ok(set_config(db.inner(), KEY_SPRINT, &json).await?)
}

/// 헤더 카운트다운용 다음 경계 + 남은 초(SSOT = 직접 구현 `next_boundary`). 미설정/무효 시 None.
/// 로컬 wall-clock(`Local::now()`)으로 계산하므로 DST 환경에서도 안전(절대 인스턴트 미저장 — drift 없음).
#[tauri::command]
#[specta::specta]
pub async fn sprint_status(db: State<'_, Db>) -> Result<Option<SprintStatus>, AppError> {
    let Some(raw) = get_config(db.inner(), KEY_SPRINT).await? else {
        return Ok(None);
    };
    let Ok(config) = serde_json::from_str::<SprintConfig>(&raw) else {
        return Ok(None); // 손상 설정 → 미설정처럼.
    };
    let now_local = chrono::Local::now();
    let now = now_local.naive_local();
    let Some(boundary) = next_boundary(&config, now) else {
        return Ok(None);
    };
    // i32 범위로 클램프(격주 ~120만초로 한참 안쪽 — 방어적 캐스팅).
    let remaining = remaining_seconds(&config, now)
        .unwrap_or(0)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    // 경계의 **그 날짜** 로컬 오프셋으로 RFC3339 생성(now 오프셋이 아님 — DST 경계를 가로질러도
    // 1h drift 없음). 프런트가 Date로 파싱해 1s tick 기준점으로 사용. spring-forward로 건너뛴
    // wall-clock(anchor 21:00에선 사실상 없음)만 now 오프셋으로 폴백.
    let next = chrono::Local
        .from_local_datetime(&boundary)
        .earliest()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| {
            format!(
                "{}{}",
                boundary.format("%Y-%m-%dT%H:%M:%S"),
                now_local.offset()
            )
        });
    Ok(Some(SprintStatus {
        next_boundary: next,
        remaining_seconds: remaining,
    }))
}

/// 스프린트 설정 삭제(미설정 상태로 복원 → 헤더 empty 링크).
#[tauri::command]
#[specta::specta]
pub async fn clear_sprint_config(db: State<'_, Db>) -> Result<(), AppError> {
    sqlx::query("DELETE FROM app_config WHERE key = ?1")
        .bind(KEY_SPRINT)
        .execute(db.inner())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    fn dt(y: i32, m: u32, d: u32, hh: u32, mm: u32) -> NaiveDateTime {
        NaiveDateTime::new(
            NaiveDate::from_ymd_opt(y, m, d).unwrap(),
            NaiveTime::from_hms_opt(hh, mm, 0).unwrap(),
        )
    }

    /// 고정 anchor: 매주 금 21:00, 14일 주기. now 직전/직후 경계 단언.
    fn fri_2100_biweekly() -> SprintConfig {
        SprintConfig {
            interval_days: 14,
            anchor_weekday: Weekday::Fri,
            anchor_time: "21:00".to_string(),
        }
    }

    #[test]
    fn next_boundary_aligns_to_anchor_weekday_and_time() {
        let cfg = fri_2100_biweekly();
        // 2026-05-23은 토요일. 다음 금요일 21:00 경계는 2026-05-29 금 21:00.
        let now = dt(2026, 5, 23, 12, 0);
        let b = next_boundary(&cfg, now).unwrap();
        assert_eq!(b, dt(2026, 5, 29, 21, 0), "다음 금 21:00로 정렬");
        // 남은 시간 = 6일 9시간.
        let secs = remaining_seconds(&cfg, now).unwrap();
        assert_eq!(secs, (6 * 24 + 9) * 3600);
    }

    #[test]
    fn boundary_is_strictly_future_at_exact_anchor() {
        let cfg = fri_2100_biweekly();
        // 정확히 금 21:00이면 즉시 다음 주기(14일 뒤)로 넘어간다(엄격히 이후).
        let now = dt(2026, 5, 29, 21, 0);
        let b = next_boundary(&cfg, now).unwrap();
        assert_eq!(b, dt(2026, 6, 12, 21, 0));
        assert_eq!(remaining_seconds(&cfg, now).unwrap(), 14 * 24 * 3600);
    }

    #[test]
    fn overdue_when_anchor_just_passed_is_next_cycle() {
        let cfg = fri_2100_biweekly();
        // 금 21:01 → 방금 지난 경계는 끝났고 다음은 14일 뒤. 남은 = 14일 - 1분.
        let now = dt(2026, 5, 29, 21, 1);
        let b = next_boundary(&cfg, now).unwrap();
        assert_eq!(b, dt(2026, 6, 12, 21, 0));
        assert_eq!(remaining_seconds(&cfg, now).unwrap(), 14 * 24 * 3600 - 60);
    }

    #[test]
    fn interval_picks_earliest_future_boundary_not_seed_plus_one() {
        // interval 7일(주간) — seed가 곧 다음 경계와 일치해야 한다(한 주기 더 밀리지 않음).
        let cfg = SprintConfig {
            interval_days: 7,
            anchor_weekday: Weekday::Mon,
            anchor_time: "09:00".to_string(),
        };
        // 2026-05-23 토 → 다음 월 09:00 = 2026-05-25.
        let now = dt(2026, 5, 23, 12, 0);
        assert_eq!(next_boundary(&cfg, now).unwrap(), dt(2026, 5, 25, 9, 0));
    }

    #[test]
    fn no_drift_recompute_is_idempotent_across_calls() {
        // 절대 종료시각 미저장 → 같은 now에 대해 항상 동일 경계(drift 없음).
        let cfg = fri_2100_biweekly();
        let now = dt(2026, 7, 1, 10, 30);
        let b1 = next_boundary(&cfg, now).unwrap();
        let b2 = next_boundary(&cfg, now).unwrap();
        assert_eq!(b1, b2);
        // now가 경계 직전으로 전진해도 같은 경계를 가리킨다(앵커 고정 — 누적 오차 없음).
        let just_before = b1 - Duration::minutes(1);
        assert_eq!(next_boundary(&cfg, just_before).unwrap(), b1);
    }

    // ---- DST / 타임존 경계 케이스 (가장 중요) ----
    //
    // chrono-tz 미사용(직접 구현) — 로컬 wall-clock(NaiveDateTime)으로 계산한다.
    // 핵심 보장: 경계는 항상 "로컬 시각 anchor"에 정렬되며, spring-forward(봄, 시계 +1h 점프)·
    // fall-back(가을, 시계 -1h 반복) interval을 넘어도 wall-clock 앵커는 고정된다.
    // 절대 인스턴트를 저장하지 않으므로 DST 전환이 경계 wall-clock을 흔들지 못함을 단언한다.

    #[test]
    fn dst_spring_forward_boundary_keeps_wall_clock_anchor() {
        // 미국 동부 2026 spring-forward: 2026-03-08 02:00 → 03:00 점프.
        // anchor = 일 02:30, 7일 주기. 전환 주의 now(전환 직전)에서 다음 경계는
        // 다음 주 일 02:30(로컬 wall-clock) — 점프한 그 주가 아니라 정상 주에 정렬.
        let cfg = SprintConfig {
            interval_days: 7,
            anchor_weekday: Weekday::Sun,
            anchor_time: "02:30".to_string(),
        };
        // 2026-03-08은 일요일(전환일). 전날 토 23:00에서 다음 경계는 그 일 02:30(wall-clock).
        // 02:30은 spring-forward로 실재하지 않는 로컬 시각이지만, wall-clock 모델은 흔들리지 않는다.
        let now = dt(2026, 3, 7, 23, 0);
        let b = next_boundary(&cfg, now).unwrap();
        assert_eq!(
            b,
            dt(2026, 3, 8, 2, 30),
            "DST 점프와 무관하게 wall-clock 일 02:30에 정렬"
        );
    }

    #[test]
    fn dst_fall_back_interval_spans_transition_no_drift() {
        // 미국 동부 2026 fall-back: 2026-11-01 02:00 → 01:00 반복(시계 -1h).
        // anchor = 금 21:00, 14일 주기. 격주 cadence(고정 epoch 기준)는 …·10-30·11-13·… 에 정렬된다.
        // 11-01 fall-back 전환을 가로지르는 interval(10-30 → 11-13)에서도 경계는 wall-clock 금 21:00.
        // (절대 인스턴트 기준이면 전환 1h만큼 drift날 지점 — wall-clock 모델은 흔들리지 않음.)
        let cfg = SprintConfig {
            interval_days: 14,
            anchor_weekday: Weekday::Fri,
            anchor_time: "21:00".to_string(),
        };
        // 10-30 21:00 경계 직후(10-31 00:00) → 다음은 14일 뒤 11-13 금 21:00.
        let now = dt(2026, 10, 31, 0, 0);
        let b = next_boundary(&cfg, now).unwrap();
        assert_eq!(
            b,
            dt(2026, 11, 13, 21, 0),
            "fall-back 전환을 가로질러도 wall-clock 금 21:00 (drift 없음)"
        );
        // wall-clock 차이로 남은 시간을 재면 정확히 13일 21시간(now=10-31 00:00 → 11-13 21:00).
        // 절대 인스턴트라면 fall-back 1h가 더해져 13일 22시간이 됐을 것 — wall-clock은 결정적.
        assert_eq!(
            remaining_seconds(&cfg, now).unwrap(),
            (13 * 24 + 21) * 3600,
            "wall-clock 기준 남은 초는 DST와 무관하게 결정적"
        );
    }

    #[test]
    fn dst_remaining_seconds_decreases_monotonically_within_sprint() {
        // 단일 스프린트 창 안(같은 경계를 가리키는 동안)에서는 now가 전진하면 remaining이 단조 감소한다.
        // 이 창(10-31 → 11-13 금 21:00)은 11-01 fall-back 전환을 포함한다 — wall-clock 모델은 무영향.
        let cfg = SprintConfig {
            interval_days: 14,
            anchor_weekday: Weekday::Fri,
            anchor_time: "21:00".to_string(),
        };
        let b = next_boundary(&cfg, dt(2026, 10, 31, 0, 0)).unwrap();
        let a = remaining_seconds(&cfg, dt(2026, 10, 31, 0, 0)).unwrap();
        let mid = remaining_seconds(&cfg, dt(2026, 11, 2, 0, 0)).unwrap(); // 전환 직후
                                                                           // 같은 경계를 가리키는지 확인(창을 벗어나지 않음).
        assert_eq!(next_boundary(&cfg, dt(2026, 11, 2, 0, 0)).unwrap(), b);
        assert!(mid < a, "전환을 넘어도 wall-clock remaining은 단조 감소");
        assert_eq!(
            a - mid,
            2 * 24 * 3600,
            "wall-clock 2일 차이 정확(전환 1h 누수 없음)"
        );
    }

    #[tokio::test]
    async fn config_round_trip_via_app_config() {
        let db = fresh_db().await;
        // 미설정 → None.
        assert!(get_config(&db, KEY_SPRINT).await.unwrap().is_none());
        let cfg = fri_2100_biweekly();
        let json = serde_json::to_string(&cfg).unwrap();
        set_config(&db, KEY_SPRINT, &json).await.unwrap();
        let raw = get_config(&db, KEY_SPRINT).await.unwrap().unwrap();
        let back: SprintConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn validate_rejects_zero_interval_and_bad_time() {
        let mut cfg = fri_2100_biweekly();
        cfg.interval_days = 0;
        assert!(validate(&cfg).is_err());
        let mut cfg = fri_2100_biweekly();
        cfg.anchor_time = "25:99".to_string();
        assert!(validate(&cfg).is_err());
        assert!(validate(&fri_2100_biweekly()).is_ok());
    }
}
