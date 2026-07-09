//! 가계부 툴 — 로컬 SQLite 표면(외부 서비스 호출 아님).
//!
//! READ/WRITE 모두 모든 MCP caller에 개방(ADR-0012). 로컬 DB write는 Acceptance 게이트 대상이
//! 아니고(decision-rails INVARIANT #2), caller env는 흉내 가능해 게이트로서 실질 보안을 더하지
//! 않았다 — 사람 게이트는 각 MCP 호스트의 승인 UI다.
//!
//! DTO는 sanitized: 소스 원문 `description`, raw email body, 토큰은 **타입에 존재하지 않는다**
//! (mcp-server-conventions §6/§7 최소권한).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::bookkeeping as bookkeeping_commands;
use crate::commands::projects;
use crate::error::AppError;
use crate::mcp::{enum_wire_string, mcp_tool_error, truncate_preview, WrServer};
use crate::models::{
    BookkeepingDirection, BookkeepingExpenseKind, BookkeepingPaymentMethodKind, BookkeepingSource,
    CreateBookkeepingLineItemInput, CreateBookkeepingTransactionInput,
    SetBookkeepingLineItemsInput,
};

/// 고정비 노트 preview 상한(§6 — 장문 echo 금지).
const NOTE_PREVIEW_CHARS: usize = 280;

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

// ── Bookkeeping READ tools ──────────────────────────────────────────────────────────────────────
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

/// 상위 카테고리별 이번 달 예산 집행 상태.
#[derive(Serialize, JsonSchema)]
pub struct BookkeepingBudgetStatusDto {
    pub category_code: String,
    pub label: String,
    pub limit_minor: i32,
    pub spent_minor: i32,
    pub remaining_minor: i32,
    /// 지난달에서 이월된 금액(rollover=true일 때만 0이 아님).
    pub rollover_in_minor: i32,
    pub rollover: bool,
    /// 집행률 0.0..(1.0 초과 가능 — 초과 지출).
    pub pct: f64,
    pub currency: String,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingBudgetStatusListDto {
    pub month: String,
    pub budgets: Vec<BookkeepingBudgetStatusDto>,
}

/// 고정비(반복 지출) 규칙. `source_ref`(MoneyManager 백업 uid)는 내부 식별자라 표면에 없다.
#[derive(Serialize, JsonSchema)]
pub struct BookkeepingRecurringExpenseDto {
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    pub merchant: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub category: String,
    pub payment_method_kind: String,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    /// "fixed" | "variable".
    pub expense_kind: String,
    /// 매월 청구일(1..=31; 월말 클램프).
    pub schedule_day: i32,
    pub start_month: String,
    pub end_month: Option<String>,
    /// "active" | "paused" | "archived".
    pub status: String,
    /// 규칙의 출처("manual" | "moneymanager" 등).
    pub source: String,
    pub note_preview: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingRecurringExpenseListDto {
    pub recurring_expenses: Vec<BookkeepingRecurringExpenseDto>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingProjectScopeParams {
    pub project_id: Option<String>,
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

#[tool_router(router = tool_router_bookkeeping, vis = "pub(crate)")]
impl WrServer {
    /// OCR receipt save — a local bookkeeping row insert/upsert, not an external service mutation.
    /// Open to any MCP caller (ADR-0012): the human gate is the calling host's own approval UI.
    #[tool(
        name = "wr_bookkeeping_save_receipt",
        description = "Save normalized receipt fields into local bookkeeping. Returns only transaction id/status; accepts no raw image, file path, email body, token, or credential fields."
    )]
    pub async fn bookkeeping_save_receipt(
        &self,
        Parameters(p): Parameters<BookkeepingSaveReceiptParams>,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
        self.bookkeeping_save_receipt_inner(p).await
    }

    pub(crate) async fn bookkeeping_save_receipt_inner(
        &self,
        p: BookkeepingSaveReceiptParams,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
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
        self.bookkeeping_list_transactions_inner(p, None).await
    }

    #[tool(
        name = "wr_bookkeeping_list_review_queue",
        description = "List bookkeeping transactions awaiting review (sanitized metadata). Read-only; open to any MCP caller."
    )]
    pub async fn bookkeeping_list_review_queue(
        &self,
        Parameters(p): Parameters<BookkeepingListParams>,
    ) -> Result<Json<BookkeepingTransactionListDto>, rmcp::ErrorData> {
        self.bookkeeping_list_transactions_inner(
            p,
            Some(crate::models::BookkeepingReviewStatus::NeedsReview),
        )
        .await
    }

    pub(crate) async fn bookkeeping_list_transactions_inner(
        &self,
        p: BookkeepingListParams,
        status: Option<crate::models::BookkeepingReviewStatus>,
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
        self.bookkeeping_monthly_summary_inner(p).await
    }

    pub(crate) async fn bookkeeping_monthly_summary_inner(
        &self,
        p: BookkeepingMonthlySummaryParams,
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
        self.bookkeeping_find_duplicate_candidates_inner(p).await
    }

    pub(crate) async fn bookkeeping_find_duplicate_candidates_inner(
        &self,
        p: BookkeepingFindDuplicateParams,
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
        description = "Mark a transaction as a duplicate of another (sets it ignored + links the original). Local review-queue write; open to any MCP caller."
    )]
    pub async fn bookkeeping_mark_duplicate(
        &self,
        Parameters(p): Parameters<BookkeepingMarkDuplicateParams>,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
        self.bookkeeping_mark_duplicate_inner(p).await
    }

    pub(crate) async fn bookkeeping_mark_duplicate_inner(
        &self,
        p: BookkeepingMarkDuplicateParams,
    ) -> Result<Json<BookkeepingSaveReceiptResult>, rmcp::ErrorData> {
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

    #[tool(
        name = "wr_bookkeeping_budget_status",
        description = "Per-category budget limit / spent / remaining for a month (YYYY-MM), including rollover. Read-only."
    )]
    pub async fn bookkeeping_budget_status(
        &self,
        Parameters(p): Parameters<BookkeepingMonthlySummaryParams>,
    ) -> Result<Json<BookkeepingBudgetStatusListDto>, rmcp::ErrorData> {
        self.bookkeeping_budget_status_inner(p).await
    }

    pub(crate) async fn bookkeeping_budget_status_inner(
        &self,
        p: BookkeepingMonthlySummaryParams,
    ) -> Result<Json<BookkeepingBudgetStatusListDto>, rmcp::ErrorData> {
        let rows = bookkeeping_commands::bookkeeping_budget_status_inner(
            &self.db,
            &p.month,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_budget_status", &e))?;
        Ok(Json(BookkeepingBudgetStatusListDto {
            month: p.month,
            budgets: rows
                .into_iter()
                .map(|b| BookkeepingBudgetStatusDto {
                    category_code: b.category_code,
                    label: b.label,
                    limit_minor: b.limit_minor,
                    spent_minor: b.spent_minor,
                    remaining_minor: b.remaining_minor,
                    rollover_in_minor: b.rollover_in_minor,
                    rollover: b.rollover,
                    pct: b.pct,
                    currency: b.currency,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_list_recurring_expenses",
        description = "List recurring (fixed) expense rules: amount, billing day, active window, and status. Read-only."
    )]
    pub async fn bookkeeping_list_recurring_expenses(
        &self,
        Parameters(p): Parameters<BookkeepingProjectScopeParams>,
    ) -> Result<Json<BookkeepingRecurringExpenseListDto>, rmcp::ErrorData> {
        self.bookkeeping_list_recurring_expenses_inner(p).await
    }

    pub(crate) async fn bookkeeping_list_recurring_expenses_inner(
        &self,
        p: BookkeepingProjectScopeParams,
    ) -> Result<Json<BookkeepingRecurringExpenseListDto>, rmcp::ErrorData> {
        let rows = bookkeeping_commands::list_bookkeeping_recurring_expenses_inner(
            &self.db,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_list_recurring_expenses", &e))?;
        Ok(Json(BookkeepingRecurringExpenseListDto {
            recurring_expenses: rows
                .into_iter()
                .map(|r| BookkeepingRecurringExpenseDto {
                    id: r.id,
                    project_id: r.project_id,
                    name: r.name,
                    merchant: r.merchant,
                    amount_minor: r.amount_minor,
                    currency: r.currency,
                    category: r.category,
                    payment_method_kind: enum_wire_string(&r.payment_method_kind),
                    payment_method_label: r.payment_method_label,
                    payment_method_last4: r.payment_method_last4,
                    expense_kind: enum_wire_string(&r.expense_kind),
                    schedule_day: r.schedule_day,
                    start_month: r.start_month,
                    end_month: r.end_month,
                    status: enum_wire_string(&r.status),
                    source: enum_wire_string(&r.source),
                    note_preview: r
                        .note
                        .as_deref()
                        .map(|n| truncate_preview(n, NOTE_PREVIEW_CHARS)),
                })
                .collect(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BookkeepingFindDuplicateParams, BookkeepingLineItemParam, BookkeepingListParams,
        BookkeepingMarkDuplicateParams, BookkeepingMonthlySummaryParams,
        BookkeepingProjectScopeParams, BookkeepingRecurringExpenseDto,
        BookkeepingReviewReasonParam, BookkeepingSaveReceiptParams, BookkeepingTransactionDto,
    };
    use crate::commands::bookkeeping as bookkeeping_commands;
    use crate::commands::shared::test_support::fresh_db;
    use crate::external_actions::store;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::BookkeepingDirection;

    /// OCR receipt save is a local DB write, so it never creates a Work Radar approval proposal.
    /// The saved row still enters the review queue.
    #[tokio::test]
    async fn bookkeeping_save_receipt_writes_local_review_row_without_enqueue() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let res = server
            .bookkeeping_save_receipt_inner(BookkeepingSaveReceiptParams {
                project_id: None,
                source_ref: Some("ocr-001".into()),
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
            })
            .await
            .expect("OCR save");

        assert_eq!(res.0.status, "saved");
        assert!(!res.0.transaction_id.is_empty());
        assert!(
            store::list_pending(&db).await.unwrap().is_empty(),
            "bookkeeping save is local DB write, not external proposal"
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
    /// confidence/reasons/order+payment numbers) and persists it — this is the OCR ingest goal.
    #[tokio::test]
    async fn bookkeeping_save_receipt_persists_widened_judgment_fields() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let mut field_confidence = std::collections::BTreeMap::new();
        field_confidence.insert("amount".to_string(), 0.99_f64);
        field_confidence.insert("merchant".to_string(), 0.6_f64);

        let res = server
            .bookkeeping_save_receipt_inner(BookkeepingSaveReceiptParams {
                project_id: None,
                source_ref: Some("ocr-777".into()),
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
            })
            .await
            .expect("widened save");
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
            .bookkeeping_save_receipt_inner(BookkeepingSaveReceiptParams {
                project_id: None,
                source_ref: Some("ocr-778".into()),
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
            })
            .await;
        assert!(bad.is_err(), "invalid direction rejected");
    }

    /// ADR-0012: 로컬 SQLite read/write는 caller를 가리지 않는다. `WORK_RADAR_MCP_CALLER`는 흉내
    /// 가능한 env라 게이트로서 실질 보안을 더하지 않았고, 사람 게이트는 각 MCP 호스트의 승인 UI다.
    /// 외부 서비스 write의 proposal/direct 분기는 이 변경과 무관하다(surface_tests가 지킨다).
    #[tokio::test]
    async fn bookkeeping_reads_and_local_writes_open_to_any_caller() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let summary = server
            .bookkeeping_monthly_summary_inner(BookkeepingMonthlySummaryParams {
                month: "2026-06".into(),
                project_id: None,
            })
            .await;
        assert!(summary.is_ok(), "summary read is allowed");

        let open_find = server
            .bookkeeping_find_duplicate_candidates_inner(BookkeepingFindDuplicateParams {
                project_id: None,
                spent_at: "2026-06-12".into(),
                amount_minor: 1_000,
                merchant: None,
                order_no: None,
                payment_no: None,
                source_ref: None,
                exclude_transaction_id: None,
            })
            .await;
        assert!(open_find.is_ok(), "find read is allowed");

        // find-duplicate round-trips against a saved row.
        server
            .bookkeeping_save_receipt_inner(BookkeepingSaveReceiptParams {
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
            })
            .await
            .expect("seed save");

        let candidates = server
            .bookkeeping_find_duplicate_candidates_inner(BookkeepingFindDuplicateParams {
                project_id: None,
                spent_at: "2026-06-12".into(),
                amount_minor: 59_010,
                merchant: Some("쿠팡".into()),
                order_no: Some("ORD-DUP".into()),
                payment_no: None,
                source_ref: None,
                exclude_transaction_id: None,
            })
            .await
            .expect("find dup");
        assert!(
            candidates.0.candidates.iter().any(|c| c.score >= 0.9),
            "order_no match scores high"
        );

        // mark_duplicate(로컬 review-queue write)도 caller 게이트 없이 동작한다. 존재하지 않는 행은
        // 여전히 도메인 에러 — 개방은 "검증 없이 통과"가 아니다.
        let missing_mark = server
            .bookkeeping_mark_duplicate_inner(BookkeepingMarkDuplicateParams {
                transaction_id: "a".into(),
                duplicate_of_transaction_id: "b".into(),
            })
            .await;
        assert!(
            missing_mark.is_err(),
            "unknown transaction id still fails validation"
        );

        // 목록을 읽으면 DTO에 내용(note)/자산/시각이 실려온다 — 단 소스 원문 description은
        // sanitized 계약대로 DTO 표면에 없다(타입이 강제).
        let listed = server
            .bookkeeping_list_transactions_inner(
                BookkeepingListParams {
                    project_id: None,
                    limit: Some(10),
                },
                None,
            )
            .await
            .expect("list read");
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

    /// ADR-0012 개방의 **긍정** 증거: caller env 없이도 로컬 review-queue write가 실제로 행을 바꾼다
    /// (부정 단언만 두면 "여전히 막혀 있어도" 테스트가 통과한다).
    #[tokio::test]
    async fn mark_duplicate_links_rows_without_any_caller_gate() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let receipt = |source_ref: &str, order_no: &str| BookkeepingSaveReceiptParams {
            project_id: None,
            source_ref: Some(source_ref.into()),
            merchant: "쿠팡".into(),
            amount_minor: 59_010,
            currency: Some("KRW".into()),
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
            order_no: Some(order_no.into()),
            payment_no: None,
            line_items: None,
        };

        let original = server
            .bookkeeping_save_receipt_inner(receipt("seed-a", "ORD-A"))
            .await
            .expect("original save")
            .0
            .transaction_id;
        let dupe = server
            .bookkeeping_save_receipt_inner(receipt("seed-b", "ORD-B"))
            .await
            .expect("duplicate save")
            .0
            .transaction_id;
        assert_ne!(original, dupe, "distinct source_ref → distinct rows");

        let marked = server
            .bookkeeping_mark_duplicate_inner(BookkeepingMarkDuplicateParams {
                transaction_id: dupe.clone(),
                duplicate_of_transaction_id: original.clone(),
            })
            .await
            .expect("mark duplicate without caller gate");
        assert_eq!(marked.0.status, "marked_duplicate");

        let (review_status, duplicate_of): (String, Option<String>) = sqlx::query_as(
            "SELECT review_status, duplicate_of_transaction_id \
             FROM bookkeeping_transactions WHERE id = ?1",
        )
        .bind(&dupe)
        .fetch_one(&db)
        .await
        .expect("marked row");
        assert_eq!(review_status, "ignored");
        assert_eq!(duplicate_of.as_deref(), Some(original.as_str()));
    }

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

    #[tokio::test]
    async fn budget_status_reports_limit_spent_and_remaining() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        bookkeeping_commands::set_bookkeeping_budget_inner(
            &db,
            crate::models::SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-07".into(),
                category_code: "food".into(),
                limit_minor: 300_000,
                currency: Some("KRW".into()),
                rollover: false,
                note: None,
            },
        )
        .await
        .expect("set budget");

        let out = server
            .bookkeeping_budget_status_inner(BookkeepingMonthlySummaryParams {
                month: "2026-07".into(),
                project_id: None,
            })
            .await
            .expect("budget status")
            .0;
        assert_eq!(out.month, "2026-07");
        let food = out
            .budgets
            .iter()
            .find(|b| b.category_code == "food")
            .expect("food budget row");
        assert_eq!(food.limit_minor, 300_000);
        assert_eq!(food.spent_minor, 0);
        assert_eq!(food.remaining_minor, 300_000);

        // 잘못된 월은 하위 validate_month가 거부한다 — 조용한 빈 목록이 아니다.
        assert!(server
            .bookkeeping_budget_status_inner(BookkeepingMonthlySummaryParams {
                month: "2026-7".into(),
                project_id: None,
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn recurring_expenses_expose_schedule_but_not_source_ref() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        bookkeeping_commands::create_bookkeeping_recurring_expense_inner(
            &db,
            crate::models::CreateBookkeepingRecurringExpenseInput {
                project_id: None,
                name: "넷플릭스".into(),
                merchant: Some("Netflix".into()),
                amount_minor: 17_000,
                currency: "KRW".into(),
                category: "구독".into(),
                payment_method_kind: crate::models::BookkeepingPaymentMethodKind::Card,
                payment_method_label: Some("하나카드".into()),
                payment_method_last4: Some("1234".into()),
                expense_kind: crate::models::BookkeepingExpenseKind::Fixed,
                schedule_day: 15,
                start_month: "2026-07".into(),
                end_month: None,
                note: Some("가족 요금제".into()),
            },
        )
        .await
        .expect("create recurring");

        let out = server
            .bookkeeping_list_recurring_expenses_inner(BookkeepingProjectScopeParams {
                project_id: None,
            })
            .await
            .expect("list recurring")
            .0;
        assert_eq!(out.recurring_expenses.len(), 1);
        let r = &out.recurring_expenses[0];
        assert_eq!(r.name, "넷플릭스");
        assert_eq!(r.amount_minor, 17_000);
        assert_eq!(r.schedule_day, 15);
        assert_eq!(r.status, "active");
        assert_eq!(r.expense_kind, "fixed");
        assert_eq!(r.payment_method_kind, "card");
        assert_eq!(r.note_preview.as_deref(), Some("가족 요금제"));
    }

    #[test]
    fn recurring_expense_dto_hides_internal_identifiers() {
        let v =
            serde_json::to_value(schemars::schema_for!(BookkeepingRecurringExpenseDto)).unwrap();
        // MoneyManager 백업 uid와 타임스탬프는 표면에 없다(§7 최소권한).
        for forbidden in ["source_ref", "created_at", "updated_at"] {
            assert!(
                !prop_names(&v).contains(forbidden),
                "recurring DTO must not expose `{forbidden}`"
            );
        }
        assert!(prop_names(&v).contains("schedule_day"));
        assert!(prop_names(&v).contains("note_preview"));
        assert!(!prop_names(&v).contains("note"), "원문 note 대신 preview만");
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
}
