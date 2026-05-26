use serde::{Deserialize, Serialize};
use specta::Type;
// ── PR Radar (Phase 4, read 레일) ─────────────────────────────────────────────

/// PR의 CI 상태 (check-runs conclusion 집계). `None` = 체크 없음.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CiStatus {
    Passing,
    Failing,
    Pending,
    None,
}

/// readiness 버킷 (PR Radar 자기 뷰의 분류 — 매트릭스 결정 레일과 별개, INVARIANT #4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessBucket {
    NeedsSelfCheck,
    CiBlocked,
    Ready,
    MergedCleanup,
    Stale,
}

/// PR Radar 한 항목 (프런트 표시용). ambient 상태라 매 폴링마다 GitHub에서 새로 도출된다.
/// 토큰 본문은 절대 담기지 않는다(INVARIANT). specta i64/u64 export 금지 → number/ageDays는 u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrRadarItem {
    pub repo_full_name: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    pub author_login: String,
    pub bucket: ReadinessBucket,
    pub ci: CiStatus,
    pub has_conflict: bool,
    pub is_draft: bool,
    /// 수동 self-check 로컬 상태 (GitHub 아님).
    pub self_checked: bool,
    /// 경과일 (updated_at 기준, 0 = 오늘 갱신).
    pub age_days: u32,
    pub project_id: String,
    /// 댓글 수 (comments + review_comments). open PR만 채움, merged는 0.
    pub comment_count: u32,
    /// 댓글이 SUSPICIOUS_COMMENT_THRESHOLD 초과인지(시각 경고 힌트).
    pub is_suspicious: bool,
}
