//! 외부 서비스 write 툴이 공유하는 라우팅 시임 — **proposal-only 계약의 단일 관문**.
//!
//! non-Hermes caller는 `store::enqueue_with_idempotency`(제안)만 탄다. Hermes caller는 이미 ACP
//! permission card로 사람 확인을 받았으므로 기존 Rust 커넥터를 직접 호출한다. 어느 경로도
//! `store::{approve,reject}`나 `Acceptance::mint`에 닿지 않는다(후자는 타입-월로 컴파일 차단).
//!
//! 로컬 SQLite write(신호 캡처/가계부/타임라인 노트 등)는 이 모듈을 거치지 않는다 — 외부 변경이
//! 아니므로 Acceptance 게이트 대상이 아니다(decision-rails INVARIANT #2).

use rmcp::handler::server::wrapper::Json;

use crate::calendar::{execute_calendar_action, HttpCalendarProvider};
use crate::commands::projects;
use crate::error::AppError;
use crate::external_actions::{store, ExecOutcome, ExternalAction};
use crate::github::{execute_github_action, github_provider_for_cref};
use crate::gmail::{execute_gmail_action, HttpGmailProvider};
use crate::mcp::tools::queue::ProposeResult;
use crate::mcp::{db_tool_error, mcp_tool_error, McpCaller, WrServer};
use crate::models::{Project, ProjectKind};
use crate::notion::{execute_notion_action, notion_token_for_cref, HttpNotionWriter};

/// 커넥터 실행 시임 — 테스트가 실 네트워크 없이 Hermes 직접 실행 경로를 검증하도록 분리한다.
#[allow(async_fn_in_trait)]
pub(crate) trait HermesMcpExecutor {
    async fn execute(
        &self,
        project: &Project,
        action: &ExternalAction,
    ) -> Result<ExecOutcome, AppError>;
}

pub(crate) struct LiveHermesMcpExecutor;

impl HermesMcpExecutor for LiveHermesMcpExecutor {
    async fn execute(
        &self,
        project: &Project,
        action: &ExternalAction,
    ) -> Result<ExecOutcome, AppError> {
        match action {
            ExternalAction::Noop { .. } => Ok(ExecOutcome::default()),
            ExternalAction::GithubIssueComment { .. }
            | ExternalAction::GithubCreateIssue { .. } => {
                let writer = github_provider_for_cref(&project.credential_ref)?;
                execute_github_action(&writer, action).await
            }
            ExternalAction::NotionCreatePage { .. } => {
                let token = notion_token_for_cref(&project.credential_ref)?;
                execute_notion_action(&HttpNotionWriter::new()?, &token, action).await
            }
            ExternalAction::CalendarCreateEvent { .. } => {
                let access =
                    crate::commands::calendar::access_token_for_cref(&project.credential_ref)
                        .await
                        .map_err(|e| AppError::terminal("calendar.access_token", e))?
                        .ok_or_else(|| {
                            AppError::not_found(
                                "calendar.not_connected",
                                "미연결 — 먼저 Google Calendar를 연결하세요",
                            )
                        })?;
                execute_calendar_action(&HttpCalendarProvider::new()?, &access, action).await
            }
            ExternalAction::GmailSendEmail { .. } => {
                let access = crate::gmail::access_token_for_cref(&project.credential_ref)
                    .await?
                    .ok_or_else(|| {
                        AppError::not_found(
                            "gmail.not_connected",
                            "Google 계정 미연결 — 먼저 Google 계정을 연결하세요(메일 발송 권한 포함)",
                        )
                    })?;
                execute_gmail_action(&HttpGmailProvider::new()?, &access, action).await
            }
        }
    }
}

impl WrServer {
    pub(crate) async fn route_write_for_caller<E: HermesMcpExecutor>(
        &self,
        tool: &str,
        project_id: &str,
        action: ExternalAction,
        op_summary: &str,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        if caller == McpCaller::Hermes {
            return self
                .execute_hermes_write(tool, project_id, action, executor)
                .await;
        }
        self.enqueue_write_proposal(project_id, action, op_summary)
            .await
    }

    /// Hermes-only direct write path. The human gate is Hermes' ACP permission card; this still
    /// resolves identity from the DB project row and tokens from keychain only.
    async fn execute_hermes_write<E: HermesMcpExecutor>(
        &self,
        tool: &str,
        project_id: &str,
        action: ExternalAction,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let project = projects::fetch_project(&self.db, project_id)
            .await
            .map_err(|e| mcp_tool_error(tool, &AppError::from(e)))?
            .ok_or_else(|| {
                rmcp::ErrorData::invalid_params(format!("unknown project_id: {project_id}"), None)
            })?;
        let outcome = executor
            .execute(&project, &action)
            .await
            .map_err(|e| mcp_tool_error(tool, &e))?;
        Ok(Json(ProposeResult {
            action_id: outcome.external_ref.unwrap_or_default(),
            status: "succeeded".into(),
        }))
    }

    /// 외부 write 제안의 공통 경로(서비스 무관 — GitHub/Notion/… 공유): project_id 검증(#11) →
    /// preview 합성(대상 identity 노출) → 안정 멱등 키로 enqueue. **실행하지 않는다**
    /// (store::enqueue_with_idempotency만 — 승인 후 Rust 커넥터가 실행).
    async fn enqueue_write_proposal(
        &self,
        project_id: &str,
        action: ExternalAction,
        op_summary: &str,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        // project_id가 실재하는지 검증해 credential_ref를 해석한다 — proposer가 준 raw project_ref/
        // credential_ref를 절대 신뢰하지 않는다(#11 auth-isolation injection을 구성적으로 차단).
        let project = projects::fetch_project(&self.db, project_id)
            .await
            .map_err(|e| db_tool_error("wr_write_proposal", &AppError::from(e)))?
            .ok_or_else(|| {
                rmcp::ErrorData::invalid_params(format!("unknown project_id: {project_id}"), None)
            })?;
        // 승인 패널 preview에 대상 프로젝트(개인/업무 + 이름)를 노출 = 어떤 identity가 행위할지 사람이
        // 보게 한다(#11 방어 심화). credential_ref/토큰은 절대 preview에 담지 않는다.
        let kind_label = match project.kind {
            ProjectKind::Personal => "개인",
            ProjectKind::Work => "업무",
        };
        let preview = format!("[{kind_label}: {}] {op_summary}", project.name);
        // 멱등 키는 제안 *내용*에서 파생한 안정값이어야 한다(시도별 UUID 금지 — dedup 무력화).
        let key = stable_idem_key(&action, project_id)
            .map_err(|e| db_tool_error("wr_write_proposal", &e))?;
        let id = store::enqueue_with_idempotency(
            &self.db,
            &action,
            Some(&project.credential_ref),
            Some(&preview),
            "mcp:client",
            Some(&key),
        )
        .await
        .map_err(|e| db_tool_error("wr_write_proposal", &e))?;
        Ok(Json(ProposeResult {
            action_id: id,
            status: "awaiting_approval".into(),
        }))
    }
}

/// 제안 *내용*에서 파생한 안정적 멱등 키 = sha256(project_id ‖ kind ‖ payload-json). 같은 외부 쓰기의
/// 재시도는 같은 키를 내 dedup된다(시도별 UUID면 dedup이 절대 안 걸림 — enqueue_with_idempotency 계약).
/// 직렬화 실패는 **에러로 전파**한다 — 빈 문자열 폴백은 서로 다른 액션의 키를 충돌시켜(무관 dedup) 위험.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(pr_radar/google_sync 등과 동일).
#[allow(clippy::result_large_err)]
fn stable_idem_key(action: &ExternalAction, project_id: &str) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(project_id.as_bytes());
    h.update([0u8]); // 필드 구분자(연접 모호성 방지).
    h.update(action.kind_str().as_bytes());
    h.update([0u8]);
    // payload JSON은 struct 정의 순서라 결정적 — 같은 내용 = 같은 직렬화 = 같은 키.
    let payload = serde_json::to_string(action)
        .map_err(|e| AppError::unexpected("external_action.serialize", e.to_string()))?;
    h.update(payload.as_bytes());
    Ok(format!("{:x}", h.finalize()))
}
