use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::mcp::enum_wire_string;
use crate::mcp::tools::bookkeeping_transactions::{
    BookkeepingExpenseKindParam, BookkeepingPaymentMethodParam,
};
use crate::models::{
    BookkeepingRecurringExpenseStatus, BookkeepingRecurringOccurrence,
    BookkeepingRecurringOccurrenceStatus,
};

const TEXT_MAX_CHARS: usize = 500;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingCreateRecurringExpenseParams {
    pub project_id: Option<String>,
    pub name: String,
    pub merchant: Option<String>,
    pub amount_minor: i32,
    pub currency: Option<String>,
    pub category: String,
    pub payment_method_kind: BookkeepingPaymentMethodParam,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: BookkeepingExpenseKindParam,
    pub schedule_day: i32,
    pub start_month: String,
    pub end_month: Option<String>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingRecurringScopeParams {
    pub month: String,
    pub project_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingRecurringOccurrenceIdParams {
    pub id: String,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BookkeepingRecurringExpenseStatusParam {
    Active,
    Paused,
    Archived,
}

impl From<BookkeepingRecurringExpenseStatusParam> for BookkeepingRecurringExpenseStatus {
    fn from(value: BookkeepingRecurringExpenseStatusParam) -> Self {
        match value {
            BookkeepingRecurringExpenseStatusParam::Active => Self::Active,
            BookkeepingRecurringExpenseStatusParam::Paused => Self::Paused,
            BookkeepingRecurringExpenseStatusParam::Archived => Self::Archived,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingRecurringExpenseStatusParams {
    pub id: String,
    pub status: BookkeepingRecurringExpenseStatusParam,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BookkeepingRecurringOccurrenceStatusParam {
    Planned,
    Posted,
    Skipped,
}

impl From<BookkeepingRecurringOccurrenceStatusParam> for BookkeepingRecurringOccurrenceStatus {
    fn from(value: BookkeepingRecurringOccurrenceStatusParam) -> Self {
        match value {
            BookkeepingRecurringOccurrenceStatusParam::Planned => Self::Planned,
            BookkeepingRecurringOccurrenceStatusParam::Posted => Self::Posted,
            BookkeepingRecurringOccurrenceStatusParam::Skipped => Self::Skipped,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingRecurringOccurrenceStatusParams {
    pub id: String,
    pub status: BookkeepingRecurringOccurrenceStatusParam,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingRecurringExpenseWriteDto {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingRecurringOccurrenceDto {
    pub id: String,
    pub recurring_expense_id: String,
    pub recurring_name: String,
    pub month: String,
    pub due_date: String,
    pub amount_minor: i32,
    pub currency: String,
    pub status: String,
    pub transaction_id: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingRecurringOccurrenceListDto {
    pub occurrences: Vec<BookkeepingRecurringOccurrenceDto>,
}

pub(crate) fn occurrence_dto(
    row: BookkeepingRecurringOccurrence,
) -> BookkeepingRecurringOccurrenceDto {
    BookkeepingRecurringOccurrenceDto {
        id: row.id,
        recurring_expense_id: row.recurring_expense_id,
        recurring_name: row.recurring_name,
        month: row.month,
        due_date: row.due_date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        status: enum_wire_string(&row.status),
        transaction_id: row.transaction_id,
    }
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_text(field: &str, value: Option<&str>) -> Result<(), rmcp::ErrorData> {
    if value.is_some_and(|text| text.chars().count() > TEXT_MAX_CHARS) {
        return Err(rmcp::ErrorData::invalid_params(
            format!("{field} exceeds {TEXT_MAX_CHARS} characters"),
            None,
        ));
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_scope(p: &BookkeepingRecurringScopeParams) -> Result<(), rmcp::ErrorData> {
    validate_text("month", Some(&p.month))?;
    validate_text("project_id", p.project_id.as_deref())
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_create(
    p: &BookkeepingCreateRecurringExpenseParams,
) -> Result<(), rmcp::ErrorData> {
    for (field, value) in [
        ("project_id", p.project_id.as_deref()),
        ("name", Some(p.name.as_str())),
        ("merchant", p.merchant.as_deref()),
        ("currency", p.currency.as_deref()),
        ("category", Some(p.category.as_str())),
        ("payment_method_label", p.payment_method_label.as_deref()),
        ("payment_method_last4", p.payment_method_last4.as_deref()),
        ("note", p.note.as_deref()),
        ("start_month", Some(p.start_month.as_str())),
        ("end_month", p.end_month.as_deref()),
    ] {
        validate_text(field, value)?;
    }
    Ok(())
}
