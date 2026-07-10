//! 가계부 공유 상수 + 순수 헬퍼(입력 정제·날짜/월 계산·판단 필드·프로젝트/거래 조회).

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingDirection, BookkeepingTransaction, CreateBookkeepingTransactionInput,
};

/// 설정이 없거나 불량일 때의 최종 폴백 통화(기존 동작 보존). 런타임 기본은
/// `default_currency()`(app_config `bookkeeping.default_currency`)가 정본이다.
pub(crate) const DEFAULT_CURRENCY: &str = "KRW";

/// 앱 기본 통화 app_config 키(범용화 — KRW 하드코딩 제거).
pub(crate) const KEY_DEFAULT_CURRENCY: &str = "bookkeeping.default_currency";

/// 앱 기본 통화(설정 가능). 미설정/불량 값이면 `DEFAULT_CURRENCY`.
pub(crate) async fn default_currency(db: &Db) -> String {
    match crate::commands::nav::get_config(db, KEY_DEFAULT_CURRENCY).await {
        Ok(Some(saved)) => clean_currency(&saved, DEFAULT_CURRENCY)
            .unwrap_or_else(|_| DEFAULT_CURRENCY.to_string()),
        Ok(None) => DEFAULT_CURRENCY.to_string(),
        Err(e) => {
            // fail-closed(KRW)가 맞지만 조용히 삼키면 config 읽기 장애를 진단할 수 없다.
            tracing::debug!(
                code = "bookkeeping.default_currency.read_failed",
                error = %e,
                "app_config read failed; falling back to KRW"
            );
            DEFAULT_CURRENCY.to_string()
        }
    }
}

/// `clean_currency` + 지연 기본값 조회: 값이 비어 있을 때만 설정을 읽는다 —
/// mmbak 벌크 임포트처럼 통화가 항상 채워져 오는 행당 루프에서 불필요한 SELECT를 없앤다.
pub(crate) async fn clean_currency_or_default(db: &Db, value: &str) -> Result<String, AppError> {
    if value.trim().is_empty() {
        let default = default_currency(db).await;
        clean_currency(value, &default)
    } else {
        clean_currency(value, DEFAULT_CURRENCY)
    }
}

pub(crate) const MAX_SYNC_ERROR_LEN: usize = 160;

pub(crate) const DEFAULT_GMAIL_MAX_RESULTS: u32 = 25;

pub(crate) const GMAIL_MAX_RESULTS_CAP: u32 = 100;

pub(crate) const SYNC_JOB_COLUMNS: &str =
    "id, source, status, started_at, finished_at, sanitized_error_code, \
 sanitized_error_message, scanned_count, imported_count, duplicate_count, review_needed_count, \
 failed_count, cursor_before, cursor_after, created_at, updated_at";

/// Per-run ingest counts recorded on a sync job row.
#[derive(Default, Clone, Copy)]
pub(crate) struct SyncCounts {
    pub(crate) scanned: u32,
    pub(crate) imported: u32,
    pub(crate) duplicate: u32,
    pub(crate) review_needed: u32,
    pub(crate) failed: u32,
}

pub(crate) const TRANSACTION_RETURNING_COLUMNS: &str =
    "id, project_id, source, source_ref, merchant, \
 description, amount_minor, currency, spent_at, category, review_status, note, \
 payment_method_kind, payment_method_label, payment_method_last4, expense_kind, \
 recurring_expense_id, recurring_occurrence_id, direction, account, subcategory, category_code, \
 subcategory_code, raw_category, spent_at_time, confidence, field_confidence_json, \
 review_reasons_json, duplicate_of_transaction_id, order_no, payment_no, created_at, updated_at, \
 reviewed_at, deleted_at";

pub(crate) const RECURRING_EXPENSE_RETURNING_COLUMNS: &str =
    "id, project_id, name, merchant, amount_minor, \
 currency, category, payment_method_kind, payment_method_label, payment_method_last4, \
 expense_kind, schedule_day, start_month, end_month, status, note, source, source_ref, \
 created_at, updated_at";

pub(crate) const BUDGET_RETURNING_COLUMNS: &str =
    "id, project_id, month, category_code, limit_minor, \
 currency, rollover, note, created_at, updated_at";

/// Extract a YYYY-MM-DD date prefix from an ISO timestamp (e.g. "2026-06-16T10:11:12Z").
pub(crate) fn iso_date_prefix(value: &str) -> Option<String> {
    if value.len() >= 10 && validate_date(&value[..10]).is_ok() {
        Some(value[..10].to_string())
    } else {
        None
    }
}

/// Days since civil epoch (Howard Hinnant's algorithm) for YYYY-MM-DD date diffing without a date
/// crate. Returns None if the string is not a valid YYYY-MM-DD.
fn parse_ymd(value: &str) -> Option<(i64, i64, i64)> {
    if value.len() != 10 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = value[0..4].parse().ok()?;
    let m: i64 = value[5..7].parse().ok()?;
    let d: i64 = value[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub(crate) fn date_diff_days(a: &str, b: &str) -> Option<i64> {
    let (ay, am, ad) = parse_ymd(a)?;
    let (by, bm, bd) = parse_ymd(b)?;
    Some((days_from_civil(ay, am, ad) - days_from_civil(by, bm, bd)).abs())
}

/// Inverse of `days_from_civil` (Howard Hinnant).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// One day before `date` (YYYY-MM-DD). Widens the Gmail `after:` window so a UTC cursor date can't
/// exclude a receipt that falls on an earlier day in the mailbox timezone (re-scan + source_ref dedup
/// absorbs the overlap).
pub(crate) fn date_minus_one_day(date: &str) -> Option<String> {
    let (y, m, d) = parse_ymd(date)?;
    let (py, pm, pd) = civil_from_days(days_from_civil(y, m, d) - 1);
    Some(format!("{py:04}-{pm:02}-{pd:02}"))
}

pub(crate) async fn fetch_bookkeeping_transaction(
    db: &Db,
    id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| {
        AppError::not_found(
            "bookkeeping.transaction_not_found",
            "거래를 찾을 수 없습니다",
        )
    })?;
    Ok(row)
}

#[allow(clippy::result_large_err)]
pub(crate) fn clean_required(value: &str, code: &str) -> Result<String, AppError> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        return Err(AppError::validation(code, "필수 값을 입력하세요"));
    }
    Ok(cleaned.to_string())
}

pub(crate) fn clean_optional(value: Option<&str>) -> Option<String> {
    value.and_then(|v| {
        let cleaned = v.trim();
        (!cleaned.is_empty()).then(|| cleaned.to_string())
    })
}

pub(crate) fn clean_string_vec(values: Vec<String>) -> Vec<String> {
    let mut cleaned = values
        .into_iter()
        .filter_map(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        })
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned.dedup();
    cleaned
}

/// Validate a project FK, surfacing a caller-supplied `not_found` code so each
/// flow (gmail / budget / reconcile) keeps its own domain-scoped error code.
pub(crate) async fn ensure_project_exists(
    db: &Db,
    project_id: &str,
    not_found_code: &'static str,
) -> Result<(), AppError> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?;
    if exists.is_some() {
        Ok(())
    } else {
        Err(AppError::not_found(not_found_code, "project not found"))
    }
}

/// 통화 코드 정제. 빈 값은 `default`(호출자가 `default_currency()`로 조회한 앱 기본값)로
/// 치환한다 — KRW 하드코딩 대신 설정을 따르게 하는 범용화 지점.
#[allow(clippy::result_large_err)]
pub(crate) fn clean_currency(value: &str, default: &str) -> Result<String, AppError> {
    let raw = value.trim();
    let cleaned = if raw.is_empty() {
        default.to_string()
    } else {
        raw.to_ascii_uppercase()
    };
    if cleaned.len() != 3 || !cleaned.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(AppError::validation(
            "bookkeeping.currency",
            "통화 코드는 3자리 영문이어야 합니다",
        ));
    }
    Ok(cleaned)
}

#[allow(clippy::result_large_err)]
pub(crate) fn parse_bookkeeping_direction(value: &str) -> Result<BookkeepingDirection, AppError> {
    match value.trim() {
        "expense" => Ok(BookkeepingDirection::Expense),
        "income" => Ok(BookkeepingDirection::Income),
        _ => Err(AppError::validation(
            "bookkeeping.direction",
            "수입/지출은 expense 또는 income이어야 합니다",
        )),
    }
}

#[allow(clippy::result_large_err)]
pub(crate) fn clean_payment_last4(value: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = clean_optional(value) else {
        return Ok(None);
    };
    if value.len() > 8 || !value.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::validation(
            "bookkeeping.payment_last4",
            "결제수단 끝자리는 8자 이하 영문/숫자만 입력하세요",
        ));
    }
    Ok(Some(value))
}

/// Cleaned + validated judgment fields shared by the manual-create and ingest-upsert paths.
pub(crate) struct JudgmentFields {
    pub(crate) direction: BookkeepingDirection,
    pub(crate) account: Option<String>,
    pub(crate) subcategory: Option<String>,
    pub(crate) category_code: Option<String>,
    pub(crate) subcategory_code: Option<String>,
    pub(crate) raw_category: Option<String>,
    pub(crate) spent_at_time: Option<String>,
    pub(crate) confidence: Option<f64>,
    pub(crate) field_confidence_json: String,
    pub(crate) review_reasons_json: String,
    pub(crate) order_no: Option<String>,
    pub(crate) payment_no: Option<String>,
}

#[allow(clippy::result_large_err)]
pub(crate) fn prepare_judgment_fields(
    input: &CreateBookkeepingTransactionInput,
) -> Result<JudgmentFields, AppError> {
    let spent_at_time = clean_optional(input.spent_at_time.as_deref());
    if let Some(time) = spent_at_time.as_deref() {
        validate_time(time)?;
    }
    if let Some(confidence) = input.confidence {
        if confidence.is_nan() || !(0.0..=1.0).contains(&confidence) {
            return Err(AppError::validation(
                "bookkeeping.confidence",
                "신뢰도는 0~1 범위여야 합니다",
            ));
        }
    }
    let field_confidence_json = clean_json(
        input.field_confidence_json.as_deref(),
        JsonShape::Object,
        "bookkeeping.field_confidence",
    )?;
    let review_reasons_json = clean_json(
        input.review_reasons_json.as_deref(),
        JsonShape::Array,
        "bookkeeping.review_reasons",
    )?;
    Ok(JudgmentFields {
        direction: input.direction,
        account: clean_optional(input.account.as_deref()),
        subcategory: clean_optional(input.subcategory.as_deref()),
        category_code: clean_optional(input.category_code.as_deref()),
        subcategory_code: clean_optional(input.subcategory_code.as_deref()),
        raw_category: clean_optional(input.raw_category.as_deref()),
        spent_at_time,
        confidence: input.confidence,
        field_confidence_json,
        review_reasons_json,
        order_no: clean_optional(input.order_no.as_deref()),
        payment_no: clean_optional(input.payment_no.as_deref()),
    })
}

#[derive(Clone, Copy)]
enum JsonShape {
    Object,
    Array,
}

const MAX_JSON_PAYLOAD_LEN: usize = 4000;

#[allow(clippy::result_large_err)]
fn clean_json(value: Option<&str>, shape: JsonShape, code: &str) -> Result<String, AppError> {
    let default = match shape {
        JsonShape::Object => "{}",
        JsonShape::Array => "[]",
    };
    let Some(raw) = clean_optional(value) else {
        return Ok(default.to_string());
    };
    if raw.len() > MAX_JSON_PAYLOAD_LEN {
        return Err(AppError::validation(code, "JSON 페이로드가 너무 큽니다"));
    }
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| AppError::validation(code, "유효한 JSON이 아닙니다"))?;
    let shape_ok = match shape {
        JsonShape::Object => parsed.is_object(),
        JsonShape::Array => parsed.is_array(),
    };
    if !shape_ok {
        return Err(AppError::validation(code, "JSON 구조가 올바르지 않습니다"));
    }
    Ok(raw)
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_time(value: &str) -> Result<(), AppError> {
    let err = || AppError::validation("bookkeeping.time", "시간은 HH:MM:SS 형식이어야 합니다");
    let bytes = value.as_bytes();
    let structural_ok = value.len() == 8
        && bytes[2] == b':'
        && bytes[5] == b':'
        && value
            .bytes()
            .enumerate()
            .all(|(idx, b)| idx == 2 || idx == 5 || b.is_ascii_digit());
    if !structural_ok {
        return Err(err());
    }
    let hh: u32 = value[0..2].parse().map_err(|_| err())?;
    let mm: u32 = value[3..5].parse().map_err(|_| err())?;
    let ss: u32 = value[6..8].parse().map_err(|_| err())?;
    if hh > 23 || mm > 59 || ss > 59 {
        return Err(err());
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_date(value: &str) -> Result<(), AppError> {
    if value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(idx, b)| idx == 4 || idx == 7 || b.is_ascii_digit())
    {
        return Ok(());
    }
    Err(AppError::validation(
        "bookkeeping.date",
        "날짜는 YYYY-MM-DD 형식이어야 합니다",
    ))
}

#[allow(clippy::result_large_err)]
pub(crate) fn validate_month(value: &str) -> Result<(i32, u32), AppError> {
    if value.len() != 7 || value.as_bytes()[4] != b'-' {
        return Err(AppError::validation(
            "bookkeeping.month",
            "월은 YYYY-MM 형식이어야 합니다",
        ));
    }
    let year: i32 = value[..4]
        .parse()
        .map_err(|_| AppError::validation("bookkeeping.month", "월은 YYYY-MM 형식이어야 합니다"))?;
    let mon: u32 = value[5..7]
        .parse()
        .map_err(|_| AppError::validation("bookkeeping.month", "월은 YYYY-MM 형식이어야 합니다"))?;
    if !(1..=12).contains(&mon) {
        return Err(AppError::validation(
            "bookkeeping.month",
            "월은 01~12 범위여야 합니다",
        ));
    }
    Ok((year, mon))
}

#[allow(clippy::result_large_err)]
pub(crate) fn month_bounds(month: &str) -> Result<(String, String), AppError> {
    let (year, mon) = validate_month(month)?;
    let (next_year, next_mon) = if mon == 12 {
        (year + 1, 1)
    } else {
        (year, mon + 1)
    };
    Ok((
        format!("{year:04}-{mon:02}-01"),
        format!("{next_year:04}-{next_mon:02}-01"),
    ))
}

#[allow(clippy::result_large_err)]
pub(crate) fn bounded_months(from_month: &str, to_month: &str) -> Result<Vec<String>, AppError> {
    let (from_year, from_mon) = validate_month(from_month)?;
    let (to_year, to_mon) = validate_month(to_month)?;
    let from_idx = month_index(from_year, from_mon);
    let to_idx = month_index(to_year, to_mon);
    if from_idx > to_idx {
        return Err(AppError::validation(
            "bookkeeping.report.range",
            "시작 월은 종료 월보다 늦을 수 없습니다",
        ));
    }
    let len = to_idx - from_idx + 1;
    if len > 24 {
        return Err(AppError::validation(
            "bookkeeping.report.range",
            "리포트 범위는 최대 24개월입니다",
        ));
    }
    Ok((from_idx..=to_idx).map(month_from_index).collect())
}

fn month_index(year: i32, mon: u32) -> i32 {
    year.saturating_mul(12) + mon as i32 - 1
}

fn month_from_index(index: i32) -> String {
    let year = index.div_euclid(12);
    let mon = index.rem_euclid(12) + 1;
    format!("{year:04}-{mon:02}")
}

#[allow(clippy::result_large_err)]
pub(crate) fn previous_month(month: &str) -> Result<String, AppError> {
    let (year, mon) = validate_month(month)?;
    let (prev_year, prev_mon) = if mon == 1 {
        (year - 1, 12)
    } else {
        (year, mon - 1)
    };
    Ok(format!("{prev_year:04}-{prev_mon:02}"))
}

pub(crate) fn last_day_of_month(year: i32, mon: u32) -> u32 {
    match mon {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 28,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
