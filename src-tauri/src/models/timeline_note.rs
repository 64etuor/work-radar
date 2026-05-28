//! Timeline 메모 — Today 타임라인 블록(signal/routine/event)에 붙는 사용자 메모.
//! target_kind는 닫힌 enum(SQL CHECK과 동기) — DB drift 0(INVARIANT 7).

use serde::{Deserialize, Serialize};
use specta::Type;

/// 메모 대상 종류. timeline_notes.target_kind CHECK과 동일.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum TimelineNoteTarget {
    Signal,
    Routine,
    Event,
}

/// timeline_notes 한 행. body는 사용자 입력(공백 trim은 IPC 경계에서).
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TimelineNote {
    pub target_kind: TimelineNoteTarget,
    pub target_id: String,
    /// 로컬 'YYYY-MM-DD'.
    pub date: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}
