//! Workout 도메인 IPC 글루 (docs/plans/2026-07-26-recipe-authoring-workout.md §8).
//!
//! 계산은 전부 `crate::workout` 커널(결정론) — 여기는 검증 + SQL만. 로컬 SQLite 기록 전용
//! 도메인이라 외부 mutate가 없다(INVARIANT #2 비대상).
//!
//! **이 도메인은 계획을 소유하지 않는다.** "무엇을 언제 할 것인가"는 `routines`/Today가 이미
//! 관리하며, 여기에는 "무엇을 했다"와 체성분만 남는다. 계획 표면을 추가하면 두 곳에서 같은
//! 운동을 트래킹하게 된다.

#![allow(clippy::result_large_err)]

pub mod body;
pub mod exercises;
pub mod sessions;

pub use body::*;
pub use exercises::*;
pub use sessions::*;

use crate::error::AppError;

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

pub(crate) fn validate_date(raw: &str, code: &'static str) -> Result<String, AppError> {
    chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::validation(code, "date must be YYYY-MM-DD"))
        .map(|d| d.to_string())
}

/// 양수 검증 — 0/음수/NaN 모두 거부(스키마 CHECK 이전에 경계에서).
pub(crate) fn validate_positive(value: f64, code: &'static str) -> Result<(), AppError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(AppError::validation(code, "value must be > 0"));
    }
    Ok(())
}

pub(crate) fn validate_range(
    value: Option<i32>,
    lo: i32,
    hi: i32,
    code: &'static str,
) -> Result<(), AppError> {
    match value {
        Some(v) if v < lo || v > hi => Err(AppError::validation(
            code,
            format!("value must be between {lo} and {hi}"),
        )),
        _ => Ok(()),
    }
}

/// 검색 별칭 정규화 — food_aliases와 같은 규칙(lower + 공백 압축).
pub(crate) fn normalize_alias(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
