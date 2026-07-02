//! 가계부 카테고리 분류 체계·규칙·별칭·오버라이드 해석.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingAliasMatchKind, BookkeepingCategoryAlias, BookkeepingCategoryNode,
    BookkeepingCategoryOverride, BookkeepingCategoryRules, BookkeepingTransaction,
    OverrideBookkeepingCategoryInput,
};

use super::*;

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_list_taxonomy(
    db: State<'_, Db>,
) -> Result<Vec<BookkeepingCategoryNode>, AppError> {
    list_bookkeeping_taxonomy_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_get_category_rules(
    db: State<'_, Db>,
) -> Result<BookkeepingCategoryRules, AppError> {
    bookkeeping_category_rules_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn override_bookkeeping_category(
    db: State<'_, Db>,
    input: OverrideBookkeepingCategoryInput,
) -> Result<BookkeepingTransaction, AppError> {
    override_bookkeeping_category_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_category_overrides(
    db: State<'_, Db>,
    transaction_id: String,
) -> Result<Vec<BookkeepingCategoryOverride>, AppError> {
    list_bookkeeping_category_overrides_inner(db.inner(), &transaction_id).await
}

/// Resolver output: a resolved taxonomy code pair + confidence (None = caller-authoritative).
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedCategory {
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    pub confidence: Option<f64>,
}

/// Normalize a category/merchant label for matching: keep alphanumerics (incl. Hangul), collapse
/// whitespace, drop emoji/symbols. "🪑 생활용품" → "생활용품"; "주유·충전" → "주유 충전" (· dropped).
pub(crate) fn normalize_label(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            out.push(ch);
            pending_space = false;
        } else if ch.is_whitespace() {
            pending_space = true;
        }
        // emoji / punctuation are dropped
    }
    out.trim().to_string()
}

pub(crate) async fn list_bookkeeping_taxonomy_inner(
    db: &Db,
) -> Result<Vec<BookkeepingCategoryNode>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingCategoryNode>(
        "SELECT code, parent_code, label, sort_order, active \
         FROM bookkeeping_category_taxonomy \
         ORDER BY sort_order ASC, code ASC",
    )
    .fetch_all(db)
    .await?)
}

pub(crate) async fn list_bookkeeping_category_aliases_inner(
    db: &Db,
) -> Result<Vec<BookkeepingCategoryAlias>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingCategoryAlias>(
        "SELECT id, pattern, match_kind, category_code, subcategory_code, confidence, source, \
           created_at, hit_count, last_used_at \
         FROM bookkeeping_category_alias \
         ORDER BY match_kind ASC, pattern ASC",
    )
    .fetch_all(db)
    .await?)
}

pub(crate) async fn bookkeeping_category_rules_inner(
    db: &Db,
) -> Result<BookkeepingCategoryRules, AppError> {
    Ok(BookkeepingCategoryRules {
        taxonomy: list_bookkeeping_taxonomy_inner(db).await?,
        aliases: list_bookkeeping_category_aliases_inner(db).await?,
    })
}

/// Resolve a taxonomy code from caller hints. Precedence: explicit `provided_code` → a non-sentinel
/// `category_hint` that is a real taxonomy code → raw-label alias → raw-label taxonomy match →
/// merchant alias → `uncategorized`. Tolerates codes absent from the taxonomy (soft ref).
pub(crate) async fn resolve_category_inner(
    db: &Db,
    provided_code: Option<&str>,
    provided_subcategory: Option<&str>,
    category_hint: &str,
    raw_category: Option<&str>,
    merchant: &str,
) -> Result<ResolvedCategory, AppError> {
    if let Some(code) = provided_code.map(str::trim).filter(|c| !c.is_empty()) {
        return Ok(ResolvedCategory {
            category_code: Some(code.to_string()),
            subcategory_code: provided_subcategory
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            confidence: None,
        });
    }

    let rules = bookkeeping_category_rules_inner(db).await?;
    Ok(resolve_category_with_rules(
        &rules,
        provided_subcategory,
        category_hint,
        raw_category,
        merchant,
    ))
}

/// Pure resolver body over pre-fetched rules — lets batch callers (mmbak taxonomy sync/backfill)
/// resolve many labels with one rules fetch. Same precedence as `resolve_category_inner` minus
/// the `provided_code` short-circuit (handled by the caller).
pub(crate) fn resolve_category_with_rules(
    rules: &crate::models::BookkeepingCategoryRules,
    provided_subcategory: Option<&str>,
    category_hint: &str,
    raw_category: Option<&str>,
    merchant: &str,
) -> ResolvedCategory {
    // A non-sentinel category hint that is itself a real top-level/sub code is honored as-is.
    let hint = category_hint.trim();
    if !hint.is_empty() && hint != "uncategorized" && rules.taxonomy.iter().any(|n| n.code == hint)
    {
        return ResolvedCategory {
            category_code: Some(hint.to_string()),
            subcategory_code: provided_subcategory
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            confidence: None,
        };
    }

    if let Some(raw) = raw_category {
        let norm = normalize_label(raw);
        if !norm.is_empty() {
            if let Some(alias) = rules.aliases.iter().find(|a| {
                a.match_kind == BookkeepingAliasMatchKind::RawLabel
                    && normalize_label(&a.pattern) == norm
            }) {
                return ResolvedCategory {
                    category_code: Some(alias.category_code.clone()),
                    subcategory_code: alias.subcategory_code.clone(),
                    confidence: Some(alias.confidence),
                };
            }
            if let Some(node) = rules
                .taxonomy
                .iter()
                .find(|n| n.active && normalize_label(&n.label) == norm)
            {
                let (category_code, subcategory_code) = match &node.parent_code {
                    Some(parent) => (parent.clone(), Some(node.code.clone())),
                    None => (node.code.clone(), None),
                };
                return ResolvedCategory {
                    category_code: Some(category_code),
                    subcategory_code,
                    confidence: Some(0.95),
                };
            }
        }
    }

    let merchant = merchant.trim();
    if !merchant.is_empty() {
        if let Some(alias) = rules.aliases.iter().find(|a| {
            a.match_kind == BookkeepingAliasMatchKind::Merchant && a.pattern.trim() == merchant
        }) {
            return ResolvedCategory {
                category_code: Some(alias.category_code.clone()),
                subcategory_code: alias.subcategory_code.clone(),
                confidence: Some(alias.confidence),
            };
        }
    }

    ResolvedCategory {
        category_code: Some("uncategorized".to_string()),
        subcategory_code: None,
        confidence: Some(0.0),
    }
}

async fn category_labels_for_codes(
    db: &Db,
    category_code: Option<&str>,
    subcategory_code: Option<&str>,
) -> Result<(String, Option<String>), AppError> {
    let category_label = match category_code {
        Some(code) => taxonomy_label(db, code)
            .await?
            .unwrap_or_else(|| code.to_string()),
        None => "미분류".to_string(),
    };
    let subcategory_label = match subcategory_code {
        Some(code) => Some(
            taxonomy_label(db, code)
                .await?
                .unwrap_or_else(|| code.to_string()),
        ),
        None => None,
    };
    Ok((category_label, subcategory_label))
}

async fn taxonomy_label(db: &Db, code: &str) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT label FROM bookkeeping_category_taxonomy WHERE code = ?1")
            .bind(code)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(label,)| label))
}

pub(crate) async fn override_bookkeeping_category_inner(
    db: &Db,
    input: OverrideBookkeepingCategoryInput,
) -> Result<BookkeepingTransaction, AppError> {
    let tx_id = clean_required(&input.transaction_id, "bookkeeping.override.transaction_id")?;
    let to_code = clean_optional(input.category_code.as_deref());
    let to_subcategory = clean_optional(input.subcategory_code.as_deref());
    let reason = clean_optional(input.reason.as_deref());
    let (category_label, subcategory_label) =
        category_labels_for_codes(db, to_code.as_deref(), to_subcategory.as_deref()).await?;

    let mut tx = db.begin().await?;
    let current: (Option<String>, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT category_code, subcategory_code, merchant, raw_category \
         FROM bookkeeping_transactions WHERE id = ?1",
    )
    .bind(&tx_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found("bookkeeping.override.not_found", "거래를 찾을 수 없습니다")
    })?;

    sqlx::query(
        "UPDATE bookkeeping_transactions SET category = ?2, subcategory = ?3, \
           category_code = ?4, subcategory_code = ?5, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(&tx_id)
    .bind(&category_label)
    .bind(subcategory_label.as_deref())
    .bind(to_code.as_deref())
    .bind(to_subcategory.as_deref())
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO bookkeeping_category_overrides \
         (id, transaction_id, from_code, to_code, from_subcategory_code, to_subcategory_code, \
          actor, reason) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'user', ?6)",
    )
    .bind(&tx_id)
    .bind(current.0.as_deref())
    .bind(to_code.as_deref())
    .bind(current.1.as_deref())
    .bind(to_subcategory.as_deref())
    .bind(reason.as_deref())
    .execute(&mut *tx)
    .await?;

    if let Some(to_code) = to_code.as_deref() {
        reinforce_category_alias_tx(
            &mut tx,
            &current.2,
            current.3.as_deref(),
            to_code,
            to_subcategory.as_deref(),
        )
        .await?;
    }

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &tx_id,
        "transaction.category_overridden",
        "거래 분류가 수동 보정됨",
        serde_json::json!({ "toCode": to_code, "toSubcategoryCode": to_subcategory }),
    )
    .await?;
    tx.commit().await?;

    let row = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions WHERE id = ?1"
    ))
    .bind(&tx_id)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub(crate) async fn list_bookkeeping_category_overrides_inner(
    db: &Db,
    transaction_id: &str,
) -> Result<Vec<BookkeepingCategoryOverride>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingCategoryOverride>(
        "SELECT id, transaction_id, from_code, to_code, from_subcategory_code, \
           to_subcategory_code, actor, reason, created_at \
         FROM bookkeeping_category_overrides \
         WHERE transaction_id = ?1 \
         ORDER BY created_at DESC, id DESC \
         LIMIT 100",
    )
    .bind(transaction_id)
    .fetch_all(db)
    .await?)
}

async fn reinforce_category_alias_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    merchant: &str,
    raw_category: Option<&str>,
    category_code: &str,
    subcategory_code: Option<&str>,
) -> Result<(), sqlx::Error> {
    let (match_kind, pattern) = raw_category
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|raw| ("raw_label", normalize_label(raw)))
        .filter(|(_, pattern)| !pattern.is_empty())
        .unwrap_or_else(|| ("merchant", merchant.trim().to_string()));
    if pattern.is_empty() {
        return Ok(());
    }

    sqlx::query(
        "INSERT INTO bookkeeping_category_alias \
         (id, pattern, match_kind, category_code, subcategory_code, confidence, source, hit_count, last_used_at) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, 0.96, 'user', 1, datetime('now')) \
         ON CONFLICT(match_kind, pattern) DO UPDATE SET \
           category_code = excluded.category_code, \
           subcategory_code = excluded.subcategory_code, \
           confidence = max(bookkeeping_category_alias.confidence, excluded.confidence), \
           source = 'user', \
           hit_count = bookkeeping_category_alias.hit_count + 1, \
           last_used_at = datetime('now')",
    )
    .bind(pattern)
    .bind(match_kind)
    .bind(category_code)
    .bind(subcategory_code)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ── Line items (Phase C) ────────────────────────────────────────────────────────────────────────

/// Fill `category_code`/`subcategory_code`/`confidence` from the taxonomy resolver when the caller
/// did not provide a code. Caller-provided codes and confidence are never overwritten.
pub(crate) async fn apply_category_resolution(
    db: &Db,
    jf: &mut JudgmentFields,
    category_hint: &str,
    merchant: &str,
) -> Result<(), AppError> {
    if jf.category_code.is_some() {
        return Ok(());
    }
    let resolved = resolve_category_inner(
        db,
        None,
        jf.subcategory_code.as_deref(),
        category_hint,
        jf.raw_category.as_deref(),
        merchant,
    )
    .await?;
    jf.category_code = resolved.category_code;
    if jf.subcategory_code.is_none() {
        jf.subcategory_code = resolved.subcategory_code;
    }
    if jf.confidence.is_none() {
        jf.confidence = resolved.confidence;
    }
    if let Some(confidence) = resolved.confidence {
        write_category_field_confidence(jf, confidence)?;
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
fn write_category_field_confidence(
    jf: &mut JudgmentFields,
    confidence: f64,
) -> Result<(), AppError> {
    let mut value: serde_json::Value =
        serde_json::from_str(&jf.field_confidence_json).map_err(|_| {
            AppError::validation("bookkeeping.field_confidence", "유효한 JSON이 아닙니다")
        })?;
    let Some(object) = value.as_object_mut() else {
        return Err(AppError::validation(
            "bookkeeping.field_confidence",
            "JSON 구조가 올바르지 않습니다",
        ));
    };
    object.insert("category".to_string(), serde_json::json!(confidence));
    jf.field_confidence_json = value.to_string();
    Ok(())
}
