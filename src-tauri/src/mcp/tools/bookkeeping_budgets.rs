use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::bookkeeping as bookkeeping_commands;
use crate::mcp::{mcp_tool_error, WrServer};
use crate::models::SetBookkeepingBudgetInput;

const TEXT_MAX_CHARS: usize = 500;

#[allow(clippy::result_large_err)]
fn validate_text(field: &str, value: Option<&str>) -> Result<(), rmcp::ErrorData> {
    if value.is_some_and(|text| text.chars().count() > TEXT_MAX_CHARS) {
        return Err(rmcp::ErrorData::invalid_params(
            format!("{field} exceeds {TEXT_MAX_CHARS} characters"),
            None,
        ));
    }
    Ok(())
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingSetBudgetParams {
    pub project_id: Option<String>,
    pub month: String,
    pub category_code: String,
    pub limit_minor: i32,
    pub currency: Option<String>,
    pub rollover: bool,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingBudgetIdParams {
    pub id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BookkeepingBudgetScopeParams {
    pub project_id: Option<String>,
    pub month: String,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingBudgetDto {
    pub id: String,
    pub project_id: Option<String>,
    pub month: String,
    pub category_code: String,
    pub limit_minor: i32,
    pub currency: String,
    pub rollover: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingRemoveBudgetDto {
    pub budget_id: String,
    pub removed: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct BookkeepingBudgetListDto {
    pub budgets: Vec<BookkeepingBudgetDto>,
}

#[tool_router(router = tool_router_bookkeeping_budgets, vis = "pub(crate)")]
impl WrServer {
    #[tool(
        name = "wr_bookkeeping_list_budgets",
        description = "List monthly category budgets with stable IDs for later updates or removal."
    )]
    pub async fn bookkeeping_list_budgets(
        &self,
        Parameters(p): Parameters<BookkeepingBudgetScopeParams>,
    ) -> Result<Json<BookkeepingBudgetListDto>, rmcp::ErrorData> {
        self.bookkeeping_list_budgets_inner(p).await
    }

    pub(crate) async fn bookkeeping_list_budgets_inner(
        &self,
        p: BookkeepingBudgetScopeParams,
    ) -> Result<Json<BookkeepingBudgetListDto>, rmcp::ErrorData> {
        validate_text("project_id", p.project_id.as_deref())?;
        validate_text("month", Some(&p.month))?;
        let rows = bookkeeping_commands::list_bookkeeping_budgets_inner(
            &self.db,
            &p.month,
            p.project_id.as_deref(),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_list_budgets", &e))?;
        Ok(Json(BookkeepingBudgetListDto {
            budgets: rows
                .into_iter()
                .map(|row| BookkeepingBudgetDto {
                    id: row.id,
                    project_id: row.project_id,
                    month: row.month,
                    category_code: row.category_code,
                    limit_minor: row.limit_minor,
                    currency: row.currency,
                    rollover: row.rollover,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_bookkeeping_set_budget",
        description = "Create or replace a monthly category budget in the local finance ledger."
    )]
    pub async fn bookkeeping_set_budget(
        &self,
        Parameters(p): Parameters<BookkeepingSetBudgetParams>,
    ) -> Result<Json<BookkeepingBudgetDto>, rmcp::ErrorData> {
        self.bookkeeping_set_budget_inner(p).await
    }

    pub(crate) async fn bookkeeping_set_budget_inner(
        &self,
        p: BookkeepingSetBudgetParams,
    ) -> Result<Json<BookkeepingBudgetDto>, rmcp::ErrorData> {
        for (field, value) in [
            ("project_id", p.project_id.as_deref()),
            ("month", Some(p.month.as_str())),
            ("category_code", Some(p.category_code.as_str())),
            ("currency", p.currency.as_deref()),
            ("note", p.note.as_deref()),
        ] {
            validate_text(field, value)?;
        }
        let row = bookkeeping_commands::set_bookkeeping_budget_inner(
            &self.db,
            SetBookkeepingBudgetInput {
                project_id: p.project_id,
                month: p.month,
                category_code: p.category_code,
                limit_minor: p.limit_minor,
                currency: p.currency,
                rollover: p.rollover,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_bookkeeping_set_budget", &e))?;
        Ok(Json(BookkeepingBudgetDto {
            id: row.id,
            project_id: row.project_id,
            month: row.month,
            category_code: row.category_code,
            limit_minor: row.limit_minor,
            currency: row.currency,
            rollover: row.rollover,
        }))
    }

    #[tool(
        name = "wr_bookkeeping_remove_budget",
        description = "Remove a monthly category budget from the local finance ledger."
    )]
    pub async fn bookkeeping_remove_budget(
        &self,
        Parameters(p): Parameters<BookkeepingBudgetIdParams>,
    ) -> Result<Json<BookkeepingRemoveBudgetDto>, rmcp::ErrorData> {
        validate_text("id", Some(&p.id))?;
        self.bookkeeping_remove_budget_inner(p).await
    }

    pub(crate) async fn bookkeeping_remove_budget_inner(
        &self,
        p: BookkeepingBudgetIdParams,
    ) -> Result<Json<BookkeepingRemoveBudgetDto>, rmcp::ErrorData> {
        let removed = bookkeeping_commands::delete_bookkeeping_budget_inner(&self.db, &p.id)
            .await
            .map_err(|e| mcp_tool_error("wr_bookkeeping_remove_budget", &e))?;
        Ok(Json(BookkeepingRemoveBudgetDto {
            budget_id: p.id,
            removed,
        }))
    }
}
