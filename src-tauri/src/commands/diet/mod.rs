//! Diet 도메인 IPC 글루 (docs/plans/2026-07-17-diet-domain.md).
//!
//! 계산은 전부 `crate::diet` 커널(결정론) — 여기는 검증 + SQL + 스냅샷 기록만.
//! 로컬 SQLite 기록 전용 도메인: 외부 mutate 없음 → Acceptance 게이트 비대상(INVARIANT #2 예외).

// AppError는 레포 전역 IPC envelope — 크기 경고는 도메인별 allow가 관례(okr.rs 등 동일).
#![allow(clippy::result_large_err)]

pub mod cook;
pub mod foods;
pub mod goals;
pub mod logs;
pub mod orders;
pub mod pantry;
pub mod plans;
pub mod recipes;
pub mod shopping;

pub use cook::*;
pub use foods::*;
pub use goals::*;
pub use logs::*;
pub use orders::*;
pub use pantry::*;
pub use plans::*;
pub use recipes::*;
pub use shopping::*;

use crate::error::AppError;

/// 32자 lower-hex id — SQL `lower(hex(randomblob(16)))` 선례와 동일 모양(멀티-insert에서
/// Rust가 id를 미리 알아야 해서 앱 쪽에서 생성).
pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(crate) fn clean_required(
    raw: &str,
    code: &'static str,
    label: &'static str,
) -> Result<String, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::validation(code, format!("{label} is required")));
    }
    Ok(value.to_string())
}

pub(crate) fn clean_optional(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub(crate) fn validate_date(raw: &str, code: &'static str) -> Result<chrono::NaiveDate, AppError> {
    chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::validation(code, "date must be YYYY-MM-DD"))
}

/// 1..=5 점수(만족도/포만감) 검증 — DB CHECK와 동일 규칙을 경계에서 먼저 잡는다.
pub(crate) fn validate_score(
    value: Option<i32>,
    code: &'static str,
) -> Result<Option<i32>, AppError> {
    match value {
        Some(v) if !(1..=5).contains(&v) => {
            Err(AppError::validation(code, "score must be between 1 and 5"))
        }
        other => Ok(other),
    }
}

/// 유한 양수 수량 검증(NaN/inf/0 이하 거부 — SQLite CHECK는 NaN을 못 걸러낸다).
pub(crate) fn validate_positive(value: f64, code: &'static str) -> Result<f64, AppError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(AppError::validation(
            code,
            "value must be a positive number",
        ));
    }
    Ok(value)
}

pub(crate) fn validate_non_negative(value: f64, code: &'static str) -> Result<f64, AppError> {
    if !value.is_finite() || value < 0.0 {
        return Err(AppError::validation(
            code,
            "value must be a non-negative number",
        ));
    }
    Ok(value)
}
