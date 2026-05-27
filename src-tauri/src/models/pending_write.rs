//! Pending calendar writes 큐 row 모델 (Today×Timeline PR 2).
//! UI/IPC가 큐 상태를 관찰할 때 쓰는 DTO. INVARIANT: 토큰 없음(이 큐는 외부 mutate 의도일 뿐).
//!
//! 페이로드/스키마는 마이그레이션 `0032_pending_calendar_writes.sql` 참조.

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::FromRow;

/// pending_calendar_writes 행. payload_json은 op별 자유 형태(create=title/start/duration_min,
/// patch=start/duration_min, delete={}; staged=true는 워커가 skip — cross-cal Acceptance 게이트).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, Type)]
pub struct PendingWrite {
    pub id: i32,
    /// create | patch | delete.
    pub kind: String,
    /// signal | routine_check.
    pub target_kind: String,
    /// signal id, 또는 `routine_id|date`(routine_check).
    pub target_id: String,
    pub calendar_id: String,
    pub event_id: Option<String>,
    pub payload_json: String,
    pub attempts: i32,
    pub next_attempt_at: String,
    pub last_error: Option<String>,
    pub created_at: String,
}
