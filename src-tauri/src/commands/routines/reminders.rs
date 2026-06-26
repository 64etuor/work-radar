//! 루틴 알림 enqueue (시간 + 오프셋, Phase 16 #6).
//!
//! INVARIANT #5: 스케줄러는 Phase 13 스파인이 bounded tick으로 발사한다 — 여기선 행 INSERT만.
//!   deterministic source_id로 멱등(하루 한 번만 enqueue). 발사·재시도는 스케줄러가 담당.

use chrono::NaiveDate;

use crate::commands::notification_store;
use crate::db::Db;
use crate::models::RoutineToday;

/// 한 루틴의 하루치 알림 식별자 (멱등 dedup·완료 skip 키).
pub(crate) fn reminder_source_id(routine_id: &str, date: &str) -> String {
    format!("routine:{routine_id}:{date}")
}

/// `date`(사용자 TZ 날짜, YYYY-MM-DD) + `time_of_day`(HH:MM) - offset 의 발사 시각을 UTC 'YYYY-MM-DD HH:MM:SS'로.
/// 파싱 실패면 None(스케줄 불명 → enqueue 안 함, graceful).
fn compute_fire_at(date: &str, time_of_day: &str, offset_min: u32) -> Option<String> {
    use chrono::{NaiveDateTime, TimeZone};
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let t = chrono::NaiveTime::parse_from_str(time_of_day, "%H:%M").ok()?;
    let naive = NaiveDateTime::new(d, t) - chrono::Duration::minutes(offset_min as i64);
    // 사용자 타임존(user_timezone SSOT) 벽시계 시각 → UTC. 루틴의 Google 미러도 같은 zone을 쓰므로
    // 캘린더 이벤트와 리마인더가 항상 같은 순간을 가리킨다. (DST 모호/불가 시 단일 결과를 취해 graceful.)
    let local_dt = super::timezone::user_timezone()
        .from_local_datetime(&naive)
        .single()?;
    Some(
        local_dt
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
    )
}

/// 오늘 due이고 time_of_day가 있는 루틴들의 알림을 멱등 enqueue한다(INSERT OR IGNORE on source_id).
/// 이미 완료(체크)된 루틴은 enqueue하지 않는다(완료=알림 불필요). source_id UNIQUE 보장이 없으므로
/// "존재하면 skip"으로 멱등을 강제한다 — 하루 한 번만 행이 생긴다.
pub async fn sync_reminders(
    db: &Db,
    date: &str,
    routines: &[RoutineToday],
) -> Result<(), sqlx::Error> {
    for r in routines {
        let Some(time) = r.time_of_day.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if r.done {
            continue; // 완료된 루틴은 알림 불필요.
        }
        let offset = r.reminder_offset_min.unwrap_or(0);
        let Some(fire_at) = compute_fire_at(date, time, offset) else {
            continue;
        };
        let source_id = reminder_source_id(&r.id, date);

        // 멱등: 같은 source_id 행이 (미발사든 발사든) 이미 있으면 새로 만들지 않는다.
        if notification_store::exists(db, "routine", &source_id).await? {
            continue;
        }

        let title = format!("루틴: {}", r.title);
        let body = if offset > 0 {
            format!("{time} 예정 ({offset}분 전 알림)")
        } else {
            format!("{time} 예정")
        };
        notification_store::enqueue(db, &fire_at, &title, &body, "routine", Some(&source_id))
            .await?;
    }
    Ok(())
}
