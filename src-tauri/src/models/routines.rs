use super::{AreaTag, Kind};
use serde::{Deserialize, Serialize};
use specta::Type;
// ── 루틴(Routine) ─────────────────────────────────────────────────────────────

/// 루틴 반복 주기.
/// - Daily: 매일.
/// - Weekly: 매주 선택 요일(weekdays).
/// - Biweekly: 격주 — 선택 요일 + anchor 기준 14일 parity(`(days_since_anchor / 7) % 2 == 0`).
/// - Monthly: 매월 같은 day-of-month(anchor의 일), 월말 클램프(31 → 그달 말일).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RoutineFreq {
    Daily,
    Weekly,
    Biweekly,
    Monthly,
}

/// 요일 (weekly 루틴 스케줄 + 오늘 매칭용).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

/// 오늘 표시할 루틴 항목 (스케줄 매칭 + 날짜별 완료 상태 포함).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineToday {
    pub id: String,
    pub title: String,
    pub freq: RoutineFreq,
    pub weekdays: Vec<Weekday>,
    /// biweekly 2주 주기·monthly day-of-month 기준일 (YYYY-MM-DD). daily/weekly는 None.
    pub anchor_date: Option<String>,
    /// 알림 발사 기준 시각 'HH:MM'(로컬). None=알림 없음.
    pub time_of_day: Option<String>,
    /// 발사를 시각보다 N분 앞당김(예: 30=30분 전). None/0=정시. specta i64/u64 금지 → u32.
    pub reminder_offset_min: Option<u32>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
    /// 주어진 날짜에 완료 체크됐는지 (RoutineCheck 존재 여부).
    pub done: bool,
}

/// 루틴 생성 입력.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoutineInput {
    pub title: String,
    pub freq: RoutineFreq,
    /// weekly/biweekly일 때 해당 요일들. daily/monthly면 무시.
    pub weekdays: Vec<Weekday>,
    /// biweekly/monthly일 때 기준일(YYYY-MM-DD). 비면 백엔드가 오늘로 채운다. daily/weekly는 무시.
    pub anchor_date: Option<String>,
    /// 알림 시각 'HH:MM'(로컬). None=알림 없음.
    pub time_of_day: Option<String>,
    /// 알림 오프셋(분, N분 전). None/0=정시. specta i64/u64 금지 → u32.
    pub reminder_offset_min: Option<u32>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
}

/// 루틴 수정 입력.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoutineInput {
    pub id: String,
    pub title: String,
    pub freq: RoutineFreq,
    /// weekly/biweekly일 때 해당 요일들. daily/monthly면 무시.
    pub weekdays: Vec<Weekday>,
    /// biweekly/monthly일 때 기준일(YYYY-MM-DD). 비면 기존 anchor 유지(없으면 오늘). daily/weekly는 무시.
    pub anchor_date: Option<String>,
    /// 알림 시각 'HH:MM'(로컬). None=알림 없음.
    pub time_of_day: Option<String>,
    /// 알림 오프셋(분, N분 전). None/0=정시. specta i64/u64 금지 → u32.
    pub reminder_offset_min: Option<u32>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
}

/// 루틴 트래킹 한 항목 (Phase 16 #12). 루틴별 이행률(%)·연속(streak)·히스토리.
/// `routine_checks` + 스케줄 occurrence 집계 — 전부 로컬 read(자동화 아님). specta i64/u64 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTrackingItem {
    pub id: String,
    pub title: String,
    pub freq: RoutineFreq,
    /// 집계 기간 내 스케줄상 due occurrence 수.
    pub due: u32,
    /// due 날에 실제 체크된 수(done ⊆ due).
    pub done: u32,
    /// 이행률 = done*100/due (0..100). due=0이면 0.
    pub rate_pct: u32,
    /// 현재 연속(streak): 가장 최근 due 날짜부터 거꾸로 연속 체크된 occurrence 수.
    pub streak: u32,
    /// 히스토리 한 점들(오래된→최신). 히트맵/바 렌더용. 기간 내 due 날만.
    pub history: Vec<RoutineHistoryDay>,
}

/// 루틴 히스토리 한 날 (due occurrence + 체크 여부). 히트맵/바 한 칸.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHistoryDay {
    pub date: String,
    pub done: bool,
}
