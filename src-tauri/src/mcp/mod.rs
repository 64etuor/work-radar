//! work-radar 앱 내장 stdio MCP 서버(External Action Gate Phase 1, **proposal-only by default**).
//!
//! 외부 AI 에이전트(Claude Code / Codex / Hermes)가 `work-radar --mcp-stdio`로 spawn해 등록한다.
//! - read 툴  = DB 조회(메타만 — 토큰/payload 본문 미노출).
//! - write tool = 기본적으로 `store::enqueue`만 호출(제안 생성). 커넥터 `execute`/`Acceptance::mint`
//!   경로 **없음** — 모듈 경계 + Task 1.0 토큰 type-wall(`pub(in crate::external_actions)`)로 컴파일 강제.
//! - 예외: work-radar Hermes가 ACP `session/request_permission`으로 먼저 사용자 확인을 받은 뒤 호출하는
//!   write tool은 `WORK_RADAR_MCP_CALLER=hermes`일 때 Work Radar 승인 큐를 한 번 더 거치지 않고 실행한다.
//!
//! non-Hermes 승인/실행은 work-radar GUI(같은 DB의 승인 패널)와 Rust 커넥터(Phase 2~5)가 담당한다.
//! Hermes-marked MCP 경로만 Hermes permission card 이후 기존 Rust 커넥터를 직접 호출한다.

pub mod run;

use crate::calendar::{execute_calendar_action, HttpCalendarProvider};
use crate::commands::bookkeeping as bookkeeping_commands;
use crate::commands::projects;
use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::{store, ExecOutcome, ExternalAction};
use crate::github::{execute_github_action, github_provider_for_cref};
use crate::gmail::{execute_gmail_action, HttpGmailProvider};
use crate::models::{
    BookkeepingDirection, BookkeepingExpenseKind, BookkeepingPaymentMethodKind, BookkeepingSource,
    CreateBookkeepingLineItemInput, CreateBookkeepingTransactionInput, Project, ProjectKind,
    SetBookkeepingLineItemsInput,
};
use crate::notion::{execute_notion_action, notion_token_for_cref, HttpNotionWriter};
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// MCP 서버 상태 — 앱과 동일한 SQLite 풀을 보유(별도 DB 아님).
#[derive(Clone)]
pub struct WrServer {
    pub db: Db,
}

/// 승인 대기 액션 1건(메타만). payload/result/토큰은 노출하지 않는다.
#[derive(Serialize, JsonSchema)]
pub struct PendingActionDto {
    pub id: String,
    pub kind: String,
    pub origin: String,
    pub status: String,
}

/// `wr_list_pending_actions` 반환 — 승인 대기 큐(메타 목록). `total`/`truncated`로 상한(LIMIT) 절단을
/// **명시 신호**한다(#7): FIFO 정렬이라 절단되는 건 가장 최근 제안이므로, 폴링 에이전트가 `truncated`로
/// "더 있음"을 알고 처리/재조회할 수 있다(무신호 truncation 방지).
#[derive(Serialize, JsonSchema)]
pub struct PendingList {
    pub actions: Vec<PendingActionDto>,
    /// 상한 적용 전 전체 대기 건수.
    pub total: u32,
    /// `actions`가 상한에 잘렸는지(`total > actions.len()`).
    pub truncated: bool,
}

/// 프로젝트 1건(메타만 — credential_ref/토큰 미노출). write 툴이 어떤 project_id로 행위할지 고를 때 쓴다.
#[derive(Serialize, JsonSchema)]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    /// "personal" | "work" — 개인/업무 identity 구분(승인 패널과 동일 라벨 기반).
    pub kind: String,
}

/// `wr_list_projects` 반환 — 프로젝트 목록(메타만).
#[derive(Serialize, JsonSchema)]
pub struct ProjectList {
    pub projects: Vec<ProjectDto>,
}

/// GitHub 코멘트 제안 파라미터(`wr_github_comment`). proposer는 **project_id만** 준다 — 서버가
/// 실재성을 검증해 credential_ref를 해석한다(#11: raw project_ref/credential_ref 신뢰 금지).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct GithubCommentParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// "owner/repo".
    pub repo: String,
    /// 이슈/PR 번호.
    pub issue_number: u64,
    /// 코멘트 본문.
    pub body: String,
}

/// GitHub 이슈 생성 제안 파라미터(`wr_github_create_issue`). project_id만 받아 서버가 검증한다(#11).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct GithubCreateIssueParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회).
    pub project_id: String,
    /// "owner/repo".
    pub repo: String,
    /// 이슈 제목.
    pub title: String,
    /// 이슈 본문.
    pub body: String,
}

/// Notion 페이지 생성 제안 파라미터(`wr_notion_create_page`). project_id만 받아 서버가 검증한다(#11).
/// db_id는 원시 ID/URL을 허용한다 — 커넥터가 정규화한다(repo와 동일하게 *내용*이지 자격증명 아님).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct NotionCreatePageParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// 대상 Notion 데이터베이스 ID 또는 공유 URL(커넥터가 dashed UUID로 정규화).
    pub db_id: String,
    /// 페이지 제목.
    pub title: String,
}

/// Google Calendar 이벤트 생성 제안 파라미터(`wr_calendar_create_event`). project_id만 받아 서버가 검증한다(#11).
/// start/end는 RFC3339(timed) 또는 YYYY-MM-DD(all_day) — *내용*이지 자격증명 아님(커넥터가 해석).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct CalendarCreateEventParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// 대상 캘린더 ID.
    pub calendar_id: String,
    /// 이벤트 제목.
    pub title: String,
    /// 시작 시각: RFC3339(timed) 또는 YYYY-MM-DD(all_day).
    pub start: String,
    /// 종료 시각: RFC3339(timed) 또는 YYYY-MM-DD(all_day).
    pub end: String,
    /// 종일 이벤트 여부.
    pub all_day: bool,
    /// 이벤트 설명(선택).
    pub description: Option<String>,
}

/// Gmail 발송 제안 파라미터(`wr_gmail_send`). project_id만 받아 서버가 검증한다(#11).
/// to/subject/body는 발송 *내용* — 자격증명 아님(승인 후 keychain 토큰으로 Rust가 실행).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct GmailSendParams {
    /// 대상 프로젝트 id(`wr_list_projects`로 조회). 토큰 격리/identity 결정의 단일 입력.
    pub project_id: String,
    /// 수신자 이메일 주소.
    pub to: String,
    /// 메일 제목.
    pub subject: String,
    /// 메일 본문(빈 본문도 유효 — 비어있음 검증 없음).
    pub body: String,
}

/// One receipt line item (`wr_bookkeeping_save_receipt`). Closed schema — deny_unknown_fields does
/// not inherit to nested structs. amount_minor is the per-line minor-unit amount; quantity defaults 1.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingLineItemParam {
    pub name: String,
    pub amount_minor: i32,
    pub quantity: Option<i32>,
    pub category_code: Option<String>,
}

/// One review reason emitted by the CFO judgment (`wr_bookkeeping_save_receipt`). Closed schema so a
/// future caller cannot smuggle extra fields.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingReviewReasonParam {
    /// Stable machine code, e.g. "low_confidence", "line_item_sum_mismatch", "possible_duplicate".
    pub code: String,
    /// Optional short human detail (sanitized — no raw email body / image / PII).
    pub detail: Option<String>,
}

/// Hermes-confirmed receipt/transaction save params(`wr_bookkeeping_save_receipt`). This local DB
/// write accepts normalized + judged fields only; raw images, file paths, email bodies, and
/// credentials are intentionally not part of the tool schema. New judgment fields are all OPTIONAL so
/// an in-field Hermes sending the original field set keeps validating (additive-optional widening).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingSaveReceiptParams {
    /// Optional project id(`wr_list_projects`로 조회). If present, the server validates it.
    pub project_id: Option<String>,
    /// Stable OCR/receipt id from Hermes, if available. Used for local dedup.
    pub source_ref: Option<String>,
    /// Normalized merchant name.
    pub merchant: String,
    /// Minor-unit amount (always positive; sign is carried by `direction`). For KRW this is won.
    pub amount_minor: i32,
    /// ISO 4217 currency. Defaults to KRW.
    pub currency: Option<String>,
    /// Purchase date in YYYY-MM-DD.
    pub spent_at: String,
    /// Optional category. Defaults to uncategorized.
    pub category: Option<String>,
    /// Short receipt description.
    pub description: Option<String>,
    /// Optional user-facing note.
    pub note: Option<String>,
    /// "expense" | "income". Defaults to expense; any other value is rejected.
    pub direction: Option<String>,
    /// Source asset/account name (e.g. "하나은행").
    pub account: Option<String>,
    /// Human-readable subcategory label.
    pub subcategory: Option<String>,
    /// Resolved taxonomy category code (server also resolves from raw_category when omitted).
    pub category_code: Option<String>,
    /// Resolved taxonomy subcategory code.
    pub subcategory_code: Option<String>,
    /// Original incoming category label to preserve (e.g. "🪑 생활용품").
    pub raw_category: Option<String>,
    /// Time-of-day HH:MM:SS for the purchase (date stays in `spent_at`).
    pub spent_at_time: Option<String>,
    /// Overall judgment confidence 0..1.
    pub confidence: Option<f64>,
    /// Per-field confidence map, e.g. {"amount":0.99,"merchant":0.7}.
    pub field_confidence: Option<std::collections::BTreeMap<String, f64>>,
    /// Why this row needs review (low confidence, duplicate suspicion, sum mismatch, …).
    pub review_reasons: Option<Vec<BookkeepingReviewReasonParam>>,
    /// Order number from the receipt — strong dedup key.
    pub order_no: Option<String>,
    /// Payment/approval number — strong dedup key.
    pub payment_no: Option<String>,
    /// Optional itemized breakdown. A sum mismatch vs `amount_minor` becomes a review reason.
    pub line_items: Option<Vec<BookkeepingLineItemParam>>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingSaveReceiptResult {
    pub transaction_id: String,
    pub status: String,
}

// ── Bookkeeping READ tools (Phase F2, Hermes-gated) ─────────────────────────────────────────────
// Lean DTOs only — sanitized financial metadata, never raw email bodies / tokens / full internal
// rows (mcp-server-conventions §6/§7 least-privilege read surface).

/// Sanitized transaction row for the CFO bot. No raw source body; review reasons are codes only.
#[derive(Serialize, JsonSchema)]
pub struct BookkeepingTransactionDto {
    pub id: String,
    pub merchant: String,
    pub amount_minor: i32,
    pub currency: String,
    pub direction: String,
    pub spent_at: String,
    /// HH:MM:SS(있으면) — 원장 UI의 시각 셀과 동일 필드.
    pub spent_at_time: Option<String>,
    pub category: String,
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    /// 사용자 메모(DB `note`; .mmbak ZDATA 유입처, 원장 UI의 "내용" 칼럼). 소스 원문
    /// `description`은 메일 본문 유래일 수 있어 의도적으로 미노출(sanitized-surface 계약 유지).
    pub note: Option<String>,
    pub account: Option<String>,
    pub payment_method_kind: String,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: String,
    pub review_status: String,
    pub confidence: Option<f64>,
    /// Review-reason codes only (not free-text details).
    pub review_reason_codes: Vec<String>,
    pub source: String,
    pub source_ref: Option<String>,
    pub order_no: Option<String>,
    pub payment_no: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingMonthlySummaryDto {
    pub month: String,
    pub total_expense_minor: i32,
    pub total_income_minor: i32,
    pub net_minor: i32,
    pub needs_review_count: u32,
    pub approved_count: u32,
    pub ignored_count: u32,
    pub duplicate_count: u32,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingDuplicateCandidateDto {
    pub transaction_id: String,
    pub merchant: String,
    pub amount_minor: i32,
    pub spent_at: String,
    pub score: f64,
    pub reasons: Vec<String>,
}

// MCP requires tool outputSchema root type 'object', so list results are wrapped (not bare arrays).
#[derive(Serialize, JsonSchema)]
pub struct BookkeepingTransactionListDto {
    pub transactions: Vec<BookkeepingTransactionDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingDuplicateCandidateListDto {
    pub candidates: Vec<BookkeepingDuplicateCandidateDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingCategoryNodeDto {
    pub code: String,
    pub parent_code: Option<String>,
    pub label: String,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingCategoryAliasDto {
    pub pattern: String,
    pub match_kind: String,
    pub category_code: String,
    pub subcategory_code: Option<String>,
    pub confidence: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingCategoryRulesDto {
    pub taxonomy: Vec<BookkeepingCategoryNodeDto>,
    pub aliases: Vec<BookkeepingCategoryAliasDto>,
}

/// `wr_bookkeeping_list_review_queue` / `..._list_recent_transactions` params.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingListParams {
    pub project_id: Option<String>,
    /// Result cap (server clamps to 1..=100; default 25).
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingMonthlySummaryParams {
    /// YYYY-MM.
    pub month: String,
    pub project_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingFindDuplicateParams {
    pub project_id: Option<String>,
    /// Purchase date YYYY-MM-DD.
    pub spent_at: String,
    pub amount_minor: i32,
    pub merchant: Option<String>,
    pub order_no: Option<String>,
    pub payment_no: Option<String>,
    pub source_ref: Option<String>,
    /// Exclude this already-saved transaction id from candidates.
    pub exclude_transaction_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingMarkDuplicateParams {
    pub transaction_id: String,
    pub duplicate_of_transaction_id: String,
}

/// 제안 생성 파라미터(`wr_propose_noop`). preview=승인 패널 표시용 사람-친화 요약.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct ProposeNoopParams {
    /// 사람-친화 미리보기(승인 패널 표시용).
    pub preview: String,
    /// 임의 메모(Noop payload).
    pub note: String,
}

/// 제안 생성 결과 — action_id + 초기 상태(awaiting_approval). **실행 안 함**.
#[derive(Serialize, JsonSchema)]
pub struct ProposeResult {
    pub action_id: String,
    pub status: String,
}

/// 단건 상태 조회 파라미터(`wr_action_status`).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct ActionIdParams {
    pub action_id: String,
}

/// 단건 상태 조회 결과. 없으면 status=None.
#[derive(Serialize, JsonSchema)]
pub struct ActionStatus {
    pub status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpCaller {
    Hermes,
    Other,
}

fn mcp_caller_from_env() -> McpCaller {
    match std::env::var("WORK_RADAR_MCP_CALLER") {
        Ok(v) if v.trim().eq_ignore_ascii_case("hermes") => McpCaller::Hermes,
        _ => McpCaller::Other,
    }
}

/// Bookkeeping tools (read + the local mark-duplicate write) are gated to the Work Radar Hermes
/// caller — the user's private finances are not exposed to other MCP callers (mcp-server-conventions
/// "좁은 예외" + §7 least-privilege).
fn require_hermes(caller: McpCaller, tool: &str) -> Result<(), rmcp::ErrorData> {
    if caller != McpCaller::Hermes {
        return Err(rmcp::ErrorData::invalid_params(
            format!("{tool} requires the Work Radar Hermes MCP caller"),
            None,
        ));
    }
    Ok(())
}

/// Serialize a closed serde enum to its wire string (e.g. BookkeepingDirection → "expense").
fn enum_wire_string<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn review_reason_codes(review_reasons_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(review_reasons_json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.get("code").and_then(|c| c.as_str()).map(str::to_string))
        .collect()
}

fn to_transaction_dto(t: crate::models::BookkeepingTransaction) -> BookkeepingTransactionDto {
    let review_reason_codes = review_reason_codes(&t.review_reasons_json);
    BookkeepingTransactionDto {
        id: t.id,
        merchant: t.merchant,
        amount_minor: t.amount_minor,
        currency: t.currency,
        direction: enum_wire_string(&t.direction),
        spent_at: t.spent_at,
        spent_at_time: t.spent_at_time,
        category: t.category,
        category_code: t.category_code,
        subcategory_code: t.subcategory_code,
        note: t.note,
        account: t.account,
        payment_method_kind: enum_wire_string(&t.payment_method_kind),
        payment_method_label: t.payment_method_label,
        payment_method_last4: t.payment_method_last4,
        expense_kind: enum_wire_string(&t.expense_kind),
        review_status: enum_wire_string(&t.review_status),
        confidence: t.confidence,
        review_reason_codes,
        source: enum_wire_string(&t.source),
        source_ref: t.source_ref,
        order_no: t.order_no,
        payment_no: t.payment_no,
    }
}

#[allow(async_fn_in_trait)]
trait HermesMcpExecutor {
    async fn execute(
        &self,
        project: &Project,
        action: &ExternalAction,
    ) -> Result<ExecOutcome, AppError>;
}

struct LiveHermesMcpExecutor;

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

#[tool_router(server_handler)]
impl WrServer {
    /// 승인 대기 외부 액션 목록(메타만). 토큰/payload 본문 미노출.
    /// DB 에러는 **빈 목록으로 삼키지 않고** rmcp internal-error로 surface한다 — 폴링하는
    /// 에이전트가 "실패"와 "비어 있음"을 구분할 수 있게(읽기 툴 비대칭 수정). 패닉은 여전히 금지.
    /// surface/로그는 PII-free하게 AppError.code만 쓴다(message/payload 본문 금지).
    #[tool(
        name = "wr_list_pending_actions",
        description = "List external actions awaiting user approval (metadata only). Does NOT expose payloads or tokens."
    )]
    pub async fn list_pending_actions(&self) -> Result<Json<PendingList>, rmcp::ErrorData> {
        let (rows, total) = store::list_pending_with_total(&self.db)
            .await
            .map_err(|e| db_tool_error("wr_list_pending_actions", &e))?;
        let truncated = total as usize > rows.len();
        Ok(Json(PendingList {
            actions: rows
                .into_iter()
                .map(|a| PendingActionDto {
                    id: a.id,
                    kind: a.kind,
                    origin: a.origin,
                    status: a.status,
                })
                .collect(),
            total,
            truncated,
        }))
    }

    /// 프로젝트 목록(메타만 — credential_ref/토큰 미노출). write 툴이 어떤 identity(project_id)로
    /// 행위할지 고를 때 쓴다. DB 에러는 빈 목록으로 삼키지 않고 rmcp internal-error로 surface한다.
    #[tool(
        name = "wr_list_projects",
        description = "List projects (id, name, kind) to choose a target for write tools. Does NOT expose credentials or tokens."
    )]
    pub async fn list_projects(&self) -> Result<Json<ProjectList>, rmcp::ErrorData> {
        let rows = projects::fetch_projects(&self.db)
            .await
            .map_err(|e| db_tool_error("wr_list_projects", &AppError::from(e)))?;
        Ok(Json(ProjectList {
            projects: rows
                .into_iter()
                .map(|p| ProjectDto {
                    id: p.id,
                    name: p.name,
                    kind: project_kind_str(p.kind).to_string(),
                })
                .collect(),
        }))
    }

    /// GitHub 이슈/PR 코멘트. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는
    /// Hermes permission card를 사람 게이트로 간주해 기존 Rust connector로 직접 실행한다.
    /// project_id를 검증해 credential_ref를 해석한다(#11).
    #[tool(
        name = "wr_github_comment",
        description = "Create a GitHub issue/PR comment when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated."
    )]
    pub async fn github_comment(
        &self,
        Parameters(p): Parameters<GithubCommentParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.github_comment_for_caller_with_executor(
            p,
            mcp_caller_from_env(),
            &LiveHermesMcpExecutor,
        )
        .await
    }

    async fn github_comment_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: GithubCommentParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("GitHub {}#{} 코멘트", p.repo, p.issue_number);
        let action = ExternalAction::GithubIssueComment {
            repo: p.repo,
            issue_number: p.issue_number,
            body: p.body,
        };
        self.route_write_for_caller(
            "wr_github_comment",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }

    /// GitHub 이슈 생성. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는 직접 실행한다.
    /// project_id를 검증해 credential_ref를 해석한다(#11).
    #[tool(
        name = "wr_github_create_issue",
        description = "Create a GitHub issue when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated."
    )]
    pub async fn github_create_issue(
        &self,
        Parameters(p): Parameters<GithubCreateIssueParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.github_create_issue_for_caller_with_executor(
            p,
            mcp_caller_from_env(),
            &LiveHermesMcpExecutor,
        )
        .await
    }

    async fn github_create_issue_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: GithubCreateIssueParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("GitHub {} 이슈 생성: {}", p.repo, p.title);
        let action = ExternalAction::GithubCreateIssue {
            repo: p.repo,
            title: p.title,
            body: p.body,
        };
        self.route_write_for_caller(
            "wr_github_create_issue",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }

    /// Notion DB 페이지 생성. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는
    /// 직접 실행한다. project_id를 검증해 credential_ref를 해석한다(#11). 사람-origin 카드 승격(앱 내부)과는
    /// 별개 경로다(spec §4 이중 경로 — 이건 외부 에이전트 제안용).
    #[tool(
        name = "wr_notion_create_page",
        description = "Create a Notion page when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated; db_id accepts a raw ID or share URL."
    )]
    pub async fn notion_create_page(
        &self,
        Parameters(p): Parameters<NotionCreatePageParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.notion_create_page_for_caller_with_executor(
            p,
            mcp_caller_from_env(),
            &LiveHermesMcpExecutor,
        )
        .await
    }

    async fn notion_create_page_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: NotionCreatePageParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("Notion 페이지 생성: {}", p.title);
        let action = ExternalAction::NotionCreatePage {
            db_id: p.db_id,
            title: p.title,
        };
        self.route_write_for_caller(
            "wr_notion_create_page",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }

    /// Google Calendar 이벤트 생성을 기본적으로 **제안만** 한다 — 실행 안 함(사용자 승인 후 Rust
    /// 커넥터가 실행). 예외: work-radar Hermes가 ACP permission card로 이미 사용자 확인을 받은
    /// 세션(`WORK_RADAR_MCP_CALLER=hermes`)에서는 즉시 생성한다. project_id를 검증해 credential_ref를
    /// 해석하고(#11), proposal 경로는 안정 멱등 키로 enqueue한다.
    #[tool(
        name = "wr_calendar_create_event",
        description = "Create a Google Calendar event only when called by work-radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated; start/end accept RFC3339 or YYYY-MM-DD for all-day."
    )]
    pub async fn calendar_create_event(
        &self,
        Parameters(p): Parameters<CalendarCreateEventParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.calendar_create_event_for_caller(p, mcp_caller_from_env())
            .await
    }

    async fn calendar_create_event_for_caller(
        &self,
        p: CalendarCreateEventParams,
        caller: McpCaller,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.calendar_create_event_for_caller_with_executor(p, caller, &LiveHermesMcpExecutor)
            .await
    }

    async fn calendar_create_event_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: CalendarCreateEventParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("Calendar 이벤트 생성: {}", p.title);
        let action = ExternalAction::CalendarCreateEvent {
            calendar_id: p.calendar_id,
            title: p.title,
            start: p.start,
            end: p.end,
            all_day: p.all_day,
            description: p.description,
        };
        self.route_write_for_caller(
            "wr_calendar_create_event",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }

    /// Gmail 발송. non-Hermes는 approval proposal만 만들고, Hermes-marked MCP caller는 직접 실행한다.
    /// project_id를 검증해 credential_ref를 해석한다(#11).
    /// C1: op_summary에 수신자+제목을 담아 승인 패널 preview가 정확한 대상을 사람에게 노출한다
    /// (chain-of-custody #2/#5). 수신자는 preview 컬럼에만 — audit detail(ref=…,bytes=…)에는 안 담긴다(US-004).
    #[tool(
        name = "wr_gmail_send",
        description = "Send a Gmail message when called by Work Radar Hermes after its permission card; otherwise propose it for Work Radar approval. project_id is validated."
    )]
    pub async fn gmail_send(
        &self,
        Parameters(p): Parameters<GmailSendParams>,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        self.gmail_send_for_caller_with_executor(p, mcp_caller_from_env(), &LiveHermesMcpExecutor)
            .await
    }

    async fn gmail_send_for_caller_with_executor<E: HermesMcpExecutor>(
        &self,
        p: GmailSendParams,
        caller: McpCaller,
        executor: &E,
    ) -> Result<Json<ProposeResult>, rmcp::ErrorData> {
        let summary = format!("Gmail 발송 → {}: {}", p.to, p.subject);
        let action = ExternalAction::GmailSendEmail {
            to: p.to,
            subject: p.subject,
            body: p.body,
        };
        self.route_write_for_caller(
            "wr_gmail_send",
            &p.project_id,
            action,
            &summary,
            caller,
            executor,
        )
        .await
    }

    /// Hermes-confirmed OCR receipt save. This is a local bookkeeping row insert/upsert, not an
    /// external service mutation, and is only enabled for the Hermes-marked MCP server process.
    #[tool(
        name = "wr_bookkeeping_save_receipt",
        description = "Save normalized receipt fields into local bookkeeping when called by Work Radar Hermes after its permission card. Returns only transaction id/status; accepts no raw image, file path, email body, token, or credential fields."
    )]
    pub async fn bookkeeping_save_receipt(
        &self,
        Parameters(p): Parameters<BookkeepingSaveReceiptParams>,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
        self.bookkeeping_save_receipt_for_caller(p, mcp_caller_from_env())
            .await
    }

    async fn bookkeeping_save_receipt_for_caller(
        &self,
        p: BookkeepingSaveReceiptParams,
        caller: McpCaller,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
        if caller != McpCaller::Hermes {
            return Err(rmcp::ErrorData::invalid_params(
                "wr_bookkeeping_save_receipt requires the Work Radar Hermes MCP caller",
                None,
            ));
        }

        if let Some(project_id) = p.project_id.as_deref() {
            let project = projects::fetch_project(&self.db, project_id)
                .await
                .map_err(|e| mcp_tool_error("wr_bookkeeping_save_receipt", &AppError::from(e)))?;
            if project.is_none() {
                return Err(rmcp::ErrorData::invalid_params(
                    format!("unknown project_id: {project_id}"),
                    None,
                ));
            }
        }

        let direction = match p.direction.as_deref().map(str::trim) {
            None | Some("") | Some("expense") => BookkeepingDirection::Expense,
            Some("income") => BookkeepingDirection::Income,
            Some(other) => {
                return Err(rmcp::ErrorData::invalid_params(
                    format!("invalid direction (expected 'expense' or 'income'): {other}"),
                    None,
                ));
            }
        };
        let field_confidence_json = p
            .field_confidence
            .as_ref()
            .map(|map| serde_json::to_string(map).unwrap_or_else(|_| "{}".to_string()));
        let review_reasons_json = p
            .review_reasons
            .as_ref()
            .map(|reasons| serde_json::to_string(reasons).unwrap_or_else(|_| "[]".to_string()));

        // Map + validate line items BEFORE the row commits — a bad item must not orphan a saved row
        // (critic MAJOR). prepare_line_items is the same validator the IPC set command uses.
        let line_item_inputs: Option<Vec<CreateBookkeepingLineItemInput>> =
            p.line_items.map(|items| {
                items
                    .into_iter()
                    .map(|i| CreateBookkeepingLineItemInput {
                        name: i.name,
                        amount_minor: i.amount_minor,
                        quantity: i.quantity,
                        category_code: i.category_code,
                    })
                    .collect()
            });
        if let Some(items) = line_item_inputs.as_ref() {
            bookkeeping_commands::prepare_line_items(items)
                .map_err(|e| mcp_tool_error("wr_bookkeeping_save_receipt", &e))?;
        }

        let row = bookkeeping_commands::upsert_bookkeeping_transaction_from_ingest_inner(
            &self.db,
            CreateBookkeepingTransactionInput {
                project_id: p.project_id,
                source: BookkeepingSource::Ocr,
                source_ref: p.source_ref,
                merchant: p.merchant,
                description: p.description,
                amount_minor: p.amount_minor,
                currency: p.currency.unwrap_or_else(|| "KRW".to_string()),
                spent_at: p.spent_at,
                category: p.category.unwrap_or_else(|| "uncategorized".to_string()),
                note: p.note,
                payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
                payment_method_label: None,
                payment_method_last4: None,
                expense_kind: BookkeepingExpenseKind::Variable,
                recurring_expense_id: None,
                recurring_occurrence_id: None,
                direction,
                account: p.account,
                subcategory: p.subcategory,
                category_code: p.category_code,
                subcategory_code: p.subcategory_code,
                raw_category: p.raw_category,
                spent_at_time: p.spent_at_time,
                confidence: p.confidence,
                field_confidence_json,
                review_reasons_json,
                order_no: p.order_no,
                payment_no: p.payment_no,
            },
            "transaction.ocr_ingested",
            "OCR 영수증이 리뷰큐에 추가됨",
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_save_receipt", &e))?;

        if let Some(items) = line_item_inputs {
            bookkeeping_commands::set_bookkeeping_line_items_inner(
                &self.db,
                SetBookkeepingLineItemsInput {
                    transaction_id: row.id.clone(),
                    items,
                },
            )
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_save_receipt", &e))?;
        }

        Ok(Json(BookkeepingSaveReceiptResult {
            transaction_id: row.id,
            status: "saved".to_string(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_list_recent_transactions",
        description = "List recent bookkeeping transactions (sanitized metadata — note/payment/asset included, raw email body & tokens never). Read-only; open to any MCP caller."
    )]
    pub async fn bookkeeping_list_recent_transactions(
        &self,
        Parameters(p): Parameters<BookkeepingListParams>,
    ) -> Result<Json<BookkeepingTransactionListDto>, rmcp::ErrorData> {
        self.bookkeeping_list_transactions_for_caller(p, None, mcp_caller_from_env())
            .await
    }

    #[tool(
        name = "wr_bookkeeping_list_review_queue",
        description = "List bookkeeping transactions awaiting review (sanitized metadata). Read-only; open to any MCP caller."
    )]
    pub async fn bookkeeping_list_review_queue(
        &self,
        Parameters(p): Parameters<BookkeepingListParams>,
    ) -> Result<Json<BookkeepingTransactionListDto>, rmcp::ErrorData> {
        self.bookkeeping_list_transactions_for_caller(
            p,
            Some(crate::models::BookkeepingReviewStatus::NeedsReview),
            mcp_caller_from_env(),
        )
        .await
    }

    // 읽기 개방(2026-07-04, 사용자 결정): 가계부 READ 툴은 Hermes 외 caller(다른 에이전트가
    // `--mcp-stdio`를 직접 spawn)도 허용 — 로컬 sanitized 조회라 proposal-only 계약과 무관하고,
    // 쓰기(save_receipt/mark_duplicate)는 여전히 require_hermes. caller 파라미터는 게이트
    // 재도입/감사 시그니처 안정성을 위해 유지한다.
    async fn bookkeeping_list_transactions_for_caller(
        &self,
        p: BookkeepingListParams,
        status: Option<crate::models::BookkeepingReviewStatus>,
        _caller: McpCaller,
    ) -> Result<Json<BookkeepingTransactionListDto>, rmcp::ErrorData> {
        let limit = p.limit.unwrap_or(25).clamp(1, 100);
        let rows = bookkeeping_commands::list_bookkeeping_transactions_inner(
            &self.db,
            status,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_list", &e))?;
        let transactions = rows
            .into_iter()
            .take(limit as usize)
            .map(to_transaction_dto)
            .collect();
        Ok(Json(BookkeepingTransactionListDto { transactions }))
    }

    #[tool(
        name = "wr_bookkeeping_monthly_summary",
        description = "Monthly expense/income/net + review-state counts. Read-only; open to any MCP caller."
    )]
    pub async fn bookkeeping_monthly_summary(
        &self,
        Parameters(p): Parameters<BookkeepingMonthlySummaryParams>,
    ) -> Result<Json<BookkeepingMonthlySummaryDto>, rmcp::ErrorData> {
        self.bookkeeping_monthly_summary_for_caller(p, mcp_caller_from_env())
            .await
    }

    async fn bookkeeping_monthly_summary_for_caller(
        &self,
        p: BookkeepingMonthlySummaryParams,
        _caller: McpCaller,
    ) -> Result<Json<BookkeepingMonthlySummaryDto>, rmcp::ErrorData> {
        let s = bookkeeping_commands::bookkeeping_monthly_summary_inner(
            &self.db,
            &p.month,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_monthly_summary", &e))?;
        Ok(Json(BookkeepingMonthlySummaryDto {
            month: s.month,
            total_expense_minor: s.total_expense_minor,
            total_income_minor: s.total_income_minor,
            net_minor: s.net_minor,
            needs_review_count: s.needs_review_count,
            approved_count: s.approved_count,
            ignored_count: s.ignored_count,
            duplicate_count: s.duplicate_count,
        }))
    }

    #[tool(
        name = "wr_bookkeeping_get_category_rules",
        description = "Return the seeded category taxonomy + alias rules so agents can resolve codes consistently. Read-only; open to any MCP caller."
    )]
    pub async fn bookkeeping_get_category_rules(
        &self,
    ) -> Result<Json<BookkeepingCategoryRulesDto>, rmcp::ErrorData> {
        self.bookkeeping_get_category_rules_for_caller(mcp_caller_from_env())
            .await
    }

    async fn bookkeeping_get_category_rules_for_caller(
        &self,
        _caller: McpCaller,
    ) -> Result<Json<BookkeepingCategoryRulesDto>, rmcp::ErrorData> {
        let rules = bookkeeping_commands::bookkeeping_category_rules_inner(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_get_category_rules", &e))?;
        Ok(Json(BookkeepingCategoryRulesDto {
            taxonomy: rules
                .taxonomy
                .into_iter()
                .map(|n| BookkeepingCategoryNodeDto {
                    code: n.code,
                    parent_code: n.parent_code,
                    label: n.label,
                })
                .collect(),
            aliases: rules
                .aliases
                .into_iter()
                .map(|a| BookkeepingCategoryAliasDto {
                    pattern: a.pattern,
                    match_kind: enum_wire_string(&a.match_kind),
                    category_code: a.category_code,
                    subcategory_code: a.subcategory_code,
                    confidence: a.confidence,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_find_duplicate_candidates",
        description = "Find likely-duplicate existing transactions before saving (fuzzy: source_ref / order / payment number / amount+date+merchant). Read-only; open to any MCP caller."
    )]
    pub async fn bookkeeping_find_duplicate_candidates(
        &self,
        Parameters(p): Parameters<BookkeepingFindDuplicateParams>,
    ) -> Result<Json<BookkeepingDuplicateCandidateListDto>, rmcp::ErrorData> {
        self.bookkeeping_find_duplicate_candidates_for_caller(p, mcp_caller_from_env())
            .await
    }

    async fn bookkeeping_find_duplicate_candidates_for_caller(
        &self,
        p: BookkeepingFindDuplicateParams,
        _caller: McpCaller,
    ) -> Result<Json<BookkeepingDuplicateCandidateListDto>, rmcp::ErrorData> {
        let candidates = bookkeeping_commands::find_bookkeeping_duplicate_candidates_inner(
            &self.db,
            crate::models::FindBookkeepingDuplicateCandidatesInput {
                project_id: p.project_id,
                spent_at: p.spent_at,
                amount_minor: p.amount_minor,
                merchant: p.merchant,
                order_no: p.order_no,
                payment_no: p.payment_no,
                // Hermes saves receipts as source=Ocr, so the strongest signal (source+source_ref
                // exact = 1.0) must resolve against Ocr rows; without this the source_ref path is inert.
                source: p.source_ref.as_ref().map(|_| BookkeepingSource::Ocr),
                source_ref: p.source_ref,
                exclude_transaction_id: p.exclude_transaction_id,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_find_duplicate_candidates", &e))?;
        let candidates = candidates
            .into_iter()
            .map(|c| BookkeepingDuplicateCandidateDto {
                transaction_id: c.transaction.id,
                merchant: c.transaction.merchant,
                amount_minor: c.transaction.amount_minor,
                spent_at: c.transaction.spent_at,
                score: c.score,
                reasons: c.reasons,
            })
            .collect();
        Ok(Json(BookkeepingDuplicateCandidateListDto { candidates }))
    }

    #[tool(
        name = "wr_bookkeeping_mark_duplicate",
        description = "Mark a transaction as a duplicate of another (sets it ignored + links the original). Local review-queue write; Hermes caller only."
    )]
    pub async fn bookkeeping_mark_duplicate(
        &self,
        Parameters(p): Parameters<BookkeepingMarkDuplicateParams>,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
        self.bookkeeping_mark_duplicate_for_caller(p, mcp_caller_from_env())
            .await
    }

    async fn bookkeeping_mark_duplicate_for_caller(
        &self,
        p: BookkeepingMarkDuplicateParams,
        caller: McpCaller,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
        require_hermes(caller, "wr_bookkeeping_mark_duplicate")?;
        let row = bookkeeping_commands::mark_bookkeeping_duplicate_inner(
            &self.db,
            &p.transaction_id,
            &p.duplicate_of_transaction_id,
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_mark_duplicate", &e))?;
        Ok(Json(BookkeepingSaveReceiptResult {
            transaction_id: row.id,
            status: "marked_duplicate".to_string(),
        }))
    }

    /// 제안만 생성한다 — **실행 안 함**. 사용자 승인 후 Rust 커넥터가 실행(Phase 0 게이트).
    /// `store::enqueue`만 호출한다(execute/mint 경로 없음 — Task 1.0 type-wall로 컴파일 강제).
    /// DB 에러는 action_id="" + status="error"로 surface(패닉 금지).
    #[tool(
        name = "wr_propose_noop",
        description = "Propose a no-op external action (Phase 1 proposal-path demo). Returns an action_id awaiting user approval; does NOT execute."
    )]
    pub async fn propose_noop(
        &self,
        Parameters(p): Parameters<ProposeNoopParams>,
    ) -> Json<ProposeResult> {
        let action = ExternalAction::Noop { note: p.note };
        match store::enqueue(&self.db, &action, None, Some(&p.preview), "mcp:client").await {
            Ok(id) => Json(ProposeResult {
                action_id: id,
                status: "awaiting_approval".into(),
            }),
            Err(e) => {
                // 기존 계약(status:"error" + 빈 id) 유지(비회귀)하되, 삼킨 에러가 완전히 안 보이는
                // 일이 없게 stderr에 PII-free 코드만 남긴다(stdout은 MCP 전용).
                eprintln!(
                    "[work-radar mcp-stdio] wr_propose_noop db error: code={} trace_id={}",
                    e.code, e.trace_id
                );
                Json(ProposeResult {
                    action_id: String::new(),
                    status: "error".into(),
                })
            }
        }
    }

    /// 액션 승인/실행 상태 폴링(단건 — terminal 도달 시 종료는 클라이언트 책임, 무한 폴링 없음).
    /// 없는 id는 status=None(정상). DB 에러는 **None으로 삼키지 않고** rmcp internal-error로
    /// surface — 폴링 에이전트가 "조회 실패"와 "행 없음/미결정"을 구분할 수 있게(읽기 툴 비대칭 수정).
    /// surface/로그는 PII-free하게 AppError.code만 쓴다.
    #[tool(
        name = "wr_action_status",
        description = "Poll the status of a proposed action by id (awaiting_approval | succeeded | failed | rejected)."
    )]
    pub async fn action_status(
        &self,
        Parameters(p): Parameters<ActionIdParams>,
    ) -> Result<Json<ActionStatus>, rmcp::ErrorData> {
        let status = store::status(&self.db, &p.action_id)
            .await
            .map_err(|e| db_tool_error("wr_action_status", &e))?;
        Ok(Json(ActionStatus { status }))
    }
}

impl WrServer {
    async fn route_write_for_caller<E: HermesMcpExecutor>(
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
    /// (store::enqueue_with_idempotency만 — 승인 후 Rust 커넥터가 실행). Phase 2~5 write 툴이 공유한다.
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

/// ProjectKind → 안정 라벨 문자열(MCP 표면 전용 — serde 태그와 동일 의미).
fn project_kind_str(kind: ProjectKind) -> &'static str {
    match kind {
        ProjectKind::Personal => "personal",
        ProjectKind::Work => "work",
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

/// 툴 에러 → rmcp internal-error 매핑. **PII-free**: AppError.code만 노출/기록하고
/// message/payload 본문은 절대 넣지 않는다. trace_id는 로그 상관용으로 stderr에만.
/// stderr 기록(stdout 아님 — stdout은 MCP 프로토콜 전용)으로 삼킨 에러가 완전히 안 보이는 일은 없게 한다.
fn db_tool_error(tool: &str, e: &crate::error::AppError) -> rmcp::ErrorData {
    mcp_tool_error(tool, e)
}

fn mcp_tool_error(tool: &str, e: &crate::error::AppError) -> rmcp::ErrorData {
    eprintln!(
        "[work-radar mcp-stdio] {tool} error: code={} trace_id={}",
        e.code, e.trace_id
    );
    rmcp::ErrorData::internal_error(format!("tool error ({})", e.code), None)
}

#[cfg(test)]
mod write_tool_tests {
    use super::*;
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::external_actions::ExecOutcome;
    use crate::models::{Project, ProjectKind};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeHermesExecutor {
        calls: AtomicUsize,
    }

    impl FakeHermesExecutor {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::Relaxed)
        }
    }

    impl HermesMcpExecutor for FakeHermesExecutor {
        async fn execute(
            &self,
            _project: &Project,
            action: &ExternalAction,
        ) -> Result<ExecOutcome, AppError> {
            let n = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
            Ok(ExecOutcome {
                external_ref: Some(format!("direct-{n}-{}", action.kind_str())),
                bytes: Some(1),
            })
        }
    }

    /// 알 수 없는 project_id → 툴이 에러를 반환하고 **아무것도 enqueue하지 않는다**(#11).
    #[tokio::test]
    async fn github_comment_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .github_comment(Parameters(GithubCommentParams {
                project_id: "does-not-exist".into(),
                repo: "o/r".into(),
                issue_number: 7,
                body: "hi".into(),
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// 유효한 project_id → enqueue되고 project_ref가 그 프로젝트의 credential_ref로 설정된다.
    /// 동일 제안 반복은 안정 멱등 키로 dedup(같은 action_id, 큐 1건).
    #[tokio::test]
    async fn github_comment_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || GithubCommentParams {
            project_id: project.id.clone(),
            repo: "o/r".into(),
            issue_number: 7,
            body: "hi".into(),
        };
        let first = server.github_comment(Parameters(params())).await.unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        // project_ref == 프로젝트 credential_ref(proposer가 준 raw 값이 아니라 서버가 해석).
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        // 동일 제안 재호출 → 안정 키로 dedup(같은 id, 큐 1건).
        let second = server.github_comment(Parameters(params())).await.unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    /// 내용이 다르면(다른 이슈 번호) 다른 멱등 키 → 별도 행.
    #[tokio::test]
    async fn github_create_issue_distinct_content_distinct_key() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let a = server
            .github_create_issue(Parameters(GithubCreateIssueParams {
                project_id: project.id.clone(),
                repo: "o/r".into(),
                title: "A".into(),
                body: "B".into(),
            }))
            .await
            .unwrap();
        let b = server
            .github_create_issue(Parameters(GithubCreateIssueParams {
                project_id: project.id.clone(),
                repo: "o/r".into(),
                title: "A2".into(),
                body: "B".into(),
            }))
            .await
            .unwrap();
        assert_ne!(a.0.action_id, b.0.action_id);
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 2);
    }

    /// Hermes-origin write tools use Hermes' own permission gate and therefore execute directly
    /// through the connector seam instead of creating Work Radar approval proposals.
    #[tokio::test]
    async fn hermes_write_tools_execute_direct_without_work_radar_approval_queue() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let executor = FakeHermesExecutor::new();

        let github_comment = server
            .github_comment_for_caller_with_executor(
                GithubCommentParams {
                    project_id: project.id.clone(),
                    repo: "o/r".into(),
                    issue_number: 7,
                    body: "hi".into(),
                },
                McpCaller::Hermes,
                &executor,
            )
            .await
            .expect("Hermes GitHub comment direct");
        let github_issue = server
            .github_create_issue_for_caller_with_executor(
                GithubCreateIssueParams {
                    project_id: project.id.clone(),
                    repo: "o/r".into(),
                    title: "T".into(),
                    body: "B".into(),
                },
                McpCaller::Hermes,
                &executor,
            )
            .await
            .expect("Hermes GitHub issue direct");
        let notion = server
            .notion_create_page_for_caller_with_executor(
                NotionCreatePageParams {
                    project_id: project.id.clone(),
                    db_id: "1234567890abcdef1234567890abcdef".into(),
                    title: "할 일".into(),
                },
                McpCaller::Hermes,
                &executor,
            )
            .await
            .expect("Hermes Notion direct");
        let calendar = server
            .calendar_create_event_for_caller_with_executor(
                CalendarCreateEventParams {
                    project_id: project.id.clone(),
                    calendar_id: "primary".into(),
                    title: "회의".into(),
                    start: "2026-06-04T10:00:00+09:00".into(),
                    end: "2026-06-04T11:00:00+09:00".into(),
                    all_day: false,
                    description: None,
                },
                McpCaller::Hermes,
                &executor,
            )
            .await
            .expect("Hermes Calendar direct");
        let gmail = server
            .gmail_send_for_caller_with_executor(
                GmailSendParams {
                    project_id: project.id.clone(),
                    to: "vip@client.test".into(),
                    subject: "주간 보고".into(),
                    body: "본문".into(),
                },
                McpCaller::Hermes,
                &executor,
            )
            .await
            .expect("Hermes Gmail direct");

        assert_eq!(github_comment.0.status, "succeeded");
        assert!(github_comment.0.action_id.starts_with("direct-1-"));
        assert_eq!(github_issue.0.status, "succeeded");
        assert!(github_issue.0.action_id.starts_with("direct-2-"));
        assert_eq!(notion.0.status, "succeeded");
        assert!(notion.0.action_id.starts_with("direct-3-"));
        assert_eq!(calendar.0.status, "succeeded");
        assert!(calendar.0.action_id.starts_with("direct-4-"));
        assert_eq!(gmail.0.status, "succeeded");
        assert!(gmail.0.action_id.starts_with("direct-5-"));
        assert_eq!(executor.calls(), 5);
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "Hermes direct writes must not create Work Radar approval proposals"
        );
    }

    /// Notion: 알 수 없는 project_id → 거부 + enqueue 0(#11, GitHub와 동일한 격리 계약).
    #[tokio::test]
    async fn notion_create_page_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .notion_create_page(Parameters(NotionCreatePageParams {
                project_id: "does-not-exist".into(),
                db_id: "1234567890abcdef1234567890abcdef".into(),
                title: "할 일".into(),
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// Notion: 유효한 project_id → 그 프로젝트 credential_ref로 enqueue되고, 동일 제안은 dedup(큐 1건).
    #[tokio::test]
    async fn notion_create_page_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || NotionCreatePageParams {
            project_id: project.id.clone(),
            db_id: "1234567890abcdef1234567890abcdef".into(),
            title: "할 일".into(),
        };
        let first = server
            .notion_create_page(Parameters(params()))
            .await
            .unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        let second = server
            .notion_create_page(Parameters(params()))
            .await
            .unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    /// Calendar: 알 수 없는 project_id → 거부 + enqueue 0(#11, GitHub/Notion과 동일한 격리 계약).
    #[tokio::test]
    async fn calendar_create_event_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .calendar_create_event(Parameters(CalendarCreateEventParams {
                project_id: "does-not-exist".into(),
                calendar_id: "primary".into(),
                title: "회의".into(),
                start: "2026-06-04T10:00:00+09:00".into(),
                end: "2026-06-04T11:00:00+09:00".into(),
                all_day: false,
                description: None,
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// Calendar: 유효한 project_id → 그 프로젝트 credential_ref로 CalendarCreateEvent가 enqueue되고,
    /// 동일 제안은 안정 멱등 키로 dedup(같은 action_id, 큐 1건).
    #[tokio::test]
    async fn calendar_create_event_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || CalendarCreateEventParams {
            project_id: project.id.clone(),
            calendar_id: "primary".into(),
            title: "회의".into(),
            start: "2026-06-04T10:00:00+09:00".into(),
            end: "2026-06-04T11:00:00+09:00".into(),
            all_day: false,
            description: Some("주간 동기화".into()),
        };
        let first = server
            .calendar_create_event_for_caller(params(), McpCaller::Other)
            .await
            .unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        // project_ref == 프로젝트 credential_ref(proposer가 준 raw 값이 아니라 서버가 해석).
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        // 동일 제안 재호출 → 안정 키로 dedup(같은 id, 큐 1건).
        let second = server
            .calendar_create_event_for_caller(params(), McpCaller::Other)
            .await
            .unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    /// Hermes-origin Calendar 호출은 승인 큐에 enqueue하지 않는다. 알 수 없는 project_id도 즉시 거부된다.
    #[tokio::test]
    async fn hermes_calendar_create_event_rejects_unknown_project_without_enqueue() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .calendar_create_event_for_caller(
                CalendarCreateEventParams {
                    project_id: "does-not-exist".into(),
                    calendar_id: "primary".into(),
                    title: "회의".into(),
                    start: "2026-06-04T10:00:00+09:00".into(),
                    end: "2026-06-04T11:00:00+09:00".into(),
                    all_day: false,
                    description: None,
                },
                McpCaller::Hermes,
            )
            .await;
        assert!(
            res.is_err(),
            "Hermes direct 경로도 unknown project_id는 거부"
        );
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "Hermes direct 경로는 승인 큐에 enqueue하지 않음"
        );
    }

    /// Hermes-origin OCR receipt save is a local DB write after Hermes' permission card, so it does
    /// not create a Work Radar approval proposal. The saved row still enters the review queue.
    #[tokio::test]
    async fn hermes_bookkeeping_save_receipt_writes_local_review_row_without_enqueue() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let res = server
            .bookkeeping_save_receipt_for_caller(
                BookkeepingSaveReceiptParams {
                    project_id: None,
                    source_ref: Some("hermes-ocr-001".into()),
                    merchant: "동네마트".into(),
                    amount_minor: 12_300,
                    currency: Some("KRW".into()),
                    spent_at: "2026-06-16".into(),
                    category: Some("food".into()),
                    description: Some("영수증 OCR".into()),
                    note: None,
                    direction: None,
                    account: None,
                    subcategory: None,
                    category_code: None,
                    subcategory_code: None,
                    raw_category: None,
                    spent_at_time: None,
                    confidence: None,
                    field_confidence: None,
                    review_reasons: None,
                    order_no: None,
                    payment_no: None,
                    line_items: None,
                },
                McpCaller::Hermes,
            )
            .await
            .expect("Hermes OCR save");

        assert_eq!(res.0.status, "saved");
        assert!(!res.0.transaction_id.is_empty());
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "Hermes bookkeeping save is local DB write, not external proposal"
        );

        let row: (String, String, String, String, i32) = sqlx::query_as(
            "SELECT id, source, review_status, merchant, amount_minor \
             FROM bookkeeping_transactions WHERE id = ?1",
        )
        .bind(&res.0.transaction_id)
        .fetch_one(&db)
        .await
        .expect("saved bookkeeping row");
        assert_eq!(row.0, res.0.transaction_id);
        assert_eq!(row.1, "ocr");
        assert_eq!(row.2, "needs_review");
        assert_eq!(row.3, "동네마트");
        assert_eq!(row.4, 12_300);
    }

    /// The widened save accepts the full judgment shape (income/account/subcategory/raw label/
    /// confidence/reasons/order+payment numbers) and persists it — this is the Hermes ingest goal.
    #[tokio::test]
    async fn hermes_bookkeeping_save_receipt_persists_widened_judgment_fields() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let mut field_confidence = std::collections::BTreeMap::new();
        field_confidence.insert("amount".to_string(), 0.99_f64);
        field_confidence.insert("merchant".to_string(), 0.6_f64);

        let res = server
            .bookkeeping_save_receipt_for_caller(
                BookkeepingSaveReceiptParams {
                    project_id: None,
                    source_ref: Some("hermes-ocr-777".into()),
                    merchant: "쿠팡".into(),
                    amount_minor: 59_010,
                    currency: Some("KRW".into()),
                    spent_at: "2026-06-12".into(),
                    category: Some("쇼핑".into()),
                    description: Some("카멜 모니터암".into()),
                    note: None,
                    direction: Some("expense".into()),
                    account: Some("하나".into()),
                    subcategory: Some("생활용품".into()),
                    category_code: Some("shopping".into()),
                    subcategory_code: Some("daily_goods".into()),
                    raw_category: Some("🪑 생활용품".into()),
                    spent_at_time: Some("14:28:47".into()),
                    confidence: Some(0.84),
                    field_confidence: Some(field_confidence),
                    review_reasons: Some(vec![BookkeepingReviewReasonParam {
                        code: "low_merchant_confidence".into(),
                        detail: Some("merchant inferred from sender".into()),
                    }]),
                    order_no: Some("ORDER-9".into()),
                    payment_no: Some("PAY-9".into()),
                    line_items: Some(vec![
                        BookkeepingLineItemParam {
                            name: "모니터암".into(),
                            amount_minor: 30_000,
                            quantity: Some(1),
                            category_code: None,
                        },
                        BookkeepingLineItemParam {
                            name: "배송비".into(),
                            amount_minor: 5_000,
                            quantity: Some(1),
                            category_code: None,
                        },
                    ]),
                },
                McpCaller::Hermes,
            )
            .await
            .expect("Hermes widened save");
        assert_eq!(res.0.status, "saved");

        // Line items persisted through the MCP path; their sum (35_000) ≠ amount (59_010) → reason.
        let line_items =
            bookkeeping_commands::list_bookkeeping_line_items_inner(&db, &res.0.transaction_id)
                .await
                .expect("line items");
        assert_eq!(line_items.len(), 2);

        let saved = bookkeeping_commands::list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("list transactions")
            .into_iter()
            .find(|t| t.id == res.0.transaction_id)
            .expect("widened row");
        assert_eq!(saved.direction, BookkeepingDirection::Expense);
        assert_eq!(saved.account.as_deref(), Some("하나"));
        assert_eq!(saved.subcategory.as_deref(), Some("생활용품"));
        assert_eq!(saved.raw_category.as_deref(), Some("🪑 생활용품"));
        assert_eq!(saved.confidence, Some(0.84));
        assert!(
            saved.field_confidence_json.contains("amount"),
            "field_confidence persisted"
        );
        assert!(
            saved
                .review_reasons_json
                .contains("low_merchant_confidence"),
            "review reasons persisted"
        );
        assert_eq!(saved.order_no.as_deref(), Some("ORDER-9"));
        assert_eq!(saved.payment_no.as_deref(), Some("PAY-9"));

        // Invalid direction is rejected.
        let bad = server
            .bookkeeping_save_receipt_for_caller(
                BookkeepingSaveReceiptParams {
                    project_id: None,
                    source_ref: Some("hermes-ocr-778".into()),
                    merchant: "x".into(),
                    amount_minor: 1,
                    currency: None,
                    spent_at: "2026-06-12".into(),
                    category: None,
                    description: None,
                    note: None,
                    direction: Some("sideways".into()),
                    account: None,
                    subcategory: None,
                    category_code: None,
                    subcategory_code: None,
                    raw_category: None,
                    spent_at_time: None,
                    confidence: None,
                    field_confidence: None,
                    review_reasons: None,
                    order_no: None,
                    payment_no: None,
                    line_items: None,
                },
                McpCaller::Hermes,
            )
            .await;
        assert!(bad.is_err(), "invalid direction rejected");
    }

    /// Non-Hermes MCP callers cannot mutate the local bookkeeping DB through the OCR receipt tool.
    #[tokio::test]
    async fn non_hermes_bookkeeping_save_receipt_is_rejected_without_write() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let res = server
            .bookkeeping_save_receipt_for_caller(
                BookkeepingSaveReceiptParams {
                    project_id: None,
                    source_ref: Some("other-ocr-001".into()),
                    merchant: "동네마트".into(),
                    amount_minor: 12_300,
                    currency: Some("KRW".into()),
                    spent_at: "2026-06-16".into(),
                    category: Some("food".into()),
                    description: None,
                    note: None,
                    direction: None,
                    account: None,
                    subcategory: None,
                    category_code: None,
                    subcategory_code: None,
                    raw_category: None,
                    spent_at_time: None,
                    confidence: None,
                    field_confidence: None,
                    review_reasons: None,
                    order_no: None,
                    payment_no: None,
                    line_items: None,
                },
                McpCaller::Other,
            )
            .await;

        assert!(res.is_err(), "only Hermes caller may use direct OCR save");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bookkeeping_transactions")
            .fetch_one(&db)
            .await
            .expect("count bookkeeping rows");
        assert_eq!(count, 0);
        assert!(store::list_pending(&db).await.unwrap().is_empty());
    }

    /// Gmail: 알 수 없는 project_id → 거부 + enqueue 0(#11, 다른 write 툴과 동일한 격리 계약).
    #[tokio::test]
    async fn gmail_send_rejects_unknown_project_and_enqueues_nothing() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let res = server
            .gmail_send(Parameters(GmailSendParams {
                project_id: "does-not-exist".into(),
                to: "vip@client.test".into(),
                subject: "안녕하세요".into(),
                body: "본문".into(),
            }))
            .await;
        assert!(res.is_err(), "unknown project_id는 거부");
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "거부 시 enqueue 0"
        );
    }

    /// Gmail: 유효한 project_id → 그 프로젝트 credential_ref로 GmailSendEmail이 enqueue되고,
    /// 동일 제안은 안정 멱등 키로 dedup(같은 action_id, 큐 1건). C1: preview 컬럼이 수신자+제목을 노출해야 한다.
    #[tokio::test]
    async fn gmail_send_enqueues_with_cref_and_dedups() {
        let db = fresh_db().await;
        let project = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let server = WrServer { db: db.clone() };
        let params = || GmailSendParams {
            project_id: project.id.clone(),
            to: "vip@client.test".into(),
            subject: "주간 보고".into(),
            body: "본문".into(),
        };
        let first = server.gmail_send(Parameters(params())).await.unwrap();
        let id1 = first.0.action_id.clone();
        assert_eq!(first.0.status, "awaiting_approval");
        // project_ref == 프로젝트 credential_ref(proposer가 준 raw 값이 아니라 서버가 해석).
        assert_eq!(
            store::project_ref_for(&db, &id1).await.unwrap().as_deref(),
            Some(project.credential_ref.as_str())
        );
        // C1(chain-of-custody #2/#5): preview 컬럼은 승인자가 정확한 수신자+제목을 보도록 그 값을 담아야 한다.
        // (수신자는 preview에만 — audit detail에는 ref/bytes만, US-004.)
        let preview: Option<String> =
            sqlx::query_scalar("SELECT preview FROM external_actions WHERE id = ?1")
                .bind(&id1)
                .fetch_one(&db)
                .await
                .unwrap();
        let preview = preview.unwrap();
        assert!(
            preview.contains("vip@client.test"),
            "preview는 수신자를 노출해야 함(C1): {preview}"
        );
        assert!(preview.contains("주간 보고"), "preview는 제목도 노출");
        // 동일 제안 재호출 → 안정 키로 dedup(같은 id, 큐 1건).
        let second = server.gmail_send(Parameters(params())).await.unwrap();
        assert_eq!(
            second.0.action_id, id1,
            "동일 내용 = 동일 멱등 키 = 같은 id"
        );
        assert_eq!(store::list_pending(&db).await.unwrap().len(), 1);
    }

    #[test]
    fn registered_tool_set_is_locked() {
        let names: std::collections::BTreeSet<String> = WrServer::tool_router()
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        let expected: std::collections::BTreeSet<String> = [
            "wr_list_pending_actions",
            "wr_list_projects",
            "wr_github_comment",
            "wr_github_create_issue",
            "wr_notion_create_page",
            "wr_calendar_create_event",
            "wr_gmail_send",
            "wr_bookkeeping_save_receipt",
            "wr_bookkeeping_list_recent_transactions",
            "wr_bookkeeping_list_review_queue",
            "wr_bookkeeping_monthly_summary",
            "wr_bookkeeping_get_category_rules",
            "wr_bookkeeping_find_duplicate_candidates",
            "wr_bookkeeping_mark_duplicate",
            "wr_propose_noop",
            "wr_action_status",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(
            names, expected,
            "registered MCP tool set drifted — update intentionally + the CFO contract"
        );
        // No execute/approve/delete/sql/shell/network capability ever appears on the surface.
        for forbidden in [
            "approve",
            "execute",
            "delete",
            "raw_sql",
            "run_shell",
            "fetch_url",
            "mutate_db",
        ] {
            assert!(
                !names.iter().any(|n| n.contains(forbidden)),
                "forbidden capability on MCP surface: {forbidden}"
            );
        }
    }

    #[tokio::test]
    async fn bookkeeping_reads_open_to_any_caller_writes_stay_hermes_gated() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        // 읽기 개방(2026-07-04): non-Hermes caller도 요약/중복탐색 READ는 성공한다.
        let summary = server
            .bookkeeping_monthly_summary_for_caller(
                BookkeepingMonthlySummaryParams {
                    month: "2026-06".into(),
                    project_id: None,
                },
                McpCaller::Other,
            )
            .await;
        assert!(summary.is_ok(), "non-Hermes summary read is allowed");

        let open_find = server
            .bookkeeping_find_duplicate_candidates_for_caller(
                BookkeepingFindDuplicateParams {
                    project_id: None,
                    spent_at: "2026-06-12".into(),
                    amount_minor: 1_000,
                    merchant: None,
                    order_no: None,
                    payment_no: None,
                    source_ref: None,
                    exclude_transaction_id: None,
                },
                McpCaller::Other,
            )
            .await;
        assert!(open_find.is_ok(), "non-Hermes find read is allowed");

        // 쓰기는 여전히 Hermes 전용 — save_receipt/mark_duplicate 게이트 회귀 방지.
        let denied_save = server
            .bookkeeping_save_receipt_for_caller(
                BookkeepingSaveReceiptParams {
                    project_id: None,
                    source_ref: None,
                    merchant: "게이트검증".into(),
                    amount_minor: 1_000,
                    currency: None,
                    spent_at: "2026-06-12".into(),
                    category: None,
                    description: None,
                    note: None,
                    direction: None,
                    account: None,
                    subcategory: None,
                    category_code: None,
                    subcategory_code: None,
                    raw_category: None,
                    spent_at_time: None,
                    confidence: None,
                    field_confidence: None,
                    review_reasons: None,
                    order_no: None,
                    payment_no: None,
                    line_items: None,
                },
                McpCaller::Other,
            )
            .await;
        assert!(denied_save.is_err(), "non-Hermes save is refused");
        let denied_mark = server
            .bookkeeping_mark_duplicate_for_caller(
                BookkeepingMarkDuplicateParams {
                    transaction_id: "a".into(),
                    duplicate_of_transaction_id: "b".into(),
                },
                McpCaller::Other,
            )
            .await;
        assert!(denied_mark.is_err(), "non-Hermes mark is refused");

        // Hermes find-duplicate round-trips against a saved row.
        server
            .bookkeeping_save_receipt_for_caller(
                BookkeepingSaveReceiptParams {
                    project_id: None,
                    source_ref: Some("dup-seed".into()),
                    merchant: "쿠팡".into(),
                    amount_minor: 59_010,
                    currency: Some("KRW".into()),
                    spent_at: "2026-06-12".into(),
                    category: None,
                    description: Some("메일 원문 요약 — DTO에 노출되면 안 됨".into()),
                    note: Some("정기결제".into()),
                    direction: None,
                    account: Some("하나카드".into()),
                    subcategory: None,
                    category_code: None,
                    subcategory_code: None,
                    raw_category: None,
                    spent_at_time: Some("13:05:00".into()),
                    confidence: None,
                    field_confidence: None,
                    review_reasons: None,
                    order_no: Some("ORD-DUP".into()),
                    payment_no: None,
                    line_items: None,
                },
                McpCaller::Hermes,
            )
            .await
            .expect("seed save");

        let candidates = server
            .bookkeeping_find_duplicate_candidates_for_caller(
                BookkeepingFindDuplicateParams {
                    project_id: None,
                    spent_at: "2026-06-12".into(),
                    amount_minor: 59_010,
                    merchant: Some("쿠팡".into()),
                    order_no: Some("ORD-DUP".into()),
                    payment_no: None,
                    source_ref: None,
                    exclude_transaction_id: None,
                },
                McpCaller::Hermes,
            )
            .await
            .expect("find dup");
        assert!(
            candidates.0.candidates.iter().any(|c| c.score >= 0.9),
            "order_no match scores high"
        );

        // non-Hermes caller가 목록을 읽고, DTO에 내용(note)/자산/시각이 실려온다 —
        // 단 소스 원문 description은 sanitized 계약대로 DTO 표면에 없다(타입이 강제).
        let listed = server
            .bookkeeping_list_transactions_for_caller(
                BookkeepingListParams {
                    project_id: None,
                    limit: Some(10),
                },
                None,
                McpCaller::Other,
            )
            .await
            .expect("non-Hermes list read");
        let dto = listed
            .0
            .transactions
            .iter()
            .find(|t| t.merchant == "쿠팡")
            .expect("seeded row listed");
        assert_eq!(dto.note.as_deref(), Some("정기결제"));
        assert_eq!(dto.account.as_deref(), Some("하나카드"));
        assert_eq!(dto.spent_at_time.as_deref(), Some("13:05:00"));
        assert_eq!(dto.payment_method_kind, "unknown");
    }
}

#[cfg(test)]
mod schema_tests {
    use super::{
        ActionIdParams, BookkeepingFindDuplicateParams, BookkeepingLineItemParam,
        BookkeepingListParams, BookkeepingMarkDuplicateParams, BookkeepingMonthlySummaryParams,
        BookkeepingReviewReasonParam, BookkeepingSaveReceiptParams, BookkeepingTransactionDto,
        CalendarCreateEventParams, GithubCommentParams, GithubCreateIssueParams, GmailSendParams,
        NotionCreatePageParams, ProposeNoopParams,
    };
    use std::collections::BTreeSet;

    fn prop_names(v: &serde_json::Value) -> BTreeSet<String> {
        v["properties"]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn required_fields(v: &serde_json::Value) -> BTreeSet<String> {
        v["required"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn expect(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    // write/read 툴 입력 DTO가 **닫힌 스키마**(additionalProperties:false = deny_unknown_fields)임을
    // 고정하고, 필드/required 표면 drift를 잠근다(mcp-server-conventions §2/§8). Phase 2~5에서 실
    // write 툴 param이 늘면 여기에 케이스를 추가해 같은 계약(unknown-field 거부 + 표면 고정)을 강제한다.
    // 출력 DTO 표면 고정 — 입력 param과 달리 출력은 deny_unknown_fields가 없어 타입만이 가드다.
    // 필드 집합을 스냅샷해 부주의한 확장(특히 소스 원문 `description` — 메일 본문 유래 가능 —
    // 이 sanitized 읽기 표면에 새는 회귀)을 컴파일이 아니라 테스트로도 잡는다(2026-07-04 읽기 개방).
    #[test]
    fn bookkeeping_transaction_dto_surface_is_locked_and_sanitized() {
        let v = serde_json::to_value(schemars::schema_for!(BookkeepingTransactionDto)).unwrap();
        assert_eq!(
            prop_names(&v),
            expect(&[
                "id",
                "merchant",
                "amount_minor",
                "currency",
                "direction",
                "spent_at",
                "spent_at_time",
                "category",
                "category_code",
                "subcategory_code",
                "note",
                "account",
                "payment_method_kind",
                "payment_method_label",
                "payment_method_last4",
                "expense_kind",
                "review_status",
                "confidence",
                "review_reason_codes",
                "source",
                "source_ref",
                "order_no",
                "payment_no",
            ])
        );
        // sanitized 계약의 핵심 부정 단언 — 원문/시크릿 계열 필드는 표면에 없다.
        for forbidden in ["description", "raw_body", "token", "credential_ref"] {
            assert!(
                !prop_names(&v).contains(forbidden),
                "sanitized read DTO must not expose `{forbidden}`"
            );
        }
    }

    #[test]
    fn propose_noop_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(ProposeNoopParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "ProposeNoopParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(prop_names(&v), expect(&["note", "preview"]));
        assert_eq!(required_fields(&v), expect(&["note", "preview"]));
    }

    #[test]
    fn action_id_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(ActionIdParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "ActionIdParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(prop_names(&v), expect(&["action_id"]));
        assert_eq!(required_fields(&v), expect(&["action_id"]));
    }

    #[test]
    fn github_comment_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(GithubCommentParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "GithubCommentParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "repo", "issue_number", "body"])
        );
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "repo", "issue_number", "body"])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }

    #[test]
    fn github_create_issue_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(GithubCreateIssueParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "GithubCreateIssueParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "repo", "title", "body"])
        );
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "repo", "title", "body"])
        );
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }

    #[test]
    fn notion_create_page_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(NotionCreatePageParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "NotionCreatePageParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(prop_names(&v), expect(&["project_id", "db_id", "title"]));
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "db_id", "title"])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }

    #[test]
    fn calendar_create_event_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(CalendarCreateEventParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "CalendarCreateEventParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&[
                "project_id",
                "calendar_id",
                "title",
                "start",
                "end",
                "all_day",
                "description",
            ])
        );
        // description은 Option → required 아님; 나머지는 required.
        assert_eq!(
            required_fields(&v),
            expect(&[
                "project_id",
                "calendar_id",
                "title",
                "start",
                "end",
                "all_day"
            ])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }

    #[test]
    fn bookkeeping_save_receipt_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(BookkeepingSaveReceiptParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "BookkeepingSaveReceiptParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&[
                "project_id",
                "source_ref",
                "merchant",
                "amount_minor",
                "currency",
                "spent_at",
                "category",
                "description",
                "note",
                "direction",
                "account",
                "subcategory",
                "category_code",
                "subcategory_code",
                "raw_category",
                "spent_at_time",
                "confidence",
                "field_confidence",
                "review_reasons",
                "order_no",
                "payment_no",
                "line_items",
            ])
        );
        // Widening is additive-optional: the original required set is unchanged so an in-field
        // Hermes sending only the old fields keeps validating.
        assert_eq!(
            required_fields(&v),
            expect(&["merchant", "amount_minor", "spent_at"])
        );
        assert!(!prop_names(&v).contains("raw_image"));
        assert!(!prop_names(&v).contains("image_path"));
        assert!(!prop_names(&v).contains("email_body"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }

    #[test]
    fn bookkeeping_review_reason_param_schema_is_closed() {
        // deny_unknown_fields does not inherit to nested structs — lock it explicitly.
        let v = serde_json::to_value(schemars::schema_for!(BookkeepingReviewReasonParam)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "BookkeepingReviewReasonParam must be a closed schema"
        );
        assert_eq!(prop_names(&v), expect(&["code", "detail"]));
        assert_eq!(required_fields(&v), expect(&["code"]));
    }

    #[test]
    fn bookkeeping_line_item_param_schema_is_closed() {
        let v = serde_json::to_value(schemars::schema_for!(BookkeepingLineItemParam)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "BookkeepingLineItemParam must be a closed schema"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["name", "amount_minor", "quantity", "category_code"])
        );
        assert_eq!(required_fields(&v), expect(&["name", "amount_minor"]));
    }

    #[test]
    fn bookkeeping_read_tool_params_are_closed_schemas() {
        let list = serde_json::to_value(schemars::schema_for!(BookkeepingListParams)).unwrap();
        assert_eq!(list["additionalProperties"], serde_json::json!(false));
        assert_eq!(prop_names(&list), expect(&["project_id", "limit"]));

        let summary =
            serde_json::to_value(schemars::schema_for!(BookkeepingMonthlySummaryParams)).unwrap();
        assert_eq!(summary["additionalProperties"], serde_json::json!(false));
        assert_eq!(prop_names(&summary), expect(&["month", "project_id"]));
        assert_eq!(required_fields(&summary), expect(&["month"]));

        let find =
            serde_json::to_value(schemars::schema_for!(BookkeepingFindDuplicateParams)).unwrap();
        assert_eq!(find["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&find),
            expect(&[
                "project_id",
                "spent_at",
                "amount_minor",
                "merchant",
                "order_no",
                "payment_no",
                "source_ref",
                "exclude_transaction_id",
            ])
        );

        let mark =
            serde_json::to_value(schemars::schema_for!(BookkeepingMarkDuplicateParams)).unwrap();
        assert_eq!(mark["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&mark),
            expect(&["transaction_id", "duplicate_of_transaction_id"])
        );
        // Read-tool params never carry raw_sql / shell / url / token fields.
        for forbidden in ["raw_sql", "url", "command", "token", "credential_ref"] {
            assert!(!prop_names(&find).contains(forbidden));
            assert!(!prop_names(&list).contains(forbidden));
        }
    }

    #[test]
    fn gmail_send_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(GmailSendParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "GmailSendParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(
            prop_names(&v),
            expect(&["project_id", "to", "subject", "body"])
        );
        assert_eq!(
            required_fields(&v),
            expect(&["project_id", "to", "subject", "body"])
        );
        // proposer는 raw project_ref/credential_ref를 줄 수 없다(#11) — 표면에 없음을 고정.
        assert!(!prop_names(&v).contains("project_ref"));
        assert!(!prop_names(&v).contains("credential_ref"));
    }
}
