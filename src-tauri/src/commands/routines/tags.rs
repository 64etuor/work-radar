//! 루틴 인라인 태그 갱신 — kind 및 Life Wheel area tag key (signals 패턴 미러).
//!
//! - `set_routine_kind`: personal/work 토글(즉시 저장).
//! - `set_routine_area_tag_key`: builtin AreaTag 키는 primary `area`도 동기화, 커스텀 키는
//!   `area_tags` JSON에만 보존하고 `area`는 NULL.
//!
//! 반환은 `()`. RoutineToday의 done/time_override 등은 날짜 의존이라 FE가 list 재조회한다.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{AreaTag, Kind};

/// kind 즉시 갱신(personal/work). signals.set_signal_kind와 동일 의미.
#[tauri::command]
#[specta::specta]
pub async fn set_routine_kind(
    db: State<'_, Db>,
    id: String,
    kind: Option<Kind>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE routines SET kind = ?2 WHERE id = ?1")
        .bind(&id)
        .bind(kind)
        .execute(db.inner())
        .await
        .map_err(AppError::from)?;
    Ok(())
}

/// Life Wheel 수동 선택. signal과 동일 의미: builtin AreaTag면 primary `area`도 갱신,
/// 커스텀 tag key면 `area=NULL` + `area_tags=["key"]`만 저장. tag_key=None이면 둘 다 NULL.
#[tauri::command]
#[specta::specta]
pub async fn set_routine_area_tag_key(
    db: State<'_, Db>,
    id: String,
    tag_key: Option<String>,
) -> Result<(), AppError> {
    let normalized = tag_key.and_then(|key| {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let primary = normalized.as_deref().and_then(AreaTag::from_key);
    let json = normalized.as_deref().map(|key| {
        let escaped = key.replace('\\', "\\\\").replace('"', "\\\"");
        format!(r#"["{escaped}"]"#)
    });
    sqlx::query("UPDATE routines SET area = ?2, area_tags = ?3 WHERE id = ?1")
        .bind(&id)
        .bind(primary)
        .bind(json)
        .execute(db.inner())
        .await
        .map_err(AppError::from)?;
    Ok(())
}

