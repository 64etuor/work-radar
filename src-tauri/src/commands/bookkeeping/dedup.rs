//! 가계부 중복 거래 후보 탐지 + 중복 마킹.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingDuplicateCandidate, BookkeepingTransaction, FindBookkeepingDuplicateCandidatesInput,
};

use super::*;

#[tauri::command]
#[specta::specta]
pub async fn find_bookkeeping_duplicate_candidates(
    db: State<'_, Db>,
    input: FindBookkeepingDuplicateCandidatesInput,
) -> Result<Vec<BookkeepingDuplicateCandidate>, AppError> {
    find_bookkeeping_duplicate_candidates_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn mark_bookkeeping_duplicate(
    db: State<'_, Db>,
    id: String,
    duplicate_of_transaction_id: String,
) -> Result<BookkeepingTransaction, AppError> {
    mark_bookkeeping_duplicate_inner(db.inner(), &id, &duplicate_of_transaction_id).await
}

/// True if the two merchant strings share any normalized token (emoji/whitespace tolerant).
fn merchant_token_overlap(a: Option<&str>, b: Option<&str>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let a_tokens: std::collections::BTreeSet<String> =
        normalize_label(a).split(' ').map(str::to_string).collect();
    if a_tokens.iter().all(|t| t.is_empty()) {
        return false;
    }
    normalize_label(b)
        .split(' ')
        .any(|t| !t.is_empty() && a_tokens.contains(t))
}

pub(crate) async fn find_bookkeeping_duplicate_candidates_inner(
    db: &Db,
    input: FindBookkeepingDuplicateCandidatesInput,
) -> Result<Vec<BookkeepingDuplicateCandidate>, AppError> {
    validate_date(&input.spent_at)?;
    if input.amount_minor <= 0 {
        return Err(AppError::validation(
            "bookkeeping.duplicate.amount",
            "금액은 0보다 커야 합니다",
        ));
    }
    let order_no = clean_optional(input.order_no.as_deref());
    let payment_no = clean_optional(input.payment_no.as_deref());
    let source_ref = clean_optional(input.source_ref.as_deref());

    // Bounded candidate set: exact amount OR a strong key match. Already-duplicate rows are excluded
    // (we never suggest a row that is itself a duplicate of something else).
    let sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions \
         WHERE (?1 IS NULL OR project_id = ?1) \
           AND (?2 IS NULL OR id != ?2) \
           AND duplicate_of_transaction_id IS NULL \
           AND ( \
             amount_minor = ?3 \
             OR (?4 IS NOT NULL AND order_no = ?4) \
             OR (?5 IS NOT NULL AND payment_no = ?5) \
             OR (?6 IS NOT NULL AND ?7 IS NOT NULL AND source = ?6 AND source_ref = ?7) \
           ) \
         LIMIT 200"
    );
    let rows = sqlx::query_as::<_, BookkeepingTransaction>(&sql)
        .bind(input.project_id.as_deref())
        .bind(input.exclude_transaction_id.as_deref())
        .bind(input.amount_minor)
        .bind(order_no.as_deref())
        .bind(payment_no.as_deref())
        .bind(input.source)
        .bind(source_ref.as_deref())
        .fetch_all(db)
        .await?;

    let mut candidates: Vec<BookkeepingDuplicateCandidate> = rows
        .into_iter()
        .filter_map(|cand| {
            let mut score = 0.0_f64;
            let mut reasons: Vec<String> = Vec::new();

            if let (Some(src), Some(sref)) = (input.source, source_ref.as_deref()) {
                if cand.source == src && cand.source_ref.as_deref() == Some(sref) {
                    score = score.max(1.0);
                    reasons.push("source_ref 일치".to_string());
                }
            }
            if let Some(order) = order_no.as_deref() {
                if cand.order_no.as_deref() == Some(order) {
                    score = score.max(0.95);
                    reasons.push("주문번호 일치".to_string());
                }
            }
            if let Some(payment) = payment_no.as_deref() {
                if cand.payment_no.as_deref() == Some(payment) {
                    score = score.max(0.95);
                    reasons.push("결제번호 일치".to_string());
                }
            }
            if cand.amount_minor == input.amount_minor {
                let merchant_match =
                    merchant_token_overlap(input.merchant.as_deref(), Some(cand.merchant.as_str()));
                match date_diff_days(&cand.spent_at, &input.spent_at) {
                    Some(0) => {
                        score = score.max(if merchant_match { 0.95 } else { 0.8 });
                        reasons.push(if merchant_match {
                            "금액·날짜·상호 일치".to_string()
                        } else {
                            "금액·날짜 일치".to_string()
                        });
                    }
                    Some(diff) if diff <= 3 => {
                        score = score.max(if merchant_match { 0.7 } else { 0.6 });
                        reasons.push(format!("금액 일치 + 날짜 {diff}일 차이"));
                    }
                    _ => {}
                }
            }

            if score > 0.0 {
                Some(BookkeepingDuplicateCandidate {
                    transaction: cand,
                    score,
                    reasons,
                })
            } else {
                None
            }
        })
        .collect();

    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.transaction.spent_at.cmp(&a.transaction.spent_at))
    });
    candidates.truncate(10);
    Ok(candidates)
}

/// `flag`/`mark` 두 경로가 공유하는 진입 검증: trim + 자기참조 금지.
// AppError는 큰 Err 변형 — 레포 관용대로 허용.
#[allow(clippy::result_large_err)]
fn clean_duplicate_pair(id: &str, target: &str) -> Result<(String, String), AppError> {
    let id = clean_required(id, "bookkeeping.duplicate.id")?;
    let target = clean_required(target, "bookkeeping.duplicate.target")?;
    if id == target {
        return Err(AppError::validation(
            "bookkeeping.duplicate.self",
            "거래를 자기 자신의 중복으로 표시할 수 없습니다",
        ));
    }
    Ok((id, target))
}

/// 원본(target)이 실재하고 **자기가 다른 거래의 중복이 아님**을 트랜잭션 안에서 확인한다.
/// 중복 체인 금지 — `duplicate_of_transaction_id`를 한 번 따라가면 항상 원본에 닿아야 한다.
/// `flag`(제안)와 `mark`(사람 확정)가 같은 계약을 쓴다.
async fn ensure_canonical_duplicate_target(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    target: &str,
) -> Result<(), AppError> {
    let target_row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, duplicate_of_transaction_id FROM bookkeeping_transactions WHERE id = ?1",
    )
    .bind(target)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((_, target_duplicate_of)) = target_row else {
        return Err(AppError::not_found(
            "bookkeeping.duplicate.target_not_found",
            "원본 거래를 찾을 수 없습니다",
        ));
    };
    if target_duplicate_of.is_some() {
        return Err(AppError::validation(
            "bookkeeping.duplicate.target_is_duplicate",
            "원본 거래가 이미 다른 거래의 중복으로 표시돼 있습니다",
        ));
    }
    Ok(())
}

/// **제안형 중복 표시(MCP 전용).** `mark_bookkeeping_duplicate_inner`와 달리 `review_status`를
/// 건드리지 않는다 — 행은 `needs_review`에 남고, 링크(`duplicate_of_transaction_id`)와 사유
/// (`possible_duplicate`)만 붙는다. "X는 Y의 중복이다"는 *판단*이고 리뷰 큐에서 치우는 건 사람의
/// 결정이므로, 에이전트는 후보를 짚어줄 뿐 확정하지 않는다(ADR-0012 §2, 사용자 결정 2026-07-10).
///
/// 프런트 `reviewRow.isSuspicious`는 `duplicateOfTransactionId`만 봐도 의심 행으로 표시하므로,
/// 사람은 리뷰 큐에서 곧바로 이 제안을 본다.
///
/// 멱등: 이미 같은 target으로 링크돼 있으면 아무것도 쓰지 않고 현재 행을 돌려준다.
pub(crate) async fn flag_bookkeeping_duplicate_inner(
    db: &Db,
    id: &str,
    duplicate_of_transaction_id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    let (id, target) = clean_duplicate_pair(id, duplicate_of_transaction_id)?;

    let mut tx = db.begin().await?;
    ensure_canonical_duplicate_target(&mut tx, &target).await?;

    let current: Option<(String,)> = sqlx::query_as(
        "SELECT review_reasons_json FROM bookkeeping_transactions WHERE id = ?1 AND deleted_at IS NULL",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((reasons_raw,)) = current else {
        return Err(AppError::not_found(
            "bookkeeping.duplicate.not_found",
            "거래를 찾을 수 없습니다",
        ));
    };
    let mut reasons: Vec<serde_json::Value> =
        serde_json::from_str(&reasons_raw).unwrap_or_default();
    if !reasons
        .iter()
        .any(|r| r.get("code").and_then(|c| c.as_str()) == Some("possible_duplicate"))
    {
        reasons.push(serde_json::json!({
            "code": "possible_duplicate",
            "detail": "에이전트가 중복 후보로 제안함 — 확정은 사람이"
        }));
    }
    let reasons_json = serde_json::Value::Array(reasons).to_string();

    // review_status/deleted_at/direction은 절대 건드리지 않는다.
    let updated = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "UPDATE bookkeeping_transactions SET \
           duplicate_of_transaction_id = ?2, \
           review_reasons_json = ?3, \
           updated_at = datetime('now') \
         WHERE id = ?1 AND deleted_at IS NULL \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    ))
    .bind(&id)
    .bind(&target)
    .bind(&reasons_json)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found("bookkeeping.duplicate.not_found", "거래를 찾을 수 없습니다")
    })?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &id,
        "transaction.flagged_duplicate",
        "중복 후보로 제안됨(리뷰 대기 유지)",
        serde_json::json!({ "duplicateOf": target }),
    )
    .await?;
    tx.commit().await?;
    Ok(updated)
}

/// **사람 확정 경로.** 리뷰 큐에서 치운다(`review_status='ignored'`) — 앱 안 버튼 전용이며
/// MCP 표면에 없다(에이전트는 `flag_bookkeeping_duplicate_inner`로 제안만).
pub(crate) async fn mark_bookkeeping_duplicate_inner(
    db: &Db,
    id: &str,
    duplicate_of_transaction_id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    let (id, target) = clean_duplicate_pair(id, duplicate_of_transaction_id)?;

    let mut tx = db.begin().await?;
    ensure_canonical_duplicate_target(&mut tx, &target).await?;

    let updated = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "UPDATE bookkeeping_transactions SET \
           review_status = 'ignored', \
           duplicate_of_transaction_id = ?2, \
           reviewed_at = datetime('now'), \
           updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    ))
    .bind(&id)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found("bookkeeping.duplicate.not_found", "거래를 찾을 수 없습니다")
    })?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &id,
        "transaction.marked_duplicate",
        "거래가 중복으로 표시됨",
        serde_json::json!({ "duplicateOf": target }),
    )
    .await?;
    tx.commit().await?;
    Ok(updated)
}
