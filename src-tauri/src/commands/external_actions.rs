//! External Action Gate IPC. 승인/거절/조회. 승인 시 `ExternalActionRouter`가 kind별 실 커넥터로
//! dispatch한다(Noop=외부 호출 0; 그 외 커넥터=Rust·action.project_ref로만 토큰 resolve·keychain·bounded retry).

use crate::calendar::{execute_calendar_action, HttpCalendarProvider};
use crate::commands::approval_grant::HumanApproval;
use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::store::{self, PendingAction};
use crate::external_actions::{Acceptance, ExecOutcome, ExternalAction, ExternalConnector};
use crate::github::{execute_github_action, github_provider_for_cref, HttpPrProvider};
use crate::notion::{execute_notion_action, notion_token_for_cref, HttpNotionWriter};
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
            ExternalAction::NotionCreatePage { .. } => {
                // GitHub과 동일 규율 — action의 project_ref(credential_ref)로만 Notion 토큰 resolve.
                let (writer, token) = self.notion_writer(gate.action_id()).await?;
                execute_notion_action(&writer, &token, action).await
            }
            ExternalAction::CalendarCreateEvent { .. } => {
                // 동일 규율 — action의 project_ref(credential_ref)로만 Calendar access token resolve.
                let access = self.calendar_access(gate.action_id()).await?;
                execute_calendar_action(&HttpCalendarProvider::new()?, &access, action).await
            }
        }
    }
}

impl ExternalActionRouter<'_> {
    /// 승인된 액션의 project_ref(=credential_ref)를 조회한다. **모든 커넥터(GitHub/Notion/Phase 4~5)의
    /// 공통 첫 단계** — 토큰을 그 프로젝트로만 resolve하기 위함(전역/주변 토큰 금지 = 개인/업무 격리).
    /// cref는 keychain account 참조일 뿐 토큰 본문이 아니다. 없으면 validation 에러(`no_project_ref`).
    async fn cref_for_action(&self, action_id: &str) -> Result<String, AppError> {
        store::project_ref_for(self.db, action_id)
            .await?
            .ok_or_else(|| {
                AppError::validation(
                    "external_action.no_project_ref",
                    "외부 액션에 대상 프로젝트(project_ref)가 없습니다",
                )
            })
    }

    /// action의 cref로 GitHub 토큰을 resolve해 writer를 만든다. cref→client 레시피는 `pr_radar`(read)와
    /// 공유하는 단일 `github_provider_for_cref`에 위임한다(#13). 토큰은 keychain에서만, 본문 미노출.
    async fn github_writer(&self, action_id: &str) -> Result<HttpPrProvider, AppError> {
        github_provider_for_cref(&self.cref_for_action(action_id).await?)
    }

    /// action의 cref로 Notion 토큰을 resolve해 (writer, token)을 만든다. GitHub과 비대칭:
    /// `HttpNotionWriter`는 토큰을 보유하지 않아 토큰을 별도로 들고 dispatch에 넘긴다. cref→token
    /// 레시피는 `notion::notion_token_for_cref`에 단일화한다. 토큰은 keychain에서만, 본문 미노출.
    async fn notion_writer(&self, action_id: &str) -> Result<(HttpNotionWriter, String), AppError> {
        let token = notion_token_for_cref(&self.cref_for_action(action_id).await?)?;
        Ok((HttpNotionWriter::new()?, token))
    }

    /// action의 cref로 Google Calendar access token을 resolve한다(refresh 재발급). cref→token 레시피는
    /// 기존 사람-폼 read/write 경로와 공유하는 단일 `calendar::access_token_for_cref`에 위임한다. 토큰은
    /// keychain에서만, 본문 미노출. 미연결(creds/refresh 없음)은 not_connected로 노출.
    async fn calendar_access(&self, action_id: &str) -> Result<String, AppError> {
        let cref = self.cref_for_action(action_id).await?;
        crate::commands::calendar::access_token_for_cref(&cref)
            .await
            .map_err(|e| AppError::terminal("calendar.access_token", e))?
            .ok_or_else(|| {
                AppError::not_found(
                    "calendar.not_connected",
                    "미연결 — 먼저 Google Calendar를 연결하세요",
                )
            })
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
