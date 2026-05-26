use super::WorkSignal;
use serde::{Deserialize, Serialize};
use specta::Type;
// ── Today 운영 뷰 + Work Debt (Phase 11a) ─────────────────────────────────────
//
// 전부 로컬 SQLite 집계 — 네트워크 없음(캘린더는 프런트가 fetchCalendarEvents로 별도 합성).
// INVARIANT #1: read 집계일 뿐 — 자동 분류/승격 없음. specta i64/u64 export 금지 → 카운트는 u32.

/// Work Debt 지표 (Today 콕핏 상단 스트립 + 일별 스냅샷 입력).
/// 임계치: q1_overdue = q1 생성 ≥ 1일, stale_backlog = 생성 ≥ 14일(today 레일 밖).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkDebt {
    /// quadrant=unclassified active (today 레일 밖) — "미분류 수".
    pub unclassified: u32,
    /// q1_do_now active & 생성 ≥ 1일 경과 (당일 처리 못 한 긴급).
    pub q1_overdue: u32,
    /// active & 생성 ≥ 14일 경과 (today 레일 밖) — 오래 멈춘 것.
    pub stale_backlog: u32,
    /// type=cleanup active — 정리 필요(머지 후 등).
    pub cleanup_needed: u32,
}

/// Today 운영 뷰 집계. 캘린더 오늘 이벤트·Today 레일·루틴은 프런트가 기존 헬퍼로 합성한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodayOverview {
    pub work_debt: WorkDebt,
    /// 사람이 q1으로 분류했고 아직 Today 레일에 없는 활성 신호(콕핏에서 끌어올릴 대상).
    pub q1_items: Vec<WorkSignal>,
    /// 매트릭스로 escalate된 PR 신호(source=github_pr, type=pr_attention) — ambient PR이 임계치 넘은 것.
    pub pr_attention: Vec<WorkSignal>,
}

// ── Weekly review (Phase 11c, read 집계) ──────────────────────────────────────
//
// 지난 7일 집계. throughput/PR/루틴은 기존 타임스탬프에서 live 유도, debt_trend는
// debt_snapshots(11a부터 전진 누적)에서 읽는다. 전부 read — 외부 변경 없음. specta i64 금지 → u32.

/// 주간 처리량(지난 7일).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyThroughput {
    /// 캡처된 braindump 신호 수(created_at 로컬 기준).
    pub captured: u32,
    /// 완료한 Today 레일 항목 수(today_done_at 로컬 날짜 기준).
    pub completed: u32,
    /// accept된 외부 승격(Notion 등 status=created) 수.
    pub promoted: u32,
}

/// 주간 PR 활동. PR Radar는 ambient(머지 히스토리 미영속) → 근사:
/// `attention_new`=범위 내 새 PR-attention 신호, `resolved`=done 전이된 PR 신호(머지/CI해소 근사).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyPrActivity {
    pub attention_new: u32,
    pub resolved: u32,
}

/// 주간 루틴 이행률. due=스케줄상 해당 occurrence 수, done=실제 체크 수, rate_pct=done*100/due(0..100).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyRoutineAdherence {
    pub due: u32,
    pub done: u32,
    pub rate_pct: u32,
}

/// 부채 추세 한 점(일별 스냅샷). 11a부터 전진 누적 — 7일 미만이면 있는 만큼만.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DebtPoint {
    pub date: String,
    pub unclassified: u32,
    pub q1_overdue: u32,
    pub stale_backlog: u32,
    pub cleanup_needed: u32,
    pub pr_attention: u32,
}

/// Weekly review 집계(지난 7일, [start, end] 로컬 날짜 inclusive).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyReview {
    pub start: String,
    pub end: String,
    pub throughput: WeeklyThroughput,
    pub pr_activity: WeeklyPrActivity,
    pub routine_adherence: WeeklyRoutineAdherence,
    pub debt_trend: Vec<DebtPoint>,
}
