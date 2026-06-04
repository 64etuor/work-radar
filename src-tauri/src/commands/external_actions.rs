//! External Action Gate IPC. 승인/거절/조회. 승인 시 `ExternalActionRouter`가 kind별 실 커넥터로
//! dispatch한다(Noop=외부 호출 0, GitHub=Rust 커넥터·keychain·bounded retry).

use crate::commands::approval_grant::HumanApproval;
use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::store::{self, PendingAction};
use crate::external_actions::{Acceptance, ExecOutcome, ExternalAction, ExternalConnector};
use crate::github::{execute_github_action, github_provider_for_cref, HttpPrProvider};
use tauri::State;

/// 승인된 액션을 kind별 실 커넥터로 dispatch하는 실행 seam. **Phase 2~5 커넥터는 여기 match에
/// arm 한 개씩만 추가**한다(병렬 작업의 공유 충돌점을 이 한 곳으로 모음). 토큰은 항상 **action의
/// project_ref(=credential_ref)로만** resolve한다(전역/주변 토큰 금지) — 개인/업무 프로필 격리.
struct ExternalActionRouter<'a> {
    db: &'a Db,
}

impl ExternalConnector for ExternalActionRouter<'_> {
    async fn execute(
        &self,
        action: &ExternalAction,
        gate: &Acceptance,
    ) -> Result<ExecOutcome, AppError> {
        match action {
            ExternalAction::Noop { .. } => Ok(ExecOutcome::default()),
            ExternalAction::GithubIssueComment { .. }
            | ExternalAction::GithubCreateIssue { .. } => {
                // gate.action_id()로 그 액션의 project_ref를 찾아 그 프로젝트 토큰으로만 실행.
                let writer = self.github_writer(gate.action_id()).await?;
                execute_github_action(&writer, action).await
            }
        }
    }
}

impl ExternalActionRouter<'_> {
    /// action의 project_ref(credential_ref)로 GitHub 토큰을 resolve해 writer를 만든다.
    /// 토큰은 keychain에서만 읽고 본문은 노출하지 않는다(렌더러/로그 금지). cref→client 레시피는
    /// `pr_radar`(read)와 공유하는 단일 `github_provider_for_cref`에 위임한다(#13).
    async fn github_writer(&self, action_id: &str) -> Result<HttpPrProvider, AppError> {
        let cref = store::project_ref_for(self.db, action_id)
            .await?
            .ok_or_else(|| {
                AppError::validation(
                    "external_action.no_project_ref",
                    "GitHub 액션에 대상 프로젝트(project_ref)가 없습니다",
                )
            })?;
        github_provider_for_cref(&cref)
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
    // 라우터가 action.kind→실 커넥터로 dispatch(토큰은 action의 project_ref로만 resolve).
    let router = ExternalActionRouter { db: db.inner() };
    store::approve(db.inner(), &action_id, &router, &HumanApproval::from_ipc()).await
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
