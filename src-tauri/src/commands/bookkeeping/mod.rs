//! 로컬 가계부 저장소 + IPC 커맨드. 단일 god 파일을 도메인별 서브모듈로 분리(순수 move):
//!   transactions / reporting / budgets / recurring / taxonomy / line_items /
//!   export / dedup / gmail / sync_jobs / audit, 공유 헬퍼는 common. `pub use`로
//!   `commands::*` 경로 + MCP `bookkeeping_commands::` 진입점을 보존한다.

mod audit;
mod budgets;
mod common;
mod dedup;
mod export;
mod gmail;
mod line_items;
mod mmbak;
mod mmbak_options;
mod mmbak_recurring;
mod mmbak_taxonomy;
mod recurring;
mod reporting;
mod sync_jobs;
mod taxonomy;
mod transactions;

pub use audit::*;
pub use budgets::*;
pub(crate) use common::*;
pub use dedup::*;
pub use export::*;
pub use gmail::*;
pub use line_items::*;
pub use mmbak::*;
pub use mmbak_options::*;
pub(crate) use mmbak_recurring::*;
pub(crate) use mmbak_taxonomy::*;
pub use recurring::*;
pub use reporting::*;
pub use sync_jobs::*;
pub use taxonomy::*;
pub use transactions::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bookkeeping::BookkeepingEmailReceiptInput;
    use crate::db::Db;
    use crate::gmail::{
        GmailError, GmailLabelInfo, GmailMessageSearch, GmailReadProvider, GmailReceiptCandidate,
    };
    use crate::models::{
        BookkeepingAliasMatchKind, BookkeepingAliasSource, BookkeepingCashflowInput,
        BookkeepingCategoryTrendInput, BookkeepingDirection, BookkeepingExpenseKind,
        BookkeepingExportFormat, BookkeepingPaymentMethodKind, BookkeepingReconcileAccountInput,
        BookkeepingRecurringOccurrenceStatus, BookkeepingReviewStatus, BookkeepingSource,
        CreateBookkeepingLineItemInput, CreateBookkeepingRecurringExpenseInput,
        CreateBookkeepingTransactionInput, CreateProjectInput, ExportBookkeepingInput,
        FindBookkeepingDuplicateCandidatesInput, OverrideBookkeepingCategoryInput, ProjectKind,
        RecordBookkeepingSyncFailureInput, SetBookkeepingBudgetInput, SetBookkeepingLineItemsInput,
        SyncBookkeepingGmailReceiptsInput, UpdateBookkeepingTransactionInput,
        WriteBookkeepingExportInput,
    };
    use std::sync::Mutex;

    async fn pool() -> Db {
        let p = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("sqlite in-memory");
        sqlx::migrate!("./migrations")
            .run(&p)
            .await
            .expect("migrations");
        p
    }

    fn manual_input(
        merchant: &str,
        amount_minor: i32,
        spent_at: &str,
        category: &str,
    ) -> CreateBookkeepingTransactionInput {
        CreateBookkeepingTransactionInput {
            project_id: None,
            source: BookkeepingSource::Manual,
            source_ref: None,
            merchant: merchant.to_string(),
            description: None,
            amount_minor,
            currency: "KRW".to_string(),
            spent_at: spent_at.to_string(),
            category: category.to_string(),
            note: None,
            payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Variable,
            recurring_expense_id: None,
            recurring_occurrence_id: None,
            direction: BookkeepingDirection::Expense,
            account: None,
            subcategory: None,
            category_code: None,
            subcategory_code: None,
            raw_category: None,
            spent_at_time: None,
            confidence: None,
            field_confidence_json: None,
            review_reasons_json: None,
            order_no: None,
            payment_no: None,
        }
    }

    fn update_input(id: String) -> UpdateBookkeepingTransactionInput {
        UpdateBookkeepingTransactionInput {
            id,
            merchant: None,
            description: None,
            amount_minor: None,
            currency: None,
            spent_at: None,
            spent_at_time: None,
            direction: None,
            note: None,
            account: None,
            category_code: None,
            subcategory_code: None,
            payment_method_kind: None,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: None,
            order_no: None,
            payment_no: None,
        }
    }

    fn recurring_input(
        project_id: Option<String>,
        name: &str,
        amount_minor: i32,
    ) -> CreateBookkeepingRecurringExpenseInput {
        CreateBookkeepingRecurringExpenseInput {
            project_id,
            name: name.to_string(),
            merchant: Some(name.to_string()),
            amount_minor,
            currency: "KRW".to_string(),
            category: "housing".to_string(),
            payment_method_kind: BookkeepingPaymentMethodKind::BankTransfer,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Fixed,
            schedule_day: 25,
            start_month: "2026-06".to_string(),
            end_month: None,
            note: None,
        }
    }

    #[derive(Default)]
    struct FakeGmailReadProvider {
        labels: Vec<GmailLabelInfo>,
        ids: Vec<String>,
        candidates: std::collections::HashMap<String, GmailReceiptCandidate>,
        searches: Mutex<Vec<GmailMessageSearch>>,
    }

    impl GmailReadProvider for FakeGmailReadProvider {
        async fn list_labels(&self, _: &str) -> Result<Vec<GmailLabelInfo>, GmailError> {
            Ok(self.labels.clone())
        }

        async fn list_message_ids(
            &self,
            _: &str,
            search: &GmailMessageSearch,
        ) -> Result<Vec<String>, GmailError> {
            self.searches.lock().expect("searches").push(search.clone());
            Ok(self.ids.clone())
        }

        async fn get_receipt_candidate(
            &self,
            _: &str,
            message_id: &str,
        ) -> Result<GmailReceiptCandidate, GmailError> {
            self.candidates
                .get(message_id)
                .cloned()
                .ok_or_else(|| GmailError::Terminal("not found".into()))
        }
    }

    #[tokio::test]
    async fn manual_create_writes_transaction_and_sanitized_audit() {
        let db = pool().await;

        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Sensitive Store", 12_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        assert_eq!(tx.review_status, BookkeepingReviewStatus::NeedsReview);
        assert_eq!(tx.merchant, "Sensitive Store");

        let audit = list_bookkeeping_audit_inner(&db, Some(tx.id.clone()))
            .await
            .expect("audit list");
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].action, "transaction.created");
        assert!(!audit[0].summary.contains("Sensitive Store"));
    }

    #[tokio::test]
    async fn review_update_appends_audit_without_overwriting_history() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Cafe", 7_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        let reviewed =
            update_bookkeeping_review_status_inner(&db, &tx.id, BookkeepingReviewStatus::Approved)
                .await
                .expect("review update");

        assert_eq!(reviewed.review_status, BookkeepingReviewStatus::Approved);
        assert!(reviewed.reviewed_at.is_some());

        let audit = list_bookkeeping_audit_inner(&db, Some(tx.id))
            .await
            .expect("audit list");
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].action, "transaction.review_status_changed");
        assert_eq!(audit[1].action, "transaction.created");
    }

    #[tokio::test]
    async fn bulk_update_review_status_marks_all_selected() {
        let db = pool().await;
        let mut ids = Vec::new();
        for merchant in ["Cafe", "Books", "Lunch"] {
            let tx = create_bookkeeping_transaction_inner(
                &db,
                manual_input(merchant, 5_000, "2026-06-16", "food"),
            )
            .await
            .expect("create transaction");
            assert_eq!(tx.review_status, BookkeepingReviewStatus::NeedsReview);
            ids.push(tx.id);
        }

        let results = bulk_update_bookkeeping_review_status_inner(
            &db,
            &ids,
            BookkeepingReviewStatus::Approved,
        )
        .await;

        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.ok));
        for id in &ids {
            let row = fetch_bookkeeping_transaction(&db, id)
                .await
                .expect("fetch transaction");
            assert_eq!(row.review_status, BookkeepingReviewStatus::Approved);
        }
    }

    #[tokio::test]
    async fn bulk_update_review_status_is_best_effort_on_bad_id() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Cafe", 5_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        let ids = vec![tx.id.clone(), "nonexistent-id".to_string()];
        let results = bulk_update_bookkeeping_review_status_inner(
            &db,
            &ids,
            BookkeepingReviewStatus::Approved,
        )
        .await;

        assert_eq!(results.len(), 2);
        let good = results
            .iter()
            .find(|r| r.id == tx.id)
            .expect("valid result");
        assert!(good.ok);
        assert!(good.message.is_none());
        let bad = results
            .iter()
            .find(|r| r.id == "nonexistent-id")
            .expect("bad result");
        assert!(!bad.ok);
        assert!(bad.message.is_some());

        // 유효한 항목은 그대로 적용된다(나쁜 id가 배치를 중단시키지 않음).
        let row = fetch_bookkeeping_transaction(&db, &tx.id)
            .await
            .expect("fetch transaction");
        assert_eq!(row.review_status, BookkeepingReviewStatus::Approved);
    }

    #[tokio::test]
    async fn bulk_set_category_routes_each_item_through_override_audit() {
        let db = pool().await;
        let mut ids = Vec::new();
        for merchant in ["Taxi", "Metro"] {
            let tx = create_bookkeeping_transaction_inner(
                &db,
                manual_input(merchant, 5_000, "2026-06-16", "food"),
            )
            .await
            .expect("create transaction");
            ids.push(tx.id);
        }

        let results = bulk_set_bookkeeping_category_inner(
            &db,
            &ids,
            Some("transport"),
            Some("transport_taxi"),
            Some("bulk_triage"),
        )
        .await;

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok));
        for id in &ids {
            let row = fetch_bookkeeping_transaction(&db, id)
                .await
                .expect("fetch transaction");
            assert_eq!(row.category_code.as_deref(), Some("transport"));
            assert_eq!(row.subcategory_code.as_deref(), Some("transport_taxi"));

            let history = list_bookkeeping_category_overrides_inner(&db, id)
                .await
                .expect("override history");
            assert_eq!(history.len(), 1);

            let audit = list_bookkeeping_audit_inner(&db, Some(id.clone()))
                .await
                .expect("audit");
            assert!(audit
                .iter()
                .any(|entry| entry.action == "transaction.category_overridden"));
        }
    }

    #[tokio::test]
    async fn bulk_set_category_is_best_effort_on_bad_id() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Taxi", 5_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        let ids = vec![tx.id.clone(), "missing-category-target".to_string()];
        let results =
            bulk_set_bookkeeping_category_inner(&db, &ids, Some("transport"), None, None).await;

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.id == tx.id && r.ok));
        let bad = results
            .iter()
            .find(|r| r.id == "missing-category-target")
            .expect("missing id result");
        assert!(!bad.ok);
        assert!(bad.message.is_some());
        let row = fetch_bookkeeping_transaction(&db, &tx.id)
            .await
            .expect("fetch transaction");
        assert_eq!(row.category_code.as_deref(), Some("transport"));
    }

    #[tokio::test]
    async fn bulk_delete_transactions_soft_deletes_each_item_best_effort() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Delete Me", 9_500, "2026-06-17", "food"),
        )
        .await
        .expect("create transaction");
        let ids = vec![tx.id.clone(), "missing-delete-target".to_string()];

        let results = bulk_delete_bookkeeping_transactions_inner(&db, &ids).await;

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.id == tx.id && r.ok));
        let bad = results
            .iter()
            .find(|r| r.id == "missing-delete-target")
            .expect("missing id result");
        assert!(!bad.ok);
        assert!(bad.message.is_some());

        let deleted = fetch_bookkeeping_transaction(&db, &tx.id)
            .await
            .expect("fetch transaction");
        assert!(deleted.deleted_at.is_some());
        let main_rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("main list");
        assert!(main_rows.iter().all(|row| row.id != tx.id));
    }

    #[tokio::test]
    async fn soft_delete_moves_transaction_to_trash_and_restore_returns_it_to_lists() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Delete Me", 9_500, "2026-06-17", "food"),
        )
        .await
        .expect("create transaction");

        let deleted = delete_bookkeeping_transaction_inner(&db, &tx.id)
            .await
            .expect("soft delete");
        assert!(deleted.deleted_at.is_some());

        let main_rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("main list");
        assert!(main_rows.iter().all(|row| row.id != tx.id));

        let trash = list_bookkeeping_trash_inner(&db, None)
            .await
            .expect("trash list");
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, tx.id);

        let restored = restore_bookkeeping_transaction_inner(&db, &tx.id)
            .await
            .expect("restore");
        assert!(restored.deleted_at.is_none());

        let main_rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("main list after restore");
        assert!(main_rows.iter().any(|row| row.id == tx.id));
    }

    #[tokio::test]
    async fn update_transaction_persists_fields_validates_input_and_recomputes_sum_mismatch() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Old Merchant", 10_000, "2026-06-17", "misc"),
        )
        .await
        .expect("create transaction");
        set_bookkeeping_line_items_inner(
            &db,
            SetBookkeepingLineItemsInput {
                transaction_id: tx.id.clone(),
                items: vec![CreateBookkeepingLineItemInput {
                    name: "Corrected item".to_string(),
                    amount_minor: 9_000,
                    quantity: Some(1),
                    category_code: None,
                }],
            },
        )
        .await
        .expect("line item mismatch");

        let updated = update_bookkeeping_transaction_inner(
            &db,
            UpdateBookkeepingTransactionInput {
                id: tx.id.clone(),
                merchant: Some("Corrected Merchant".to_string()),
                description: Some("Corrected description".to_string()),
                amount_minor: Some(9_000),
                currency: Some("krw".to_string()),
                spent_at: Some("2026-06-18".to_string()),
                spent_at_time: Some(Some("12:34:56".to_string())),
                direction: Some("income".to_string()),
                note: Some("Reviewed note".to_string()),
                account: Some("하나은행".to_string()),
                category_code: Some("food".to_string()),
                subcategory_code: Some("food_cafe".to_string()),
                payment_method_kind: Some(BookkeepingPaymentMethodKind::Card),
                payment_method_label: Some("개인카드".to_string()),
                payment_method_last4: Some("1234".to_string()),
                expense_kind: Some(BookkeepingExpenseKind::Fixed),
                order_no: Some("ORDER-1".to_string()),
                payment_no: Some("PAY-1".to_string()),
            },
        )
        .await
        .expect("update transaction");

        assert_eq!(updated.merchant, "Corrected Merchant");
        assert_eq!(
            updated.description.as_deref(),
            Some("Corrected description")
        );
        assert_eq!(updated.amount_minor, 9_000);
        assert_eq!(updated.currency, "KRW");
        assert_eq!(updated.spent_at, "2026-06-18");
        assert_eq!(updated.spent_at_time.as_deref(), Some("12:34:56"));
        assert_eq!(updated.direction, BookkeepingDirection::Income);
        assert_eq!(updated.note.as_deref(), Some("Reviewed note"));
        assert_eq!(updated.account.as_deref(), Some("하나은행"));
        assert_eq!(updated.category_code.as_deref(), Some("food"));
        assert_eq!(updated.subcategory_code.as_deref(), Some("food_cafe"));
        assert_eq!(updated.category, "식비");
        assert_eq!(updated.subcategory.as_deref(), Some("카페"));
        assert_eq!(
            updated.payment_method_kind,
            BookkeepingPaymentMethodKind::Card
        );
        assert_eq!(updated.payment_method_label.as_deref(), Some("개인카드"));
        assert_eq!(updated.payment_method_last4.as_deref(), Some("1234"));
        assert_eq!(updated.expense_kind, BookkeepingExpenseKind::Fixed);
        assert_eq!(updated.order_no.as_deref(), Some("ORDER-1"));
        assert_eq!(updated.payment_no.as_deref(), Some("PAY-1"));
        assert!(!updated
            .review_reasons_json
            .contains(LINE_ITEM_SUM_MISMATCH_CODE));

        let overrides = list_bookkeeping_category_overrides_inner(&db, &tx.id)
            .await
            .expect("category override history");
        assert_eq!(overrides.len(), 1);

        let bad_amount = update_bookkeeping_transaction_inner(
            &db,
            UpdateBookkeepingTransactionInput {
                id: tx.id.clone(),
                amount_minor: Some(0),
                ..update_input(tx.id.clone())
            },
        )
        .await
        .expect_err("amount validation");
        assert_eq!(bad_amount.code, "bookkeeping.amount");

        let bad_direction = update_bookkeeping_transaction_inner(
            &db,
            UpdateBookkeepingTransactionInput {
                id: tx.id.clone(),
                direction: Some("refund".to_string()),
                ..update_input(tx.id.clone())
            },
        )
        .await
        .expect_err("direction validation");
        assert_eq!(bad_direction.code, "bookkeeping.direction");
    }

    #[tokio::test]
    async fn write_export_writes_decimal_qif_from_rust() {
        let db = pool().await;
        let mut input = manual_input("Usd Cafe", 12_500, "2026-06-18", "food");
        input.currency = "USD".to_string();
        input.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, input)
            .await
            .expect("create transaction");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bookkeeping.qif");

        write_bookkeeping_export_inner(
            &db,
            WriteBookkeepingExportInput {
                path: path.to_string_lossy().to_string(),
                format: BookkeepingExportFormat::Qif,
                export: ExportBookkeepingInput {
                    project_id: None,
                    from_date: Some("2026-06-01".to_string()),
                    to_date: Some("2026-06-30".to_string()),
                },
            },
        )
        .await
        .expect("write export");

        let written = std::fs::read_to_string(path).expect("read export");
        assert!(written.contains("T125.00\n"));
    }

    #[tokio::test]
    async fn reingest_upsert_preserves_deleted_at_and_review_status() {
        let db = pool().await;
        let mut input = manual_input("Gmail Store", 15_000, "2026-06-17", "food");
        input.source = BookkeepingSource::Gmail;
        input.source_ref = Some("gmail-message-1".to_string());

        let tx = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input.clone(),
            "transaction.ingested",
            "거래가 저장됨",
        )
        .await
        .expect("initial ingest");
        update_bookkeeping_review_status_inner(&db, &tx.id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve");
        delete_bookkeeping_transaction_inner(&db, &tx.id)
            .await
            .expect("delete");

        input.merchant = "Gmail Store Reingested".to_string();
        let reingested = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input,
            "transaction.ingested",
            "거래가 저장됨",
        )
        .await
        .expect("reingest");

        assert_eq!(reingested.id, tx.id);
        assert_eq!(reingested.review_status, BookkeepingReviewStatus::Approved);
        assert!(reingested.deleted_at.is_some());
    }

    #[tokio::test]
    async fn monthly_summary_groups_by_category_and_excludes_ignored_total() {
        let db = pool().await;
        let food = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 12_000, "2026-06-01", "food"),
        )
        .await
        .expect("food");
        update_bookkeeping_review_status_inner(&db, &food.id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve food");

        create_bookkeeping_transaction_inner(
            &db,
            manual_input("Subway", 3_000, "2026-06-02", "transport"),
        )
        .await
        .expect("transport");

        let ignored = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Noise", 1_000, "2026-06-03", "misc"),
        )
        .await
        .expect("ignored");
        update_bookkeeping_review_status_inner(&db, &ignored.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore");

        create_bookkeeping_transaction_inner(
            &db,
            manual_input("July", 5_000, "2026-07-01", "food"),
        )
        .await
        .expect("july");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");

        assert_eq!(summary.total_amount_minor, 15_000);
        assert_eq!(summary.needs_review_count, 1);
        assert_eq!(summary.approved_count, 1);
        assert_eq!(summary.ignored_count, 1);
        assert_eq!(summary.categories.len(), 2);
        assert_eq!(summary.categories[0].category, "food");
        assert_eq!(summary.categories[0].amount_minor, 12_000);
        assert_eq!(summary.categories[1].category, "transport");
        assert_eq!(summary.categories[1].amount_minor, 3_000);
    }

    #[tokio::test]
    async fn monthly_summary_splits_totals_by_currency_without_cross_currency_net() {
        let db = pool().await;
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("KRW Market", 12_000, "2026-06-01", "food"),
        )
        .await
        .expect("krw expense");

        let mut usd_income = manual_input("USD Client", 50_00, "2026-06-02", "work");
        usd_income.currency = "USD".to_string();
        usd_income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, usd_income)
            .await
            .expect("usd income");

        let mut usd_expense = manual_input("USD Tool", 15_00, "2026-06-03", "work");
        usd_expense.currency = "USD".to_string();
        create_bookkeeping_transaction_inner(&db, usd_expense)
            .await
            .expect("usd expense");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");

        assert_eq!(summary.by_currency.len(), 2);
        let krw = summary
            .by_currency
            .iter()
            .find(|row| row.currency == "KRW")
            .expect("krw row");
        assert_eq!(krw.expense_minor, 12_000);
        assert_eq!(krw.income_minor, 0);
        assert_eq!(krw.net_minor, -12_000);
        let usd = summary
            .by_currency
            .iter()
            .find(|row| row.currency == "USD")
            .expect("usd row");
        assert_eq!(usd.expense_minor, 15_00);
        assert_eq!(usd.income_minor, 50_00);
        assert_eq!(usd.net_minor, 35_00);
    }

    #[tokio::test]
    async fn project_scope_filters_bookkeeping_lists_and_summary() {
        let db = pool().await;
        let personal = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("personal project");
        let work = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Work".to_string(),
                kind: ProjectKind::Work,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("work project");

        let mut personal_tx = manual_input("Personal Market", 12_000, "2026-06-01", "food");
        personal_tx.project_id = Some(personal.id.clone());
        create_bookkeeping_transaction_inner(&db, personal_tx)
            .await
            .expect("personal transaction");

        let mut work_tx = manual_input("Work Cafe", 7_000, "2026-06-02", "work");
        work_tx.project_id = Some(work.id.clone());
        create_bookkeeping_transaction_inner(&db, work_tx)
            .await
            .expect("work transaction");

        create_bookkeeping_recurring_expense_inner(
            &db,
            recurring_input(Some(personal.id.clone()), "월세", 900_000),
        )
        .await
        .expect("personal recurring");
        create_bookkeeping_recurring_expense_inner(
            &db,
            recurring_input(Some(work.id.clone()), "법인 구독", 50_000),
        )
        .await
        .expect("work recurring");

        let personal_rows = list_bookkeeping_transactions_inner(&db, None, Some(&personal.id))
            .await
            .expect("personal rows");
        assert_eq!(personal_rows.len(), 1);
        assert_eq!(
            personal_rows[0].project_id.as_deref(),
            Some(personal.id.as_str())
        );

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", Some(&personal.id))
            .await
            .expect("personal summary");
        assert_eq!(summary.total_amount_minor, 12_000);
        assert_eq!(summary.categories.len(), 1);
        assert_eq!(summary.categories[0].category, "food");

        let recurring = list_bookkeeping_recurring_expenses_inner(&db, Some(&personal.id))
            .await
            .expect("personal recurring list");
        assert_eq!(recurring.len(), 1);
        assert_eq!(
            recurring[0].project_id.as_deref(),
            Some(personal.id.as_str())
        );

        let occurrences =
            ensure_bookkeeping_recurring_occurrences_inner(&db, "2026-06", Some(&personal.id))
                .await
                .expect("personal occurrences");
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].recurring_name, "월세");
    }

    #[tokio::test]
    async fn budgets_upsert_by_scope_and_status_uses_monthly_expense_predicate() {
        let db = pool().await;
        let needs_review = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("needs review expense");

        let mut income = manual_input("Refund", 9_000, "2026-06-02", "food");
        income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, income)
            .await
            .expect("income excluded");

        let ignored = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Ignored", 2_000, "2026-06-03", "food"),
        )
        .await
        .expect("ignored expense");
        update_bookkeeping_review_status_inner(&db, &ignored.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore");

        let deleted = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Deleted", 3_000, "2026-06-04", "food"),
        )
        .await
        .expect("deleted expense");
        delete_bookkeeping_transaction_inner(&db, &deleted.id)
            .await
            .expect("soft delete");

        let first = set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-06".to_string(),
                category_code: "food".to_string(),
                limit_minor: 5_000,
                currency: Some("krw".to_string()),
                rollover: false,
                note: Some("initial".to_string()),
            },
        )
        .await
        .expect("insert budget");
        let second = set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-06".to_string(),
                category_code: "food".to_string(),
                limit_minor: 1_500,
                currency: None,
                rollover: false,
                note: Some("updated".to_string()),
            },
        )
        .await
        .expect("upsert budget");

        assert_eq!(first.id, second.id);
        assert_eq!(second.limit_minor, 1_500);
        assert_eq!(
            needs_review.review_status,
            BookkeepingReviewStatus::NeedsReview
        );

        let status = bookkeeping_budget_status_inner(&db, "2026-06", None)
            .await
            .expect("status");
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].spent_minor, 1_000);
        assert_eq!(status[0].remaining_minor, 500);
        assert_eq!(status[0].rollover_in_minor, 0);
    }

    #[tokio::test]
    async fn budget_status_rolls_positive_prior_remaining_and_exposes_over_budget() {
        let db = pool().await;
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("May Market", 3_000, "2026-05-10", "food"),
        )
        .await
        .expect("may expense");
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("June Market", 3_500, "2026-06-10", "food"),
        )
        .await
        .expect("june expense");

        set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-05".to_string(),
                category_code: "food".to_string(),
                limit_minor: 5_000,
                currency: None,
                rollover: false,
                note: None,
            },
        )
        .await
        .expect("may budget");
        set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-06".to_string(),
                category_code: "food".to_string(),
                limit_minor: 1_000,
                currency: None,
                rollover: true,
                note: None,
            },
        )
        .await
        .expect("june budget");

        let status = bookkeeping_budget_status_inner(&db, "2026-06", None)
            .await
            .expect("status");

        assert_eq!(status[0].rollover_in_minor, 2_000);
        assert_eq!(status[0].spent_minor, 3_500);
        assert_eq!(status[0].remaining_minor, -500);
        assert!(status[0].pct > 1.0);
    }

    #[tokio::test]
    async fn budget_planner_surfaces_current_spend_and_unbudgeted_categories() {
        let db = pool().await;
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("Jun shopping", 7_000, "2026-06-10", "shopping"),
        )
        .await
        .expect("previous month expense");
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("Jul food", 10_000, "2026-07-05", "food"),
        )
        .await
        .expect("food expense");
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("Jul transport", 2_000, "2026-07-11", "transport"),
        )
        .await
        .expect("transport expense");

        set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-07".to_string(),
                category_code: "food".to_string(),
                limit_minor: 5_000,
                currency: None,
                rollover: false,
                note: None,
            },
        )
        .await
        .expect("july food budget");

        let rows = bookkeeping_budget_planner_inner(&db, "2026-07", None)
            .await
            .expect("planner");

        let food = rows
            .iter()
            .find(|r| r.category_code == "food")
            .expect("food row");
        assert!(food.has_budget);
        assert_eq!(food.limit_minor, Some(5_000));
        assert_eq!(food.spent_minor, 10_000);
        assert_eq!(food.remaining_minor, -5_000);
        assert!(food.pct > 1.0);

        let transport = rows
            .iter()
            .find(|r| r.category_code == "transport")
            .expect("transport row");
        assert!(!transport.has_budget); // 지출만 있고 예산 미설정 → 노출
        assert_eq!(transport.limit_minor, None);
        assert_eq!(transport.spent_minor, 2_000);

        assert!(rows.iter().all(|r| r.category_code != "shopping")); // 과거월 지출만 있으면 미노출

        // 설정된 예산이 미설정보다 앞선다.
        assert_eq!(rows[0].category_code, "food");
    }

    #[tokio::test]
    async fn cashflow_zero_fills_months_and_calculates_net() {
        let db = pool().await;
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("June Expense", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("expense");

        let mut income = manual_input("June Income", 5_000, "2026-06-02", "work");
        income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, income)
            .await
            .expect("income");

        let ignored = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Ignored Expense", 9_000, "2026-06-03", "food"),
        )
        .await
        .expect("ignored");
        update_bookkeeping_review_status_inner(&db, &ignored.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore");

        let cashflow = bookkeeping_cashflow_inner(
            &db,
            BookkeepingCashflowInput {
                project_id: None,
                from_month: "2026-06".to_string(),
                to_month: "2026-08".to_string(),
            },
        )
        .await
        .expect("cashflow");

        assert_eq!(cashflow.len(), 3);
        assert_eq!(cashflow[0].month, "2026-06");
        assert_eq!(cashflow[0].income_minor, 5_000);
        assert_eq!(cashflow[0].expense_minor, 1_000);
        assert_eq!(cashflow[0].net_minor, 4_000);
        assert_eq!(cashflow[1].month, "2026-07");
        assert_eq!(cashflow[1].income_minor, 0);
        assert_eq!(cashflow[1].expense_minor, 0);
        assert_eq!(cashflow[2].month, "2026-08");
    }

    #[tokio::test]
    async fn category_trend_is_expense_only_and_zero_fills_selected_category() {
        let db = pool().await;
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("May Food", 2_000, "2026-05-10", "food"),
        )
        .await
        .expect("may food");
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("June Food", 3_000, "2026-06-10", "food"),
        )
        .await
        .expect("june food");
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("June Transport", 7_000, "2026-06-11", "transport"),
        )
        .await
        .expect("june transport");
        let mut income = manual_input("June Income", 9_000, "2026-06-12", "food");
        income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, income)
            .await
            .expect("income ignored by category trend");

        let trend = bookkeeping_category_trend_inner(
            &db,
            BookkeepingCategoryTrendInput {
                project_id: None,
                from_month: "2026-05".to_string(),
                to_month: "2026-07".to_string(),
                category_code: Some("food".to_string()),
            },
        )
        .await
        .expect("trend");

        assert_eq!(trend.len(), 3);
        assert_eq!(trend[0].month, "2026-05");
        assert_eq!(trend[0].expense_minor, 2_000);
        assert_eq!(trend[1].month, "2026-06");
        assert_eq!(trend[1].expense_minor, 3_000);
        assert_eq!(trend[2].month, "2026-07");
        assert_eq!(trend[2].expense_minor, 0);
    }

    #[tokio::test]
    async fn report_ranges_are_clamped_to_twenty_four_months() {
        let db = pool().await;
        let err = bookkeeping_cashflow_inner(
            &db,
            BookkeepingCashflowInput {
                project_id: None,
                from_month: "2024-01".to_string(),
                to_month: "2026-01".to_string(),
            },
        )
        .await
        .expect_err("range clamp");

        assert_eq!(err.code, "bookkeeping.report.range");
    }

    #[tokio::test]
    async fn reconcile_account_reports_delta_and_sets_reconciled_at_only_on_match() {
        let db = pool().await;
        let mut salary = manual_input("Salary", 100_000, "2026-06-01", "income");
        salary.direction = BookkeepingDirection::Income;
        salary.account = Some("Checking".to_string());
        create_bookkeeping_transaction_inner(&db, salary)
            .await
            .expect("income");

        let mut grocery = manual_input("Grocery", 25_000, "2026-06-02", "food");
        grocery.account = Some("Checking".to_string());
        create_bookkeeping_transaction_inner(&db, grocery)
            .await
            .expect("expense");

        let mismatch = bookkeeping_reconcile_account_inner(
            &db,
            BookkeepingReconcileAccountInput {
                project_id: None,
                account: "Checking".to_string(),
                statement_date: "2026-06-30".to_string(),
                statement_balance_minor: 70_000,
                currency: Some("KRW".to_string()),
                note: Some("statement".to_string()),
            },
        )
        .await
        .expect("mismatch reconciliation");
        assert_eq!(mismatch.computed_balance_minor, 75_000);
        assert_eq!(mismatch.statement_balance_minor, 70_000);
        assert_eq!(mismatch.difference_minor, -5_000);
        assert!(!mismatch.matched);
        assert_eq!(mismatch.unmatched_count, 1);
        assert!(mismatch.reconciled_at.is_none());

        let matched = bookkeeping_reconcile_account_inner(
            &db,
            BookkeepingReconcileAccountInput {
                project_id: None,
                account: "Checking".to_string(),
                statement_date: "2026-06-30".to_string(),
                statement_balance_minor: 75_000,
                currency: Some("KRW".to_string()),
                note: None,
            },
        )
        .await
        .expect("matched reconciliation");
        assert_eq!(matched.difference_minor, 0);
        assert!(matched.matched);
        assert_eq!(matched.unmatched_count, 0);
        assert!(matched.reconciled_at.is_some());

        let row_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM bookkeeping_transactions")
            .fetch_one(&db)
            .await
            .expect("transaction count");
        assert_eq!(
            row_count.0, 2,
            "reconciliation never rewrites or adds transactions"
        );
    }

    #[tokio::test]
    async fn sync_failure_scrubs_sensitive_values_before_storage() {
        let db = pool().await;
        let job = record_bookkeeping_sync_failure_inner(
            &db,
            RecordBookkeepingSyncFailureInput {
                source: BookkeepingSource::Gmail,
                error_code: "gmail.parse_failed".to_string(),
                raw_error_message:
                    "receipt for buyer@example.com card 4111111111111111 order 123456789012 failed"
                        .to_string(),
            },
        )
        .await
        .expect("record failure");

        let message = job.sanitized_error_message.expect("message");
        assert!(message.contains("[redacted"));
        assert!(!message.contains("buyer@example.com"));
        assert!(!message.contains("4111111111111111"));
        assert!(!message.contains("123456789012"));

        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            jobs[0].sanitized_error_message.as_deref(),
            Some(message.as_str())
        );
    }

    #[tokio::test]
    async fn gmail_ingest_parses_receipt_and_dedups_by_message_id() {
        let db = pool().await;
        let input = BookkeepingEmailReceiptInput {
            project_id: None,
            message_id: "gmail-message-001".to_string(),
            from: "receipts@coupang.test".to_string(),
            subject: "[쿠팡] 결제 영수증".to_string(),
            snippet: "쿠팡 결제금액 23,400원".to_string(),
            body_text: "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원".to_string(),
            received_at: Some("2026-06-16T10:11:12+09:00".to_string()),
        };

        let first = ingest_bookkeeping_gmail_receipt_inner(&db, input.clone())
            .await
            .expect("first ingest")
            .expect("receipt parsed");
        let second = ingest_bookkeeping_gmail_receipt_inner(&db, input)
            .await
            .expect("retry ingest")
            .expect("receipt parsed on retry");

        assert_eq!(first.id, second.id, "Gmail retry should upsert same row");
        assert_eq!(second.source, BookkeepingSource::Gmail);
        assert_eq!(second.source_ref.as_deref(), Some("gmail-message-001"));
        assert_eq!(second.merchant, "쿠팡");
        assert_eq!(second.amount_minor, 23_400);
        assert_eq!(second.spent_at, "2026-06-16");
        assert_eq!(second.review_status, BookkeepingReviewStatus::NeedsReview);

        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("transactions");
        assert_eq!(rows.len(), 1, "source_ref dedup should keep one row");
    }

    #[tokio::test]
    async fn gmail_ingest_maps_parser_judgment_fields_into_row() {
        let db = pool().await;

        // Korean card-approval SMS-forward: structured parse populates the
        // judgment columns instead of the old hard-coded Nones.
        let card = ingest_bookkeeping_gmail_receipt_inner(
            &db,
            BookkeepingEmailReceiptInput {
                project_id: None,
                message_id: "gmail-card-approval-001".to_string(),
                from: "noreply@hanacard.test".to_string(),
                subject: "카드 승인 안내".to_string(),
                snippet: String::new(),
                body_text:
                    "[Web발신]\n하나카드 승인 홍*동 12,345원 일시불 06/18 12:34 스타벅스코리아"
                        .to_string(),
                received_at: Some("2026-06-20T01:02:03+09:00".to_string()),
            },
        )
        .await
        .expect("card ingest")
        .expect("card approval parses");

        assert_eq!(card.review_status, BookkeepingReviewStatus::NeedsReview);
        assert_eq!(card.direction, BookkeepingDirection::Expense);
        assert_eq!(card.spent_at, "2026-06-18");
        assert_eq!(card.spent_at_time.as_deref(), Some("12:34:00"));
        assert_eq!(card.payment_method_label.as_deref(), Some("하나카드"));
        assert_eq!(
            card.payment_method_kind,
            BookkeepingPaymentMethodKind::Unknown,
            "ingest must not confirm payment method kind — human corrects in review"
        );
        let confidence = card.confidence.expect("structured parse sets confidence");
        assert!((0.0..=1.0).contains(&confidence));
        let field_conf: serde_json::Value =
            serde_json::from_str(&card.field_confidence_json).expect("valid field conf json");
        assert!(
            field_conf.get("amount").is_some(),
            "per-field confidence must land in the row"
        );

        // Bank deposit: parser Income direction must reach the DB enum
        // (the old path hard-coded Expense).
        let deposit = ingest_bookkeeping_gmail_receipt_inner(
            &db,
            BookkeepingEmailReceiptInput {
                project_id: None,
                message_id: "gmail-bank-deposit-001".to_string(),
                from: "noreply@toss.test".to_string(),
                subject: "토스 입금 알림".to_string(),
                snippet: String::new(),
                body_text: "토스 입금 50,000원 홍길동".to_string(),
                received_at: Some("2026-06-18T13:00:00+09:00".to_string()),
            },
        )
        .await
        .expect("deposit ingest")
        .expect("deposit parses");
        assert_eq!(deposit.direction, BookkeepingDirection::Income);
        assert_eq!(deposit.review_status, BookkeepingReviewStatus::NeedsReview);
    }

    #[tokio::test]
    async fn gmail_ingest_keeps_cancellation_in_review_queue_with_reason() {
        let db = pool().await;
        let row = ingest_bookkeeping_gmail_receipt_inner(
            &db,
            BookkeepingEmailReceiptInput {
                project_id: None,
                message_id: "gmail-card-cancel-001".to_string(),
                from: "noreply@wooricard.test".to_string(),
                subject: "우리카드 승인취소 안내".to_string(),
                snippet: String::new(),
                body_text: "[Web발신] 우리카드 승인취소 김*수 30,000원 06/18 15:00 배달의민족"
                    .to_string(),
                received_at: Some("2026-06-18T16:00:00+09:00".to_string()),
            },
        )
        .await
        .expect("cancellation ingest")
        .expect("cancellation must NOT be dropped — the human decides");

        assert_eq!(
            row.review_status,
            BookkeepingReviewStatus::NeedsReview,
            "cancellation stays in the review queue"
        );
        let reasons: serde_json::Value =
            serde_json::from_str(&row.review_reasons_json).expect("valid review reasons json");
        let reasons = reasons.as_array().expect("array shape");
        assert!(
            reasons
                .iter()
                .any(|reason| reason["code"] == "cancellation_notice"),
            "cancellation row must carry the cancellation_notice reason"
        );
        let codes: Vec<&str> = reasons
            .iter()
            .filter_map(|reason| reason["code"].as_str())
            .collect();
        let mut deduped = codes.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(codes.len(), deduped.len(), "reason codes must be deduped");
    }

    #[tokio::test]
    async fn gmail_ingest_records_sanitized_failure_when_receipt_is_unparseable() {
        let db = pool().await;
        let created = ingest_bookkeeping_gmail_receipt_inner(
            &db,
            BookkeepingEmailReceiptInput {
                project_id: None,
                message_id: "gmail-message-002".to_string(),
                from: "buyer@example.com".to_string(),
                subject: "hello".to_string(),
                snippet: "card 4111111111111111".to_string(),
                body_text: "no amount or merchant here 123456789012".to_string(),
                received_at: Some("2026-06-16T10:11:12+09:00".to_string()),
            },
        )
        .await
        .expect("unparseable is non-fatal");

        assert!(
            created.is_none(),
            "unparseable mail should not create a row"
        );
        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].source, BookkeepingSource::Gmail);
        assert_eq!(
            jobs[0].sanitized_error_code.as_deref(),
            Some("gmail.parse_failed")
        );
        let message = jobs[0]
            .sanitized_error_message
            .as_deref()
            .expect("sanitized message");
        assert!(!message.contains("buyer@example.com"));
        assert!(!message.contains("4111111111111111"));
        assert!(!message.contains("123456789012"));
    }

    #[tokio::test]
    async fn gmail_sync_resolves_label_names_and_ingests_candidates() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");

        let mut candidates = std::collections::HashMap::new();
        candidates.insert(
            "ok-1".to_string(),
            GmailReceiptCandidate {
                message_id: "ok-1".to_string(),
                from: "receipts@coupang.test".to_string(),
                subject: "[쿠팡] 결제 영수증".to_string(),
                snippet: "쿠팡 결제금액 23,400원".to_string(),
                body_text: "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원".to_string(),
                received_at: Some("2026-06-16T10:11:12Z".to_string()),
            },
        );
        candidates.insert(
            "bad-1".to_string(),
            GmailReceiptCandidate {
                message_id: "bad-1".to_string(),
                from: "buyer@example.com".to_string(),
                subject: "not a receipt".to_string(),
                snippet: "card 4111111111111111".to_string(),
                body_text: "no parseable amount 123456789012".to_string(),
                received_at: Some("2026-06-16T10:11:12Z".to_string()),
            },
        );
        let provider = FakeGmailReadProvider {
            labels: vec![GmailLabelInfo {
                id: "Label_42".to_string(),
                name: "가계부".to_string(),
            }],
            ids: vec!["ok-1".to_string(), "bad-1".to_string()],
            candidates,
            searches: Mutex::new(Vec::new()),
        };

        let result = sync_bookkeeping_gmail_receipts_with_provider(
            &db,
            &provider,
            "access-token",
            SyncBookkeepingGmailReceiptsInput {
                project_id: project.id.clone(),
                label_ids: Vec::new(),
                label_names: vec!["가계부".to_string()],
                query: Some("newer_than:30d".to_string()),
                max_results: Some(10),
            },
        )
        .await
        .expect("sync");

        assert_eq!(result.scanned_count, 2);
        assert_eq!(result.imported_count, 1);
        assert_eq!(result.failed_count, 1);
        let search = {
            let searches = provider.searches.lock().expect("searches");
            assert_eq!(searches.len(), 1);
            searches[0].clone()
        };
        assert_eq!(search.label_ids, vec!["Label_42".to_string()]);
        assert_eq!(search.query.as_deref(), Some("newer_than:30d"));

        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("transactions");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_ref.as_deref(), Some("ok-1"));
        assert_eq!(rows[0].project_id.as_deref(), Some(project.id.as_str()));

        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        assert_eq!(jobs.len(), 2, "parse failure + completed sync marker");
        assert!(jobs.iter().any(|job| job.status == "succeeded"));
        let parse_failure = jobs
            .iter()
            .find(|job| job.sanitized_error_code.as_deref() == Some("gmail.parse_failed"))
            .expect("parse failure job");
        let message = parse_failure
            .sanitized_error_message
            .as_deref()
            .unwrap_or_default();
        assert!(!message.contains("buyer@example.com"));
        assert!(!message.contains("4111111111111111"));
        assert!(!message.contains("123456789012"));
    }

    #[tokio::test]
    async fn gmail_sync_requires_a_bounded_filter() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");
        let provider = FakeGmailReadProvider::default();

        let err = sync_bookkeeping_gmail_receipts_with_provider(
            &db,
            &provider,
            "access-token",
            SyncBookkeepingGmailReceiptsInput {
                project_id: project.id,
                label_ids: Vec::new(),
                label_names: Vec::new(),
                query: None,
                max_results: Some(10),
            },
        )
        .await
        .expect_err("unbounded Gmail scan should be rejected");

        assert_eq!(err.code, "bookkeeping.gmail.filter");
    }

    #[tokio::test]
    async fn recurring_expense_generates_monthly_occurrence_and_posts_transaction() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");

        let recurring = create_bookkeeping_recurring_expense_inner(
            &db,
            CreateBookkeepingRecurringExpenseInput {
                project_id: Some(project.id.clone()),
                name: "월세".to_string(),
                merchant: Some("건물주".to_string()),
                amount_minor: 900_000,
                currency: "KRW".to_string(),
                category: "housing".to_string(),
                payment_method_kind: BookkeepingPaymentMethodKind::BankTransfer,
                payment_method_label: Some("주거래 계좌".to_string()),
                payment_method_last4: Some("4821".to_string()),
                expense_kind: BookkeepingExpenseKind::Fixed,
                schedule_day: 25,
                start_month: "2026-06".to_string(),
                end_month: None,
                note: Some("메일로 관측 불가".to_string()),
            },
        )
        .await
        .expect("create recurring expense");

        let occurrences = ensure_bookkeeping_recurring_occurrences_inner(&db, "2026-06", None)
            .await
            .expect("ensure occurrences");
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].recurring_expense_id, recurring.id);
        assert_eq!(occurrences[0].due_date, "2026-06-25");
        assert_eq!(
            occurrences[0].payment_method_kind,
            BookkeepingPaymentMethodKind::BankTransfer
        );

        let posted = post_bookkeeping_recurring_occurrence_inner(&db, &occurrences[0].id)
            .await
            .expect("post occurrence");
        assert_eq!(posted.status, BookkeepingRecurringOccurrenceStatus::Posted);
        assert!(posted.transaction_id.is_some());

        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("transactions");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].expense_kind, BookkeepingExpenseKind::Fixed);
        assert_eq!(
            rows[0].payment_method_kind,
            BookkeepingPaymentMethodKind::BankTransfer
        );
        assert_eq!(rows[0].payment_method_label.as_deref(), Some("주거래 계좌"));
        assert_eq!(rows[0].payment_method_last4.as_deref(), Some("4821"));
        assert_eq!(
            rows[0].recurring_expense_id.as_deref(),
            Some(recurring.id.as_str())
        );
        assert_eq!(
            rows[0].recurring_occurrence_id.as_deref(),
            Some(posted.id.as_str())
        );

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");
        assert_eq!(summary.total_amount_minor, 900_000);
    }

    #[tokio::test]
    async fn summary_splits_income_expense_and_alias_equals_expense() {
        let db = pool().await;
        let expense = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 10_000, "2026-06-01", "food"),
        )
        .await
        .expect("expense");
        update_bookkeeping_review_status_inner(&db, &expense.id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve expense");

        let mut income = manual_input("용돈", 50_000, "2026-06-02", "income");
        income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, income)
            .await
            .expect("income");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");
        assert_eq!(summary.total_expense_minor, 10_000);
        assert_eq!(summary.total_income_minor, 50_000);
        assert_eq!(summary.net_minor, 40_000);
        assert_eq!(
            summary.total_amount_minor, 10_000,
            "legacy alias must equal expense, never include income"
        );
        assert_eq!(summary.categories.len(), 1, "income excluded from chart");
        assert_eq!(summary.categories[0].category, "food");
    }

    #[tokio::test]
    async fn summary_separates_duplicate_from_ignored_counts() {
        let db = pool().await;
        let original = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("original");
        let dup = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A copy", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("dup");
        let plain = create_bookkeeping_transaction_inner(
            &db,
            manual_input("noise", 500, "2026-06-01", "misc"),
        )
        .await
        .expect("plain");
        update_bookkeeping_review_status_inner(&db, &plain.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore plain");
        // Simulate mark_duplicate (Phase D command) at the SQL level for the summary contract.
        sqlx::query(
            "UPDATE bookkeeping_transactions SET review_status='ignored', \
             duplicate_of_transaction_id=?2 WHERE id=?1",
        )
        .bind(&dup.id)
        .bind(&original.id)
        .execute(&db)
        .await
        .expect("mark dup");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");
        assert_eq!(summary.ignored_count, 1, "user-ignored excludes duplicates");
        assert_eq!(summary.duplicate_count, 1);
    }

    #[tokio::test]
    async fn judgment_fields_round_trip_on_create() {
        let db = pool().await;
        let mut input = manual_input("쿠팡", 59_010, "2026-06-12", "shopping");
        input.account = Some("하나".to_string());
        input.subcategory = Some("생활용품".to_string());
        input.category_code = Some("shopping".to_string());
        input.subcategory_code = Some("daily_goods".to_string());
        input.raw_category = Some("🪑 생활용품".to_string());
        input.spent_at_time = Some("14:28:47".to_string());
        input.confidence = Some(0.92);
        input.field_confidence_json = Some("{\"amount\":0.99,\"merchant\":0.7}".to_string());
        input.review_reasons_json = Some("[{\"code\":\"low_merchant_confidence\"}]".to_string());
        input.order_no = Some("ORDER-1".to_string());
        input.payment_no = Some("PAY-1".to_string());

        let row = create_bookkeeping_transaction_inner(&db, input)
            .await
            .expect("create with judgment fields");

        assert_eq!(row.direction, BookkeepingDirection::Expense);
        assert_eq!(row.account.as_deref(), Some("하나"));
        assert_eq!(row.subcategory.as_deref(), Some("생활용품"));
        assert_eq!(row.raw_category.as_deref(), Some("🪑 생활용품"));
        assert_eq!(row.spent_at_time.as_deref(), Some("14:28:47"));
        assert_eq!(row.confidence, Some(0.92));
        assert_eq!(row.order_no.as_deref(), Some("ORDER-1"));
        assert_eq!(row.payment_no.as_deref(), Some("PAY-1"));
        assert!(row.field_confidence_json.contains("amount"));
        assert!(row.review_reasons_json.contains("low_merchant_confidence"));

        // Defaults when omitted.
        let plain = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Cafe", 4_500, "2026-06-12", "food"),
        )
        .await
        .expect("plain create");
        assert_eq!(plain.field_confidence_json, "{}");
        assert_eq!(plain.review_reasons_json, "[]");
        assert!(plain.confidence.is_none());
    }

    #[tokio::test]
    async fn rejects_malformed_judgment_inputs() {
        let db = pool().await;

        let mut bad_json = manual_input("X", 100, "2026-06-01", "food");
        bad_json.field_confidence_json = Some("not json".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, bad_json)
                .await
                .is_err(),
            "invalid JSON rejected"
        );

        let mut wrong_shape = manual_input("X", 100, "2026-06-01", "food");
        wrong_shape.field_confidence_json = Some("[1,2,3]".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, wrong_shape)
                .await
                .is_err(),
            "object-shaped field must reject an array"
        );

        let mut bad_time = manual_input("X", 100, "2026-06-01", "food");
        bad_time.spent_at_time = Some("9:9:9".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, bad_time)
                .await
                .is_err(),
            "malformed time rejected"
        );

        let mut out_of_range_time = manual_input("X", 100, "2026-06-01", "food");
        out_of_range_time.spent_at_time = Some("25:61:99".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, out_of_range_time)
                .await
                .is_err(),
            "out-of-range time rejected"
        );

        let mut bad_conf = manual_input("X", 100, "2026-06-01", "food");
        bad_conf.confidence = Some(1.5);
        assert!(
            create_bookkeeping_transaction_inner(&db, bad_conf)
                .await
                .is_err(),
            "confidence out of range rejected"
        );
    }

    #[tokio::test]
    async fn taxonomy_seed_is_loaded() {
        let db = pool().await;
        let nodes = list_bookkeeping_taxonomy_inner(&db)
            .await
            .expect("taxonomy");
        assert!(nodes
            .iter()
            .any(|n| n.code == "food" && n.parent_code.is_none()));
        assert!(nodes
            .iter()
            .any(|n| n.code == "shopping_daily" && n.parent_code.as_deref() == Some("shopping")));
        let uncategorized = nodes
            .iter()
            .find(|n| n.code == "uncategorized")
            .expect("uncategorized node");
        assert_eq!(uncategorized.label, "미분류");

        let rules = bookkeeping_category_rules_inner(&db)
            .await
            .expect("category rules");
        assert!(!rules.aliases.is_empty());
    }

    #[tokio::test]
    async fn resolver_maps_emoji_raw_label_via_alias() {
        let db = pool().await;
        let resolved = resolve_category_inner(
            &db,
            None,
            None,
            "uncategorized",
            Some("🪑 생활용품"),
            "쿠팡",
        )
        .await
        .expect("resolve");
        assert_eq!(resolved.category_code.as_deref(), Some("shopping"));
        assert_eq!(resolved.subcategory_code.as_deref(), Some("shopping_daily"));
        assert!(resolved.confidence.unwrap_or(0.0) > 0.5);
    }

    #[tokio::test]
    async fn resolver_falls_back_to_uncategorized_and_honors_explicit_code() {
        let db = pool().await;

        let unknown = resolve_category_inner(
            &db,
            None,
            None,
            "uncategorized",
            Some("듣도보도 못한 라벨"),
            "정체불명",
        )
        .await
        .expect("resolve unknown");
        assert_eq!(unknown.category_code.as_deref(), Some("uncategorized"));
        assert_eq!(unknown.confidence, Some(0.0));

        let explicit = resolve_category_inner(
            &db,
            Some("transport"),
            Some("transport_taxi"),
            "uncategorized",
            Some("🪑 생활용품"),
            "쿠팡",
        )
        .await
        .expect("resolve explicit");
        assert_eq!(explicit.category_code.as_deref(), Some("transport"));
        assert_eq!(explicit.subcategory_code.as_deref(), Some("transport_taxi"));
        assert_eq!(
            explicit.confidence, None,
            "explicit code is caller-authoritative"
        );
    }

    #[tokio::test]
    async fn list_transactions_can_order_review_queue_by_low_confidence() {
        let db = pool().await;
        let mut high = manual_input("High Confidence", 1_000, "2026-06-01", "uncategorized");
        high.raw_category = Some("🪑 생활용품".to_string());
        create_bookkeeping_transaction_inner(&db, high)
            .await
            .expect("high confidence");

        let mut low = manual_input("Low Confidence", 1_000, "2026-06-02", "uncategorized");
        low.raw_category = Some("unknown raw label".to_string());
        let low = create_bookkeeping_transaction_inner(&db, low)
            .await
            .expect("low confidence");

        let rows = list_bookkeeping_transactions_ordered_inner(
            &db,
            Some(BookkeepingReviewStatus::NeedsReview),
            None,
            Some("confidence_asc"),
            None,
            None,
        )
        .await
        .expect("ordered rows");

        assert_eq!(rows[0].id, low.id);
        assert_eq!(rows[0].review_status, BookkeepingReviewStatus::NeedsReview);
        assert_eq!(rows[0].confidence, Some(0.0));
    }

    #[tokio::test]
    async fn list_transactions_date_range_filters_and_boundaries_are_inclusive() {
        let db = pool().await;
        for (merchant, spent_at) in [
            ("Before Range", "2026-05-31"),
            ("Range Start", "2026-06-01"),
            ("Range End", "2026-06-30"),
            ("After Range", "2026-07-01"),
        ] {
            create_bookkeeping_transaction_inner(
                &db,
                manual_input(merchant, 1_000, spent_at, "uncategorized"),
            )
            .await
            .expect("seed row");
        }

        let rows = list_bookkeeping_transactions_ordered_inner(
            &db,
            None,
            None,
            None,
            Some("2026-06-01"),
            Some("2026-06-30"),
        )
        .await
        .expect("ranged rows");

        let merchants: Vec<&str> = rows.iter().map(|r| r.merchant.as_str()).collect();
        assert!(
            merchants.contains(&"Range Start"),
            "from boundary inclusive"
        );
        assert!(merchants.contains(&"Range End"), "to boundary inclusive");
        assert!(!merchants.contains(&"Before Range"));
        assert!(!merchants.contains(&"After Range"));

        // from-only / to-only도 각각 독립으로 적용된다.
        let from_only = list_bookkeeping_transactions_ordered_inner(
            &db,
            None,
            None,
            None,
            Some("2026-07-01"),
            None,
        )
        .await
        .expect("from-only rows");
        assert!(from_only
            .iter()
            .all(|r| r.spent_at.as_str() >= "2026-07-01"));
        let to_only = list_bookkeeping_transactions_ordered_inner(
            &db,
            None,
            None,
            None,
            None,
            Some("2026-05-31"),
        )
        .await
        .expect("to-only rows");
        assert!(to_only.iter().all(|r| r.spent_at.as_str() <= "2026-05-31"));
    }

    #[tokio::test]
    async fn list_transactions_rejects_malformed_date_range() {
        let db = pool().await;
        let bad_from = list_bookkeeping_transactions_ordered_inner(
            &db,
            None,
            None,
            None,
            Some("2026-6-1"),
            None,
        )
        .await;
        assert!(bad_from.is_err(), "malformed from_date must be rejected");
        let bad_to = list_bookkeeping_transactions_ordered_inner(
            &db,
            None,
            None,
            None,
            None,
            Some("2026/06/30"),
        )
        .await;
        assert!(bad_to.is_err(), "malformed to_date must be rejected");
    }

    #[tokio::test]
    async fn ingest_create_resolves_category_code_from_raw_label() {
        let db = pool().await;
        let mut input = manual_input("쿠팡", 59_010, "2026-06-12", "uncategorized");
        input.source = BookkeepingSource::Gmail;
        input.source_ref = Some("ingest-resolve-1".to_string());
        input.raw_category = Some("🪑 생활용품".to_string());
        let row = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input,
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("ingest");
        assert_eq!(row.category_code.as_deref(), Some("shopping"));
        assert_eq!(row.subcategory_code.as_deref(), Some("shopping_daily"));
        assert_eq!(row.raw_category.as_deref(), Some("🪑 생활용품"));
    }

    #[tokio::test]
    async fn override_category_writes_history_and_updates_row() {
        let db = pool().await;
        let row = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 12_000, "2026-06-01", "food"),
        )
        .await
        .expect("create");
        assert_eq!(row.category_code.as_deref(), Some("food"));

        let updated = override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: row.id.clone(),
                category_code: Some("transport".to_string()),
                subcategory_code: Some("transport_taxi".to_string()),
                reason: Some("실은 택시비".to_string()),
            },
        )
        .await
        .expect("override");
        assert_eq!(updated.category_code.as_deref(), Some("transport"));
        assert_eq!(updated.subcategory_code.as_deref(), Some("transport_taxi"));

        let history = list_bookkeeping_category_overrides_inner(&db, &row.id)
            .await
            .expect("override history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].from_code.as_deref(), Some("food"));
        assert_eq!(history[0].to_code.as_deref(), Some("transport"));

        let audit = list_bookkeeping_audit_inner(&db, Some(row.id))
            .await
            .expect("audit");
        assert!(audit
            .iter()
            .any(|a| a.action == "transaction.category_overridden"));
    }

    #[tokio::test]
    async fn override_reinforces_alias_without_auto_approving_next_ingest() {
        let db = pool().await;
        let row = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Learned Merchant", 12_000, "2026-06-01", "food"),
        )
        .await
        .expect("create");

        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: row.id.clone(),
                category_code: Some("transport".to_string()),
                subcategory_code: Some("transport_taxi".to_string()),
                reason: Some("merchant learning".to_string()),
            },
        )
        .await
        .expect("override");
        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: row.id.clone(),
                category_code: Some("transport".to_string()),
                subcategory_code: Some("transport_taxi".to_string()),
                reason: Some("merchant learning again".to_string()),
            },
        )
        .await
        .expect("override again");

        let aliases = list_bookkeeping_category_aliases_inner(&db)
            .await
            .expect("aliases");
        let learned = aliases
            .iter()
            .find(|alias| {
                alias.match_kind == BookkeepingAliasMatchKind::Merchant
                    && alias.pattern == "Learned Merchant"
            })
            .expect("learned alias");
        assert_eq!(learned.category_code, "transport");
        assert_eq!(learned.subcategory_code.as_deref(), Some("transport_taxi"));
        assert_eq!(learned.source, BookkeepingAliasSource::User);
        assert_eq!(learned.hit_count, 2);
        assert!(learned.last_used_at.is_some());

        let mut ingest = manual_input("Learned Merchant", 9_000, "2026-06-02", "uncategorized");
        ingest.source = BookkeepingSource::Gmail;
        ingest.source_ref = Some("learned-merchant-next".to_string());
        let next = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            ingest,
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("next ingest");

        assert_eq!(next.category_code.as_deref(), Some("transport"));
        assert_eq!(next.subcategory_code.as_deref(), Some("transport_taxi"));
        assert_eq!(next.review_status, BookkeepingReviewStatus::NeedsReview);
        assert!(next.field_confidence_json.contains("category"));
    }

    #[tokio::test]
    async fn reingest_preserves_user_category_and_direction_override() {
        let db = pool().await;
        let mut input = manual_input("쿠팡", 10_000, "2026-06-12", "uncategorized");
        input.source = BookkeepingSource::Gmail;
        input.source_ref = Some("msg-clobber-1".to_string());
        input.raw_category = Some("🪑 생활용품".to_string());

        let row = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input.clone(),
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("first ingest");
        assert_eq!(row.category_code.as_deref(), Some("shopping"));

        // User corrects category + direction.
        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: row.id.clone(),
                category_code: Some("transport".to_string()),
                subcategory_code: Some("transport_taxi".to_string()),
                reason: None,
            },
        )
        .await
        .expect("override");
        sqlx::query("UPDATE bookkeeping_transactions SET direction='income' WHERE id=?1")
            .bind(&row.id)
            .execute(&db)
            .await
            .expect("direction correction");

        // Gmail re-sync re-ingests the same message_id.
        let reingested = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input,
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("re-ingest");
        assert_eq!(reingested.id, row.id);
        assert_eq!(
            reingested.category_code.as_deref(),
            Some("transport"),
            "user category override must survive Gmail re-sync"
        );
        assert_eq!(
            reingested.subcategory_code.as_deref(),
            Some("transport_taxi")
        );
        assert_eq!(
            reingested.direction,
            BookkeepingDirection::Income,
            "user direction correction must survive re-sync"
        );
    }

    #[tokio::test]
    async fn line_items_round_trip_and_toggle_sum_mismatch_reason() {
        let db = pool().await;
        let row = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Mart", 10_000, "2026-06-01", "food"),
        )
        .await
        .expect("create");

        // Items summing to 9_000 (4_000 + 2_500*2) ≠ 10_000 → mismatch reason.
        let items = set_bookkeeping_line_items_inner(
            &db,
            SetBookkeepingLineItemsInput {
                transaction_id: row.id.clone(),
                items: vec![
                    CreateBookkeepingLineItemInput {
                        name: "사과".to_string(),
                        amount_minor: 4_000,
                        quantity: Some(1),
                        category_code: None,
                    },
                    CreateBookkeepingLineItemInput {
                        name: "우유".to_string(),
                        amount_minor: 2_500,
                        quantity: Some(2),
                        category_code: None,
                    },
                ],
            },
        )
        .await
        .expect("set line items");
        assert_eq!(items.len(), 2);

        let after_mismatch = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("list")
            .into_iter()
            .find(|t| t.id == row.id)
            .expect("row");
        assert!(after_mismatch
            .review_reasons_json
            .contains("line_item_sum_mismatch"));

        // Replace with a matching single item (10_000) → reason cleared.
        set_bookkeeping_line_items_inner(
            &db,
            SetBookkeepingLineItemsInput {
                transaction_id: row.id.clone(),
                items: vec![CreateBookkeepingLineItemInput {
                    name: "합계".to_string(),
                    amount_minor: 10_000,
                    quantity: Some(1),
                    category_code: None,
                }],
            },
        )
        .await
        .expect("set matching line items");

        let after_match = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("list")
            .into_iter()
            .find(|t| t.id == row.id)
            .expect("row");
        assert!(
            !after_match
                .review_reasons_json
                .contains("line_item_sum_mismatch"),
            "mismatch reason cleared once items reconcile"
        );
        assert_eq!(
            list_bookkeeping_line_items_inner(&db, &row.id)
                .await
                .expect("items")
                .len(),
            1,
            "set replaces the prior line-item set"
        );
    }

    fn dup_input(
        spent_at: &str,
        amount_minor: i32,
        merchant: Option<&str>,
    ) -> FindBookkeepingDuplicateCandidatesInput {
        FindBookkeepingDuplicateCandidatesInput {
            project_id: None,
            spent_at: spent_at.to_string(),
            amount_minor,
            merchant: merchant.map(str::to_string),
            order_no: None,
            payment_no: None,
            source: None,
            source_ref: None,
            exclude_transaction_id: None,
        }
    }

    #[tokio::test]
    async fn find_duplicate_candidates_scores_strong_and_weak_signals() {
        let db = pool().await;
        let mut a = manual_input("쿠팡", 59_010, "2026-06-12", "shopping");
        a.source = BookkeepingSource::Gmail;
        a.source_ref = Some("msg-A".to_string());
        a.order_no = Some("ORD-1".to_string());
        let existing = create_bookkeeping_transaction_inner(&db, a)
            .await
            .expect("existing");

        // Exact source_ref → 1.0.
        let by_ref = find_bookkeeping_duplicate_candidates_inner(
            &db,
            FindBookkeepingDuplicateCandidatesInput {
                source: Some(BookkeepingSource::Gmail),
                source_ref: Some("msg-A".to_string()),
                ..dup_input("2026-06-12", 59_010, None)
            },
        )
        .await
        .expect("by ref");
        let hit = by_ref
            .iter()
            .find(|c| c.transaction.id == existing.id)
            .expect("source_ref hit");
        assert!((hit.score - 1.0).abs() < 1e-9);

        // Amount + same date + merchant overlap, no strong key → high but < 1.0.
        let by_weak = find_bookkeeping_duplicate_candidates_inner(
            &db,
            dup_input("2026-06-12", 59_010, Some("쿠팡 결제")),
        )
        .await
        .expect("by weak");
        let weak = by_weak
            .iter()
            .find(|c| c.transaction.id == existing.id)
            .expect("weak hit");
        assert!(
            weak.score >= 0.9 && weak.score < 1.0,
            "score={}",
            weak.score
        );

        // Amount only, date 2 days off → graded lower.
        let near =
            find_bookkeeping_duplicate_candidates_inner(&db, dup_input("2026-06-14", 59_010, None))
                .await
                .expect("near");
        let near_hit = near
            .iter()
            .find(|c| c.transaction.id == existing.id)
            .expect("near hit");
        assert!(near_hit.score >= 0.6 && near_hit.score < 0.8);

        // Excluding self yields no self-match.
        let excluded = find_bookkeeping_duplicate_candidates_inner(
            &db,
            FindBookkeepingDuplicateCandidatesInput {
                exclude_transaction_id: Some(existing.id.clone()),
                ..dup_input("2026-06-12", 59_010, Some("쿠팡"))
            },
        )
        .await
        .expect("excluded");
        assert!(!excluded.iter().any(|c| c.transaction.id == existing.id));
    }

    #[tokio::test]
    async fn mark_duplicate_sets_state_rejects_self_and_excludes_from_candidates() {
        let db = pool().await;
        let original = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("original");
        let dup = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A copy", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("dup");

        let marked = mark_bookkeeping_duplicate_inner(&db, &dup.id, &original.id)
            .await
            .expect("mark");
        assert_eq!(marked.review_status, BookkeepingReviewStatus::Ignored);
        assert_eq!(
            marked.duplicate_of_transaction_id.as_deref(),
            Some(original.id.as_str())
        );

        assert!(
            mark_bookkeeping_duplicate_inner(&db, &original.id, &original.id)
                .await
                .is_err(),
            "self-reference rejected"
        );
        assert!(
            mark_bookkeeping_duplicate_inner(&db, &dup.id, "does-not-exist")
                .await
                .is_err(),
            "unknown target rejected"
        );

        // No duplicate chains: dup is itself a duplicate, so it cannot be a mark target.
        let third = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A copy 2", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("third");
        assert!(
            mark_bookkeeping_duplicate_inner(&db, &third.id, &dup.id)
                .await
                .is_err(),
            "cannot mark as duplicate-of a row that is itself a duplicate"
        );

        let audit = list_bookkeeping_audit_inner(&db, Some(dup.id.clone()))
            .await
            .expect("audit");
        assert!(audit
            .iter()
            .any(|a| a.action == "transaction.marked_duplicate"));

        // The already-duplicate row must not be suggested as a candidate for another row.
        let cands = find_bookkeeping_duplicate_candidates_inner(
            &db,
            FindBookkeepingDuplicateCandidatesInput {
                exclude_transaction_id: Some(original.id.clone()),
                ..dup_input("2026-06-01", 1_000, Some("A"))
            },
        )
        .await
        .expect("candidates");
        assert!(
            !cands.iter().any(|c| c.transaction.id == dup.id),
            "a row already marked duplicate is never suggested"
        );
    }

    #[tokio::test]
    async fn gmail_sync_advances_cursor_and_second_run_uses_after_query() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");

        let mut candidates = std::collections::HashMap::new();
        candidates.insert(
            "ok-1".to_string(),
            GmailReceiptCandidate {
                message_id: "ok-1".to_string(),
                from: "receipts@coupang.test".to_string(),
                subject: "[쿠팡] 결제 영수증".to_string(),
                snippet: "쿠팡 결제금액 23,400원".to_string(),
                body_text: "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원".to_string(),
                received_at: Some("2026-06-16T10:11:12Z".to_string()),
            },
        );
        let provider = FakeGmailReadProvider {
            labels: vec![GmailLabelInfo {
                id: "Label_42".to_string(),
                name: "가계부".to_string(),
            }],
            ids: vec!["ok-1".to_string()],
            candidates,
            searches: Mutex::new(Vec::new()),
        };

        let input = || SyncBookkeepingGmailReceiptsInput {
            project_id: project.id.clone(),
            label_ids: Vec::new(),
            label_names: vec!["가계부".to_string()],
            query: None,
            max_results: Some(10),
        };

        // First run: no cursor → no after: filter; persists cursor at the receipt date.
        let r1 = sync_bookkeeping_gmail_receipts_with_provider(&db, &provider, "tok", input())
            .await
            .expect("first sync");
        assert_eq!(r1.imported_count, 1);
        assert_eq!(r1.duplicate_count, 0);
        assert_eq!(r1.cursor_after.as_deref(), Some("2026-06-16"));
        let cursors = list_bookkeeping_sync_cursors_inner(&db)
            .await
            .expect("cursors");
        assert_eq!(cursors.len(), 1);
        assert_eq!(cursors[0].cursor_value, "2026-06-16");

        // Second run: cursor present → re-scan of the same message is a duplicate, and the search
        // query is now the cursor-derived after: filter.
        let r2 = sync_bookkeeping_gmail_receipts_with_provider(&db, &provider, "tok", input())
            .await
            .expect("second sync");
        assert_eq!(r2.imported_count, 0);
        assert_eq!(r2.duplicate_count, 1);

        let last_query = {
            let searches = provider.searches.lock().expect("searches");
            searches.last().expect("a search").query.clone()
        };
        // Cursor is 2026-06-16; the after: window is widened one day back for TZ skew.
        assert_eq!(last_query.as_deref(), Some("after:2026/06/15"));

        // Still one transaction row (dedup), and the latest job carries counts + cursors.
        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("rows");
        assert_eq!(rows.len(), 1);
        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        let latest_success = jobs
            .iter()
            .find(|j| j.status == "succeeded")
            .expect("success job");
        assert_eq!(latest_success.cursor_after.as_deref(), Some("2026-06-16"));
        assert!(latest_success.scanned_count >= 1);
    }

    #[test]
    fn date_minus_one_day_handles_boundaries() {
        assert_eq!(
            date_minus_one_day("2026-06-16").as_deref(),
            Some("2026-06-15")
        );
        assert_eq!(
            date_minus_one_day("2026-06-01").as_deref(),
            Some("2026-05-31")
        );
        assert_eq!(
            date_minus_one_day("2026-01-01").as_deref(),
            Some("2025-12-31")
        );
        assert_eq!(
            date_minus_one_day("2024-03-01").as_deref(),
            Some("2024-02-29")
        ); // leap
        assert_eq!(
            date_minus_one_day("2026-03-01").as_deref(),
            Some("2026-02-28")
        );
        assert!(date_minus_one_day("nope").is_none());
    }
}
