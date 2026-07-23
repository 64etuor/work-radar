//! 가계부 Gmail 영수증 라벨 조회·동기화 인제스트.

use tauri::State;

use crate::bookkeeping::{
    parse_bookkeeping_email_receipt, BookkeepingEmailReceiptInput, ParsedBookkeepingDirection,
    ParsedBookkeepingReceipt, ParsedBookkeepingReviewReason,
};
use crate::db::Db;
use crate::error::AppError;
use crate::gmail::{GmailMessageSearch, GmailReadProvider};
use crate::models::{
    BookkeepingDirection, BookkeepingExpenseKind, BookkeepingGmailLabel,
    BookkeepingGmailSyncResult, BookkeepingPaymentMethodKind, BookkeepingSource,
    BookkeepingTransaction, CreateBookkeepingTransactionInput, RecordBookkeepingSyncFailureInput,
    SyncBookkeepingGmailReceiptsInput,
};

use super::*;

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_gmail_labels(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<BookkeepingGmailLabel>, AppError> {
    let access = crate::commands::calendar::access_token_for(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "gmail.not_connected",
                "미연결 — 먼저 Google 계정을 연결하세요",
            )
        })?;
    let provider = crate::gmail::HttpGmailProvider::new()?;
    let labels = provider.list_labels(&access).await?;
    // Gmail API는 시스템 라벨(INBOX/SENT/…)을 목록 앞에 반환한다 — UI 칩/선택지는 사용자
    // 라벨만 의미가 있으므로 제외한다(사용자 라벨 id는 "Label_" 접두사). 이름순 정렬로
    // 중첩 경로("Finance/Receipts")가 부모 옆에 모이게 한다.
    let mut labels: Vec<BookkeepingGmailLabel> = labels
        .into_iter()
        .filter(|label| label.id.starts_with("Label_"))
        .map(|label| BookkeepingGmailLabel {
            id: label.id,
            name: label.name,
        })
        .collect();
    labels.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(labels)
}

#[tauri::command]
#[specta::specta]
pub async fn sync_bookkeeping_gmail_receipts(
    db: State<'_, Db>,
    input: SyncBookkeepingGmailReceiptsInput,
) -> Result<BookkeepingGmailSyncResult, AppError> {
    let access = crate::commands::calendar::access_token_for(db.inner(), &input.project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "gmail.not_connected",
                "미연결 — 먼저 Google 계정을 연결하세요",
            )
        })?;
    let provider = crate::gmail::HttpGmailProvider::new()?;
    sync_bookkeeping_gmail_receipts_with_provider(db.inner(), &provider, &access, input).await
}

// Foundation for the future Gmail read-side sync worker. We keep this off the renderer IPC surface
// so raw email bodies do not become a frontend contract before the Rust Gmail adapter exists.
#[allow(dead_code)]
pub(crate) async fn ingest_bookkeeping_gmail_receipt_inner(
    db: &Db,
    input: BookkeepingEmailReceiptInput,
) -> Result<Option<BookkeepingTransaction>, AppError> {
    let parsed = match parse_bookkeeping_email_receipt(&input) {
        Ok(parsed) => parsed,
        Err(err) => {
            record_bookkeeping_sync_failure_inner(
                db,
                RecordBookkeepingSyncFailureInput {
                    source: BookkeepingSource::Gmail,
                    error_code: "gmail.parse_failed".to_string(),
                    raw_error_message: err.code().to_string(),
                },
            )
            .await?;
            return Ok(None);
        }
    };

    // Parser output stays a *hint*: rows always land as needs_review (the upsert
    // hardcodes it on insert and never touches review_status/deleted_at on
    // conflict) and a human confirms every field. Cancellation notices are NOT
    // dropped — they enter the queue carrying `cancellation_notice` so the
    // human decides against the original transaction.
    let direction = match parsed.direction {
        ParsedBookkeepingDirection::Income => BookkeepingDirection::Income,
        ParsedBookkeepingDirection::Expense => BookkeepingDirection::Expense,
    };
    let field_confidence_json = parsed.field_confidence_json();
    let review_reasons_json = merged_review_reasons_json(&parsed);

    let row = upsert_bookkeeping_transaction_from_ingest_inner(
        db,
        CreateBookkeepingTransactionInput {
            project_id: input.project_id,
            source: BookkeepingSource::Gmail,
            source_ref: Some(input.message_id),
            merchant: parsed.merchant,
            description: parsed.description,
            amount_minor: parsed.amount_minor,
            currency: parsed.currency,
            spent_at: parsed.spent_at,
            category: parsed.category,
            note: None,
            // Payment method *kind* is intentionally not confirmed by ingest
            // (models doc: Gmail/OCR에서 확정하지 않고 사람이 리뷰에서 보정).
            payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
            payment_method_label: parsed.payment_method_label,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Variable,
            recurring_expense_id: None,
            recurring_occurrence_id: None,
            direction,
            account: None,
            subcategory: None,
            category_code: None,
            subcategory_code: None,
            raw_category: None,
            spent_at_time: parsed.spent_at_time,
            confidence: parsed.confidence,
            field_confidence_json,
            review_reasons_json,
            order_no: None,
            payment_no: None,
        },
        "transaction.gmail_ingested",
        "Gmail 영수증이 리뷰큐에 추가됨",
    )
    .await?;
    Ok(Some(row))
}

/// Merge parser review reasons with ingest-layer additions, deduped by code.
/// Belt-and-suspenders: a cancellation row must always carry
/// `cancellation_notice` so the review queue explains itself even when a
/// parser variant flags `is_cancellation` without emitting the reason.
fn merged_review_reasons_json(parsed: &ParsedBookkeepingReceipt) -> Option<String> {
    let mut merged = parsed.clone();
    if merged.is_cancellation
        && !merged
            .review_reasons
            .iter()
            .any(|reason| reason.code == "cancellation_notice")
    {
        merged.review_reasons.push(ParsedBookkeepingReviewReason {
            code: "cancellation_notice",
            detail: "취소 알림 — 원거래와 대조해 확인 필요".to_string(),
        });
    }
    let mut seen = std::collections::HashSet::new();
    merged
        .review_reasons
        .retain(|reason| seen.insert(reason.code));
    merged.review_reasons_json()
}

pub(crate) async fn sync_bookkeeping_gmail_receipts_with_provider<P: GmailReadProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    input: SyncBookkeepingGmailReceiptsInput,
) -> Result<BookkeepingGmailSyncResult, AppError> {
    let project_id = clean_required(&input.project_id, "bookkeeping.gmail.project")?;
    ensure_project_exists(db, &project_id, "bookkeeping.gmail.project_not_found").await?;
    let query = clean_optional(input.query.as_deref());
    let max_results = input
        .max_results
        .unwrap_or(DEFAULT_GMAIL_MAX_RESULTS)
        .clamp(1, GMAIL_MAX_RESULTS_CAP);
    let mut label_ids = clean_string_vec(input.label_ids);
    let label_names = clean_string_vec(input.label_names);

    if label_ids.is_empty() && label_names.is_empty() && query.is_none() {
        return Err(AppError::validation(
            "bookkeeping.gmail.filter",
            "Gmail 라벨 또는 검색어를 지정하세요",
        ));
    }

    if !label_names.is_empty() {
        let labels = provider
            .list_labels(access_token)
            .await
            .map_err(AppError::from)?;
        for name in label_names {
            let Some(label) = labels.iter().find(|label| label.name == name) else {
                return Err(AppError::validation(
                    "bookkeeping.gmail.label_not_found",
                    format!("Gmail 라벨을 찾을 수 없습니다: {name}"),
                ));
            };
            label_ids.push(label.id.clone());
        }
    }
    label_ids.sort();
    label_ids.dedup();

    // Incremental polling: the per-project cursor (last seen date) drives a "current-point-forward"
    // query when the caller did not pin an explicit query. A failed sync leaves the cursor unchanged
    // so the next tick retries from the same point.
    let cursor =
        get_bookkeeping_sync_cursor_inner(db, BookkeepingSource::Gmail, &project_id).await?;
    let cursor_before = cursor.map(|c| c.cursor_value);
    let effective_query = match (query, &cursor_before) {
        // Explicit caller query intentionally overrides the cursor (one-shot full rescan).
        (Some(q), _) => Some(q),
        (None, Some(date)) => {
            // Widen one day back so a UTC cursor can't exclude an earlier-in-mailbox-TZ receipt;
            // pagination + source_ref dedup make the redundant re-scan harmless.
            let widened = date_minus_one_day(date).unwrap_or_else(|| date.clone());
            Some(format!("after:{}", widened.replace('-', "/")))
        }
        (None, None) => None,
    };

    // 라벨 결합은 OR(합집합, 2026-07-23 사용자 라벨 규칙 정합) — Gmail API `labelIds`는
    // AND 의미라서 라벨별로 나눠 조회해 합친다. 호출 수 = 라벨 수(수 개 규모)로 유한하고,
    // 각 호출은 provider가 페이지/총량 상한을 건다. 라벨이 없으면 검색어 단독 1회.
    let searches: Vec<GmailMessageSearch> = if label_ids.is_empty() {
        vec![GmailMessageSearch {
            label_ids: Vec::new(),
            query: effective_query,
            max_results,
        }]
    } else {
        label_ids
            .iter()
            .map(|label_id| GmailMessageSearch {
                label_ids: vec![label_id.clone()],
                query: effective_query.clone(),
                max_results,
            })
            .collect()
    };
    let mut ids: Vec<String> = Vec::new();
    for search in &searches {
        match provider.list_message_ids(access_token, search).await {
            Ok(batch) => ids.extend(batch),
            Err(e) => {
                record_bookkeeping_sync_job_inner(
                    db,
                    BookkeepingSource::Gmail,
                    "failed",
                    Some("gmail.list_failed"),
                    Some(&e.to_string()),
                    SyncCounts::default(),
                    cursor_before.as_deref(),
                    None,
                )
                .await?;
                return Err(AppError::from(e));
            }
        }
    }
    // 같은 메일이 여러 라벨에 걸리면 한 번만 처리(순서 보존 dedup).
    let mut seen_ids = std::collections::HashSet::new();
    ids.retain(|id| seen_ids.insert(id.clone()));

    let mut counts = SyncCounts::default();
    let mut max_seen_date = cursor_before.clone();

    for message_id in ids {
        counts.scanned += 1;
        let candidate = match provider
            .get_receipt_candidate(access_token, &message_id)
            .await
        {
            Ok(candidate) => candidate,
            Err(e) => {
                counts.failed += 1;
                record_bookkeeping_sync_status_inner(
                    db,
                    BookkeepingSource::Gmail,
                    "failed",
                    Some("gmail.message_fetch_failed"),
                    Some(&e.to_string()),
                )
                .await?;
                if matches!(e, crate::gmail::GmailError::ReconnectRequired(_)) {
                    return Err(AppError::from(e));
                }
                continue;
            }
        };

        let received_date = candidate.received_at.as_deref().and_then(iso_date_prefix);
        let existed =
            bookkeeping_source_ref_exists(db, BookkeepingSource::Gmail, &candidate.message_id)
                .await?;

        let created = ingest_bookkeeping_gmail_receipt_inner(
            db,
            BookkeepingEmailReceiptInput {
                project_id: Some(project_id.clone()),
                message_id: candidate.message_id,
                from: candidate.from,
                subject: candidate.subject,
                snippet: candidate.snippet,
                body_text: candidate.body_text,
                received_at: candidate.received_at,
            },
        )
        .await?;
        match created {
            Some(_) => {
                if existed {
                    counts.duplicate += 1;
                } else {
                    counts.imported += 1;
                    counts.review_needed += 1;
                }
                if let Some(date) = received_date {
                    if max_seen_date.as_deref().is_none_or(|m| date.as_str() > m) {
                        max_seen_date = Some(date);
                    }
                }
            }
            None => counts.failed += 1,
        }
    }

    let cursor_after = max_seen_date;
    if let Some(after) = cursor_after.as_deref() {
        upsert_bookkeeping_sync_cursor_inner(
            db,
            BookkeepingSource::Gmail,
            &project_id,
            "internal_date",
            after,
        )
        .await?;
    }
    record_bookkeeping_sync_job_inner(
        db,
        BookkeepingSource::Gmail,
        "succeeded",
        None,
        None,
        counts,
        cursor_before.as_deref(),
        cursor_after.as_deref(),
    )
    .await?;

    Ok(BookkeepingGmailSyncResult {
        scanned_count: counts.scanned,
        imported_count: counts.imported,
        duplicate_count: counts.duplicate,
        failed_count: counts.failed,
        cursor_after,
    })
}
