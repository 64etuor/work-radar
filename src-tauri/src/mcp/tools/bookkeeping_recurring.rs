use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};

use crate::commands::bookkeeping as bookkeeping_commands;
use crate::mcp::{enum_wire_string, mcp_tool_error, WrServer};
use crate::models::CreateBookkeepingRecurringExpenseInput;

mod types;
pub use types::*;

#[tool_router(router = tool_router_bookkeeping_recurring, vis = "pub(crate)")]
impl WrServer {
    #[tool(
        name = "wr_bookkeeping_create_recurring_expense",
        description = "Create a recurring expense rule in the local finance ledger."
    )]
    pub async fn bookkeeping_create_recurring_expense(
        &self,
        Parameters(p): Parameters<BookkeepingCreateRecurringExpenseParams>,
    ) -> Result<Json<BookkeepingRecurringExpenseWriteDto>, rmcp::ErrorData> {
        self.bookkeeping_create_recurring_expense_inner(p).await
    }

    pub(crate) async fn bookkeeping_create_recurring_expense_inner(
        &self,
        p: BookkeepingCreateRecurringExpenseParams,
    ) -> Result<Json<BookkeepingRecurringExpenseWriteDto>, rmcp::ErrorData> {
        validate_create(&p)?;
        let row = bookkeeping_commands::create_bookkeeping_recurring_expense_inner(
            &self.db,
            CreateBookkeepingRecurringExpenseInput {
                project_id: p.project_id,
                name: p.name,
                merchant: p.merchant,
                amount_minor: p.amount_minor,
                currency: p.currency.unwrap_or_default(),
                category: p.category,
                payment_method_kind: p.payment_method_kind.into(),
                payment_method_label: p.payment_method_label,
                payment_method_last4: p.payment_method_last4,
                expense_kind: p.expense_kind.into(),
                schedule_day: p.schedule_day,
                start_month: p.start_month,
                end_month: p.end_month,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_create_recurring_expense", &e))?;
        Ok(Json(BookkeepingRecurringExpenseWriteDto {
            id: row.id,
            name: row.name,
            status: enum_wire_string(&row.status),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_set_recurring_expense_status",
        description = "Activate, pause, or archive a recurring expense rule in the local finance ledger."
    )]
    pub async fn bookkeeping_set_recurring_expense_status(
        &self,
        Parameters(p): Parameters<BookkeepingRecurringExpenseStatusParams>,
    ) -> Result<Json<BookkeepingRecurringExpenseWriteDto>, rmcp::ErrorData> {
        self.bookkeeping_set_recurring_expense_status_inner(p).await
    }

    pub(crate) async fn bookkeeping_set_recurring_expense_status_inner(
        &self,
        p: BookkeepingRecurringExpenseStatusParams,
    ) -> Result<Json<BookkeepingRecurringExpenseWriteDto>, rmcp::ErrorData> {
        validate_text("id", Some(&p.id))?;
        let row = bookkeeping_commands::set_bookkeeping_recurring_expense_status_inner(
            &self.db,
            &p.id,
            p.status.into(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_set_recurring_expense_status", &e))?;
        Ok(Json(BookkeepingRecurringExpenseWriteDto {
            id: row.id,
            name: row.name,
            status: enum_wire_string(&row.status),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_list_recurring_occurrences",
        description = "List recurring expense occurrences for a month in the local finance ledger."
    )]
    pub async fn bookkeeping_list_recurring_occurrences(
        &self,
        Parameters(p): Parameters<BookkeepingRecurringScopeParams>,
    ) -> Result<Json<BookkeepingRecurringOccurrenceListDto>, rmcp::ErrorData> {
        validate_scope(&p)?;
        let rows = bookkeeping_commands::list_bookkeeping_recurring_occurrences_inner(
            &self.db,
            &p.month,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_list_recurring_occurrences", &e))?;
        Ok(Json(BookkeepingRecurringOccurrenceListDto {
            occurrences: rows.into_iter().map(occurrence_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_ensure_recurring_occurrences",
        description = "Materialize missing recurring expense occurrences for a month in the local finance ledger."
    )]
    pub async fn bookkeeping_ensure_recurring_occurrences(
        &self,
        Parameters(p): Parameters<BookkeepingRecurringScopeParams>,
    ) -> Result<Json<BookkeepingRecurringOccurrenceListDto>, rmcp::ErrorData> {
        self.bookkeeping_ensure_recurring_occurrences_inner(p).await
    }

    pub(crate) async fn bookkeeping_ensure_recurring_occurrences_inner(
        &self,
        p: BookkeepingRecurringScopeParams,
    ) -> Result<Json<BookkeepingRecurringOccurrenceListDto>, rmcp::ErrorData> {
        validate_scope(&p)?;
        let rows = bookkeeping_commands::ensure_bookkeeping_recurring_occurrences_inner(
            &self.db,
            &p.month,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_ensure_recurring_occurrences", &e))?;
        Ok(Json(BookkeepingRecurringOccurrenceListDto {
            occurrences: rows.into_iter().map(occurrence_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_post_recurring_occurrence",
        description = "Post a planned recurring occurrence as an approved local bookkeeping transaction."
    )]
    pub async fn bookkeeping_post_recurring_occurrence(
        &self,
        Parameters(p): Parameters<BookkeepingRecurringOccurrenceIdParams>,
    ) -> Result<Json<BookkeepingRecurringOccurrenceDto>, rmcp::ErrorData> {
        validate_text("id", Some(&p.id))?;
        let row =
            bookkeeping_commands::post_bookkeeping_recurring_occurrence_inner(&self.db, &p.id)
                .await
                .map_err(|e| mcp_tool_error("wr_bookkeeping_post_recurring_occurrence", &e))?;
        Ok(Json(occurrence_dto(row)))
    }

    #[tool(
        name = "wr_bookkeeping_set_recurring_occurrence_status",
        description = "Set a recurring occurrence to planned, posted, or skipped in the local finance ledger."
    )]
    pub async fn bookkeeping_set_recurring_occurrence_status(
        &self,
        Parameters(p): Parameters<BookkeepingRecurringOccurrenceStatusParams>,
    ) -> Result<Json<BookkeepingRecurringOccurrenceDto>, rmcp::ErrorData> {
        self.bookkeeping_set_recurring_occurrence_status_inner(p)
            .await
    }

    pub(crate) async fn bookkeeping_set_recurring_occurrence_status_inner(
        &self,
        p: BookkeepingRecurringOccurrenceStatusParams,
    ) -> Result<Json<BookkeepingRecurringOccurrenceDto>, rmcp::ErrorData> {
        validate_text("id", Some(&p.id))?;
        let row = bookkeeping_commands::set_bookkeeping_recurring_occurrence_status_inner(
            &self.db,
            &p.id,
            p.status.into(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_set_recurring_occurrence_status", &e))?;
        Ok(Json(occurrence_dto(row)))
    }
}
