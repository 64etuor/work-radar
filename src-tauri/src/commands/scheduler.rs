//! 스케줄러 검증/제어 커맨드 (Phase 13). 알림 권한 상태 조회 + 테스트 알림 예약.
//! INVARIANT #7: 예약 상태는 로컬 SQLite SSOT(`scheduled_notifications`). 스파인이 bounded
//! tick으로 발사한다(scheduler.rs). 여기선 행 INSERT/권한 조회만 — 발사는 스케줄러가 한다.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::db::Db;
use crate::scheduler::utc_now_string;

/// 알림 권한 상태(프런트 표시용 문자열 + bool). PermissionState를 직접 노출하지 않고
/// 안정적인 직렬화 형태로 매핑한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPermission {
    /// "granted" | "denied" | "prompt" | "unknown".
    pub state: String,
    /// 발사 가능 여부(granted일 때만 true).
    pub granted: bool,
}

fn map_state(s: PermissionState) -> NotificationPermission {
    let (state, granted) = match s {
        PermissionState::Granted => ("granted", true),
        PermissionState::Denied => ("denied", false),
        PermissionState::Prompt => ("prompt", false),
        PermissionState::PromptWithRationale => ("prompt", false),
    };
    NotificationPermission {
        state: state.to_string(),
        granted,
    }
}

/// 현재 알림 권한 상태 조회. 미지원/오류면 unknown으로 graceful degrade(앱 코어 무영향).
#[tauri::command]
#[specta::specta]
pub async fn notification_permission(app: AppHandle) -> Result<NotificationPermission, String> {
    match app.notification().permission_state() {
        Ok(s) => Ok(map_state(s)),
        Err(_) => Ok(NotificationPermission {
            state: "unknown".into(),
            granted: false,
        }),
    }
}

/// 알림 권한 요청(미결정일 때 OS 프롬프트). 결과 상태를 돌려준다. 거부돼도 앱은 계속 동작.
#[tauri::command]
#[specta::specta]
pub async fn request_notification_permission(
    app: AppHandle,
) -> Result<NotificationPermission, String> {
    match app.notification().request_permission() {
        Ok(s) => Ok(map_state(s)),
        Err(e) => Err(e.to_string()),
    }
}

/// `seconds_from_now` 뒤에 발사될 테스트 알림 행을 INSERT한다(스파인 시연용).
/// 발사는 백그라운드 스케줄러가 bounded tick에서 수행한다 — 여기선 큐에 넣기만 한다.
/// source='test'로 태깅(Phase 16/20과 동일한 제네릭 경로).
#[tauri::command]
#[specta::specta]
pub async fn schedule_test_notification(
    db: State<'_, Db>,
    seconds_from_now: i32,
) -> Result<(), String> {
    let secs = seconds_from_now.max(0) as i64;
    let now = utc_now_string();
    sqlx::query(
        "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id) \
         VALUES (lower(hex(randomblob(16))), datetime(?1, '+' || ?2 || ' seconds'), \
                 'Work Radar 테스트 알림', '백그라운드 스케줄러 스파인이 동작합니다.', 'test', NULL)",
    )
    .bind(&now)
    .bind(secs)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
