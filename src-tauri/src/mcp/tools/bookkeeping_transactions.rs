use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};

use crate::commands::bookkeeping as bookkeeping_commands;
use crate::mcp::tools::bookkeeping::{to_transaction_dto, BookkeepingTransactionDto};
use crate::mcp::{enum_wire_string, mcp_tool_error, WrServer};
use crate::models::{
    BookkeepingDirection, CreateBookkeepingLineItemInput, SetBookkeepingLineItemsInput,
    UpdateBookkeepingTransactionInput,
};

const LINE_ITEMS_MAX: usize = 200;

mod types;
pub use types::*;

#[tool_router(router = tool_router_bookkeeping_transactions, vis = "pub(crate)")]
impl WrServer {
    #[tool(
        name = "wr_bookkeeping_update_transaction",
        description = "Update editable fields on an existing local bookkeeping transaction."
    )]
    pub async fn bookkeeping_update_transaction(
        &self,
        Parameters(p): Parameters<BookkeepingUpdateTransactionParams>,
    ) -> Result<Json<BookkeepingTransactionDto>, rmcp::ErrorData> {
        self.bookkeeping_update_transaction_inner(p).await
    }

    pub(crate) async fn bookkeeping_update_transaction_inner(
        &self,
        p: BookkeepingUpdateTransactionParams,
    ) -> Result<Json<BookkeepingTransactionDto>, rmcp::ErrorData> {
        validate_update(&p)?;
        let direction = p
            .direction
            .map(|value| enum_wire_string(&BookkeepingDirection::from(value)));
        let row = bookkeeping_commands::update_bookkeeping_transaction_inner(
            &self.db,
            UpdateBookkeepingTransactionInput {
                id: p.id,
                merchant: p.merchant,
                description: p.description,
                amount_minor: p.amount_minor,
                currency: p.currency,
                spent_at: p.spent_at,
                spent_at_time: p.spent_at_time.map(Some),
                direction,
                note: p.note,
                account: p.account,
                category_code: p.category_code,
                subcategory_code: p.subcategory_code,
                payment_method_kind: p.payment_method_kind.map(Into::into),
                payment_method_label: p.payment_method_label,
                payment_method_last4: p.payment_method_last4,
                expense_kind: p.expense_kind.map(Into::into),
                order_no: p.order_no,
                payment_no: p.payment_no,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_update_transaction", &e))?;
        Ok(Json(to_transaction_dto(row)))
    }

    #[tool(
        name = "wr_bookkeeping_set_review_status",
        description = "Set a local transaction review status to needs_review, approved, or ignored."
    )]
    pub async fn bookkeeping_set_review_status(
        &self,
        Parameters(p): Parameters<BookkeepingReviewDecisionParams>,
    ) -> Result<Json<BookkeepingTransactionDto>, rmcp::ErrorData> {
        self.bookkeeping_set_review_status_inner(p).await
    }

    pub(crate) async fn bookkeeping_set_review_status_inner(
        &self,
        p: BookkeepingReviewDecisionParams,
    ) -> Result<Json<BookkeepingTransactionDto>, rmcp::ErrorData> {
        validate_text_bound("id", Some(&p.id))?;
        let row = bookkeeping_commands::update_bookkeeping_review_status_inner(
            &self.db,
            &p.id,
            p.status.into(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_set_review_status", &e))?;
        Ok(Json(to_transaction_dto(row)))
    }

    #[tool(
        name = "wr_bookkeeping_list_trash",
        description = "List soft-deleted or ignored transactions in the local finance ledger."
    )]
    pub async fn bookkeeping_list_trash(
        &self,
        Parameters(p): Parameters<BookkeepingTrashScopeParams>,
    ) -> Result<Json<BookkeepingTrashListDto>, rmcp::ErrorData> {
        validate_text_bound("project_id", p.project_id.as_deref())?;
        let rows =
            bookkeeping_commands::list_bookkeeping_trash_inner(&self.db, p.project_id.as_deref())
                .await
                .map_err(|e| mcp_tool_error("wr_bookkeeping_list_trash", &e))?;
        let truncated = rows.len() == 200;
        Ok(Json(BookkeepingTrashListDto {
            transactions: rows.into_iter().map(to_transaction_dto).collect(),
            truncated,
        }))
    }

    #[tool(
        name = "wr_bookkeeping_trash_transaction",
        description = "Soft-delete a local bookkeeping transaction so it can be restored later."
    )]
    pub async fn bookkeeping_trash_transaction(
        &self,
        Parameters(p): Parameters<BookkeepingTransactionIdParams>,
    ) -> Result<Json<BookkeepingTransactionStateDto>, rmcp::ErrorData> {
        self.bookkeeping_trash_transaction_inner(p).await
    }

    pub(crate) async fn bookkeeping_trash_transaction_inner(
        &self,
        p: BookkeepingTransactionIdParams,
    ) -> Result<Json<BookkeepingTransactionStateDto>, rmcp::ErrorData> {
        validate_text_bound("id", Some(&p.id))?;
        let row = bookkeeping_commands::delete_bookkeeping_transaction_inner(&self.db, &p.id)
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_trash_transaction", &e))?;
        Ok(Json(transaction_state(row)))
    }

    #[tool(
        name = "wr_bookkeeping_restore_transaction",
        description = "Restore a soft-deleted local bookkeeping transaction."
    )]
    pub async fn bookkeeping_restore_transaction(
        &self,
        Parameters(p): Parameters<BookkeepingTransactionIdParams>,
    ) -> Result<Json<BookkeepingTransactionStateDto>, rmcp::ErrorData> {
        self.bookkeeping_restore_transaction_inner(p).await
    }

    pub(crate) async fn bookkeeping_restore_transaction_inner(
        &self,
        p: BookkeepingTransactionIdParams,
    ) -> Result<Json<BookkeepingTransactionStateDto>, rmcp::ErrorData> {
        validate_text_bound("id", Some(&p.id))?;
        let row = bookkeeping_commands::restore_bookkeeping_transaction_inner(&self.db, &p.id)
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_restore_transaction", &e))?;
        Ok(Json(transaction_state(row)))
    }

    #[tool(
        name = "wr_bookkeeping_set_line_items",
        description = "Replace the itemized lines for a local bookkeeping transaction and recompute mismatch review reasons."
    )]
    pub async fn bookkeeping_set_line_items(
        &self,
        Parameters(p): Parameters<BookkeepingSetLineItemsParams>,
    ) -> Result<Json<BookkeepingLineItemsWriteDto>, rmcp::ErrorData> {
        self.bookkeeping_set_line_items_inner(p).await
    }

    pub(crate) async fn bookkeeping_set_line_items_inner(
        &self,
        p: BookkeepingSetLineItemsParams,
    ) -> Result<Json<BookkeepingLineItemsWriteDto>, rmcp::ErrorData> {
        validate_text_bound("transaction_id", Some(&p.transaction_id))?;
        if p.items.len() > LINE_ITEMS_MAX {
            return Err(rmcp::ErrorData::invalid_params(
                format!("items exceeds {LINE_ITEMS_MAX} entries"),
                None,
            ));
        }
        for item in &p.items {
            validate_text_bound("items.name", Some(&item.name))?;
            validate_text_bound("items.category_code", item.category_code.as_deref())?;
        }
        let input = SetBookkeepingLineItemsInput {
            transaction_id: p.transaction_id.clone(),
            items: p
                .items
                .into_iter()
                .map(|item| CreateBookkeepingLineItemInput {
                    name: item.name,
                    amount_minor: item.amount_minor,
                    quantity: item.quantity,
                    category_code: item.category_code,
                })
                .collect(),
        };
        let rows = bookkeeping_commands::set_bookkeeping_line_items_inner(&self.db, input)
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_set_line_items", &e))?;
        Ok(Json(BookkeepingLineItemsWriteDto {
            transaction_id: p.transaction_id,
            item_count: rows.len(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_list_line_items",
        description = "List itemized lines for a local bookkeeping transaction."
    )]
    pub async fn bookkeeping_list_line_items(
        &self,
        Parameters(p): Parameters<BookkeepingTransactionIdParams>,
    ) -> Result<Json<BookkeepingLineItemsDto>, rmcp::ErrorData> {
        validate_text_bound("id", Some(&p.id))?;
        self.bookkeeping_list_line_items_inner(p).await
    }

    pub(crate) async fn bookkeeping_list_line_items_inner(
        &self,
        p: BookkeepingTransactionIdParams,
    ) -> Result<Json<BookkeepingLineItemsDto>, rmcp::ErrorData> {
        let rows = bookkeeping_commands::list_bookkeeping_line_items_inner(&self.db, &p.id)
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_list_line_items", &e))?;
        Ok(Json(BookkeepingLineItemsDto {
            transaction_id: p.id,
            items: rows.into_iter().map(BookkeepingLineItemDto::from).collect(),
        }))
    }
}
