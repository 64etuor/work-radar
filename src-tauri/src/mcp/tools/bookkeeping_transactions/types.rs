use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::mcp::enum_wire_string;
use crate::mcp::tools::bookkeeping::{BookkeepingLineItemParam, BookkeepingTransactionDto};
use crate::models::{
    BookkeepingDirection, BookkeepingExpenseKind, BookkeepingLineItem,
    BookkeepingPaymentMethodKind, BookkeepingReviewStatus,
};

const TEXT_MAX_CHARS: usize = 500;

#[allow(clippy::result_large_err)]
pub(crate) fn validate_text_bound(field: &str, value: Option<&str>) -> Result<(), rmcp::ErrorData> {
    if value.is_some_and(|text| text.chars().count() > TEXT_MAX_CHARS) {
        return Err(rmcp::ErrorData::invalid_params(
            format!("{field} exceeds {TEXT_MAX_CHARS} characters"),
            None,
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BookkeepingDirectionParam {
    Expense,
    Income,
}

impl From<BookkeepingDirectionParam> for BookkeepingDirection {
    fn from(value: BookkeepingDirectionParam) -> Self {
        match value {
            BookkeepingDirectionParam::Expense => Self::Expense,
            BookkeepingDirectionParam::Income => Self::Income,
        }
    }
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BookkeepingPaymentMethodParam {
    Unknown,
    Cash,
    Card,
    BankTransfer,
    SimplePay,
}

impl From<BookkeepingPaymentMethodParam> for BookkeepingPaymentMethodKind {
    fn from(value: BookkeepingPaymentMethodParam) -> Self {
        match value {
            BookkeepingPaymentMethodParam::Unknown => Self::Unknown,
            BookkeepingPaymentMethodParam::Cash => Self::Cash,
            BookkeepingPaymentMethodParam::Card => Self::Card,
            BookkeepingPaymentMethodParam::BankTransfer => Self::BankTransfer,
            BookkeepingPaymentMethodParam::SimplePay => Self::SimplePay,
        }
    }
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BookkeepingExpenseKindParam {
    Variable,
    Fixed,
    Subscription,
    Installment,
}

impl From<BookkeepingExpenseKindParam> for BookkeepingExpenseKind {
    fn from(value: BookkeepingExpenseKindParam) -> Self {
        match value {
            BookkeepingExpenseKindParam::Variable => Self::Variable,
            BookkeepingExpenseKindParam::Fixed => Self::Fixed,
            BookkeepingExpenseKindParam::Subscription => Self::Subscription,
            BookkeepingExpenseKindParam::Installment => Self::Installment,
        }
    }
}

#[derive(Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingUpdateTransactionParams {
    pub id: String,
    pub merchant: Option<String>,
    pub description: Option<String>,
    pub amount_minor: Option<i32>,
    pub currency: Option<String>,
    pub spent_at: Option<String>,
    pub spent_at_time: Option<String>,
    pub direction: Option<BookkeepingDirectionParam>,
    pub note: Option<String>,
    pub account: Option<String>,
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    pub payment_method_kind: Option<BookkeepingPaymentMethodParam>,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: Option<BookkeepingExpenseKindParam>,
    pub order_no: Option<String>,
    pub payment_no: Option<String>,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BookkeepingReviewStatusParam {
    NeedsReview,
    Approved,
    Ignored,
}

impl From<BookkeepingReviewStatusParam> for BookkeepingReviewStatus {
    fn from(value: BookkeepingReviewStatusParam) -> Self {
        match value {
            BookkeepingReviewStatusParam::NeedsReview => Self::NeedsReview,
            BookkeepingReviewStatusParam::Approved => Self::Approved,
            BookkeepingReviewStatusParam::Ignored => Self::Ignored,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingReviewDecisionParams {
    pub id: String,
    pub status: BookkeepingReviewStatusParam,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingTransactionIdParams {
    pub id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingTrashScopeParams {
    pub project_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingSetLineItemsParams {
    pub transaction_id: String,
    pub items: Vec<BookkeepingLineItemParam>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingTransactionStateDto {
    pub transaction_id: String,
    pub review_status: String,
    pub trashed: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingTrashListDto {
    pub transactions: Vec<BookkeepingTransactionDto>,
    pub truncated: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingLineItemsWriteDto {
    pub transaction_id: String,
    pub item_count: usize,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingLineItemDto {
    pub id: String,
    pub transaction_id: String,
    pub name: String,
    pub amount_minor: i32,
    pub quantity: i32,
    pub category_code: Option<String>,
    pub sort_order: i32,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingLineItemsDto {
    pub transaction_id: String,
    pub items: Vec<BookkeepingLineItemDto>,
}

impl From<BookkeepingLineItem> for BookkeepingLineItemDto {
    fn from(row: BookkeepingLineItem) -> Self {
        Self {
            id: row.id,
            transaction_id: row.transaction_id,
            name: row.name,
            amount_minor: row.amount_minor,
            quantity: row.quantity,
            category_code: row.category_code,
            sort_order: row.sort_order,
        }
    }
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_update(
    p: &BookkeepingUpdateTransactionParams,
) -> Result<(), rmcp::ErrorData> {
    for (field, value) in [
        ("id", Some(p.id.as_str())),
        ("merchant", p.merchant.as_deref()),
        ("description", p.description.as_deref()),
        ("currency", p.currency.as_deref()),
        ("spent_at", p.spent_at.as_deref()),
        ("spent_at_time", p.spent_at_time.as_deref()),
        ("note", p.note.as_deref()),
        ("account", p.account.as_deref()),
        ("category_code", p.category_code.as_deref()),
        ("subcategory_code", p.subcategory_code.as_deref()),
        ("payment_method_label", p.payment_method_label.as_deref()),
        ("payment_method_last4", p.payment_method_last4.as_deref()),
        ("order_no", p.order_no.as_deref()),
        ("payment_no", p.payment_no.as_deref()),
    ] {
        validate_text_bound(field, value)?;
    }
    Ok(())
}

pub(crate) fn transaction_state(
    row: crate::models::BookkeepingTransaction,
) -> BookkeepingTransactionStateDto {
    BookkeepingTransactionStateDto {
        transaction_id: row.id,
        review_status: enum_wire_string(&row.review_status),
        trashed: row.deleted_at.is_some(),
    }
}
