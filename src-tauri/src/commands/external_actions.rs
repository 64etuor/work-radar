//! External Action Gate IPC. 승인/거절/조회. Phase 0는 NoopConnector로 dispatch(외부 호출 0).

use crate::commands::approval_grant::HumanApproval;
use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::store::{self, PendingAction};
use crate::external_actions::{Acceptance, ExecOutcome, ExternalAction, ExternalConnector};
use tauri::State;

/// Phase 0 placeholder 커넥터 — 아무것도 안 함. Phase 2~5에서 kind별 실 커넥터로 교체.
struct NoopConnector;
impl ExternalConnector for NoopConnector {
    async fn execute(
        &self,
        _action: &ExternalAction,
        _gate: &Acceptance,
    ) -> Result<ExecOutcome, AppError> {
        Ok(ExecOutcome::default())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_pending_actions(db: State<'_, Db>) -> Result<Vec<PendingAction>, AppError> {
    store::list_pending(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn approve_external_action(
    db: State<'_, Db>,
    action_id: String,
) -> Result<String, AppError> {
    // 이 IPC가 사람 승인 경로 — 여기서만 HumanApproval을 발급해 store::approve에 넘긴다.
    store::approve(
        db.inner(),
        &action_id,
        &NoopConnector,
        &HumanApproval::from_ipc(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reject_external_action(db: State<'_, Db>, action_id: String) -> Result<(), AppError> {
    store::reject(db.inner(), &action_id, &HumanApproval::from_ipc()).await
}

#[tauri::command]
#[specta::specta]
pub async fn external_action_status(
    db: State<'_, Db>,
    action_id: String,
) -> Result<Option<String>, AppError> {
    store::status(db.inner(), &action_id).await
}
