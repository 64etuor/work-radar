//! Pure bookkeeping parsers used by ingest adapters.
//!
//! This module is dependency-light on purpose: std + `serde_json` only.
//! It never touches the DB, keychain, or network — callers (ingest adapters)
//! own persistence and the review-queue policy (imports are hints; a human
//! confirms every row).

#[derive(Debug, Clone)]
pub struct BookkeepingEmailReceiptInput {
    pub project_id: Option<String>,
    pub message_id: String,
    pub from: String,
    pub subject: String,
    pub snippet: String,
    pub body_text: String,
    pub received_at: Option<String>,
}

/// Transaction direction inferred by the parser. Mirrors the ledger's
/// expense/income split without importing the models layer (pure module).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedBookkeepingDirection {
    Expense,
    Income,
}

/// A reason the parsed row deserves human review. Serializable to the
/// `review_reasons_json` convention (`[{"code":…,"detail":…}]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBookkeepingReviewReason {
    pub code: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedBookkeepingReceipt {
    pub merchant: String,
    pub description: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub spent_at: String,
    pub category: String,
    /// `HH:MM:SS`, when the notification carried a transaction time.
    pub spent_at_time: Option<String>,
    pub direction: ParsedBookkeepingDirection,
    /// True for 승인취소/취소 notifications. Rows still parse (so they land in
    /// the review queue) but must not be blindly booked as a fresh expense.
    pub is_cancellation: bool,
    /// e.g. "하나카드" / "카카오뱅크" when the notification names the issuer/bank.
    pub payment_method_label: Option<String>,
    /// Overall confidence 0..=1. `None` for the legacy generic path so ingest
    /// behavior there is byte-for-byte unchanged.
    pub confidence: Option<f64>,
    /// Per-field confidence 0..=1 (keys: amount/spent_at/spent_at_time/merchant/direction).
    pub field_confidence: Vec<(&'static str, f64)>,
    pub review_reasons: Vec<ParsedBookkeepingReviewReason>,
}

impl ParsedBookkeepingReceipt {
    /// JSON object string compatible with `bookkeeping_transactions.field_confidence_json`.
    pub fn field_confidence_json(&self) -> Option<String> {
        if self.field_confidence.is_empty() {
            return None;
        }
        let map: serde_json::Map<String, serde_json::Value> = self
            .field_confidence
            .iter()
            .filter_map(|(key, value)| {
                serde_json::Number::from_f64(*value)
                    .map(|n| ((*key).to_string(), serde_json::Value::Number(n)))
            })
            .collect();
        serde_json::to_string(&serde_json::Value::Object(map)).ok()
    }

    /// JSON array string compatible with `bookkeeping_transactions.review_reasons_json`
    /// (`[{"code":"…","detail":"…"}]`).
    pub fn review_reasons_json(&self) -> Option<String> {
        if self.review_reasons.is_empty() {
            return None;
        }
        let reasons: Vec<serde_json::Value> = self
            .review_reasons
            .iter()
            .map(|reason| serde_json::json!({ "code": reason.code, "detail": reason.detail }))
            .collect();
        serde_json::to_string(&serde_json::Value::Array(reasons)).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookkeepingEmailParseError {
    MissingAmount,
    MissingDate,
}

impl BookkeepingEmailParseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingAmount => "gmail.parse_missing_amount",
            Self::MissingDate => "gmail.parse_missing_date",
        }
    }
}

#[allow(clippy::result_large_err)]
pub fn parse_bookkeeping_email_receipt(
    input: &BookkeepingEmailReceiptInput,
) -> Result<ParsedBookkeepingReceipt, BookkeepingEmailParseError> {
    let text = format!(
        "{}\n{}\n{}",
        input.subject.trim(),
        input.snippet.trim(),
        input.body_text.trim()
    );
    let received_date = input.received_at.as_deref().and_then(extract_date);

    // Korean card/bank transaction-notification lines get a structured,
    // line-oriented parse (merchant tail, MM/DD + time, direction, 취소).
    for line in text.lines() {
        let notification = parse_card_notification_line(line, received_date.as_deref())
            .or_else(|| parse_bank_transfer_line(line, received_date.as_deref()));
        if let Some(parsed_line) = notification {
            return build_receipt_from_notification(
                input,
                &text,
                received_date.as_deref(),
                parsed_line,
            );
        }
    }

    // Legacy generic receipt path — behavior unchanged (confidence stays None).
    let amount_minor =
        extract_won_amount(&text).ok_or(BookkeepingEmailParseError::MissingAmount)?;
    let spent_at = extract_date(&text)
        .or(received_date)
        .ok_or(BookkeepingEmailParseError::MissingDate)?;
    let merchant = extract_merchant(&text)
        .or_else(|| bracketed_subject_label(&input.subject))
        .or_else(|| merchant_from_email(&input.from))
        .unwrap_or_else(|| "unknown merchant".to_string());

    Ok(ParsedBookkeepingReceipt {
        merchant,
        description: non_empty(input.subject.trim()),
        amount_minor,
        currency: "KRW".to_string(),
        spent_at,
        category: "uncategorized".to_string(),
        spent_at_time: None,
        direction: ParsedBookkeepingDirection::Expense,
        is_cancellation: false,
        payment_method_label: None,
        confidence: None,
        field_confidence: Vec::new(),
        review_reasons: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// Korean transaction-notification parsing (card approval / bank transfer).
// ---------------------------------------------------------------------------

/// One structurally-recognized notification line, before receipt assembly.
#[derive(Debug)]
struct KoreanNotificationLine {
    merchant: Option<String>,
    amount_minor: i64,
    /// Fully resolved `YYYY-MM-DD` (year inferred from the mail's internal
    /// date when the line only carried `MM/DD`).
    spent_at: Option<String>,
    date_confidence: f64,
    spent_at_time: Option<String>,
    direction: ParsedBookkeepingDirection,
    is_cancellation: bool,
    payment_method_label: Option<String>,
}

/// SMS-forwarding boilerplate that must not leak into merchant names.
const SMS_NOISE_TOKENS: &[&str] = &["[Web발신]", "[국제발신]", "[국외발신]", "[광고]"];
/// Tokens that introduce a balance/cumulative figure — never the txn amount.
const BALANCE_CONTEXT_PREFIXES: &[&str] = &["잔액", "누적"];
const CARD_CANCEL_KEYWORDS: &[&str] = &["승인취소", "매입취소", "취소"];
const CARD_APPROVAL_KEYWORDS: &[&str] = &["승인", "해외승인", "체크승인", "사용"];
/// Bank/fintech brands that do not end in 은행/뱅크.
const KNOWN_BANK_LABELS: &[&str] = &["토스"];
/// Card issuers that do not end in 카드 (e.g. BC 계열 브랜드 표기).
const KNOWN_CARD_ISSUERS: &[&str] = &["경남BC", "비씨카드"];

/// Card approval/cancellation/usage lines, covering both shapes:
/// - "[Web발신] 하나카드 승인 홍*동 12,345원 일시불 06/18 12:34 스타벅스코리아"
/// - "KB국민카드 6/18 12:34 GS25 서울역점 4,500원 사용"
///
/// Requires issuer + status keyword + amount; anything less falls through to
/// the generic path (near-miss lines never get structured confidence).
fn parse_card_notification_line(
    line: &str,
    received_date: Option<&str>,
) -> Option<KoreanNotificationLine> {
    let mut issuer: Option<String> = None;
    let mut has_status = false;
    let mut cancelled = false;
    let mut amount: Option<i64> = None;
    let mut month_day: Option<(u32, u32)> = None;
    let mut full_date: Option<String> = None;
    let mut time: Option<String> = None;
    let mut merchant_tokens: Vec<&str> = Vec::new();
    let mut previous_number: Option<i64> = None;
    let mut skip_next_won = false;

    for raw in line.split_whitespace() {
        if SMS_NOISE_TOKENS.contains(&raw) {
            continue;
        }
        let token = clean_notification_token(raw);
        if token.is_empty() {
            continue;
        }
        if is_balance_context(token) {
            if !token.contains('원') {
                skip_next_won = true;
            }
            previous_number = None;
            continue;
        }
        if CARD_CANCEL_KEYWORDS.contains(&token) {
            has_status = true;
            cancelled = true;
            continue;
        }
        if CARD_APPROVAL_KEYWORDS.contains(&token) {
            has_status = true;
            continue;
        }
        if issuer.is_none() {
            if let Some(label) = card_issuer_label(token) {
                issuer = Some(label);
                continue;
            }
        }
        if token == "일시불" || is_installment_token(token) {
            continue;
        }
        if token.contains('*') {
            // Masked cardholder name (e.g. 홍*동) — never a merchant.
            continue;
        }
        if let Some(parsed_amount) = parse_won_amount_token(token) {
            if skip_next_won {
                skip_next_won = false;
            } else if amount.is_none() {
                amount = parsed_amount.or(previous_number);
            }
            previous_number = None;
            continue;
        }
        if let Some(date) = extract_date(token) {
            full_date.get_or_insert(date);
            previous_number = None;
            continue;
        }
        if is_full_date_shaped(token) {
            // Date-shaped but not a real calendar date (e.g. 2026-04-31) —
            // contributes no date and must not pollute merchant text.
            previous_number = None;
            continue;
        }
        if let Some(parts) = parse_month_day(token) {
            month_day.get_or_insert(parts);
            previous_number = None;
            continue;
        }
        if let Some(hhmm) = parse_hour_minute(token) {
            time.get_or_insert(hhmm);
            previous_number = None;
            continue;
        }
        if is_pure_number(token) {
            previous_number = parse_amount_digits(token);
            continue;
        }
        previous_number = None;
        merchant_tokens.push(token);
    }

    let issuer = issuer?;
    if !has_status {
        return None;
    }
    let amount = amount.filter(|value| *value > 0 && *value <= i32::MAX as i64)?;
    let (spent_at, date_confidence) = resolve_line_date(full_date, month_day, received_date);

    Some(KoreanNotificationLine {
        merchant: non_empty(&merchant_tokens.join(" ")),
        amount_minor: amount,
        spent_at,
        date_confidence,
        spent_at_time: time,
        direction: ParsedBookkeepingDirection::Expense,
        is_cancellation: cancelled,
        payment_method_label: Some(issuer),
    })
}

/// Bank/fintech in-out notification lines:
/// - "카카오뱅크 06/18 12:34 출금 4,500원 스타벅스 잔액 1,234,567원"
/// - "토스 입금 50,000원 홍길동"
///
/// Requires a direction keyword (입금/출금, incl. 이체출금 등) + amount.
fn parse_bank_transfer_line(
    line: &str,
    received_date: Option<&str>,
) -> Option<KoreanNotificationLine> {
    let mut bank_label: Option<String> = None;
    let mut direction: Option<ParsedBookkeepingDirection> = None;
    let mut amount: Option<i64> = None;
    let mut month_day: Option<(u32, u32)> = None;
    let mut full_date: Option<String> = None;
    let mut time: Option<String> = None;
    let mut counterparty_tokens: Vec<&str> = Vec::new();
    let mut previous_number: Option<i64> = None;
    let mut skip_next_won = false;

    for raw in line.split_whitespace() {
        if SMS_NOISE_TOKENS.contains(&raw) {
            continue;
        }
        let token = clean_notification_token(raw);
        if token.is_empty() {
            continue;
        }
        if is_balance_context(token) {
            if !token.contains('원') {
                skip_next_won = true;
            }
            previous_number = None;
            continue;
        }
        if let Some(parsed_direction) = bank_direction_keyword(token) {
            direction.get_or_insert(parsed_direction);
            continue;
        }
        if bank_label.is_none() {
            if let Some(label) = bank_label_token(token) {
                bank_label = Some(label);
                continue;
            }
        }
        if token.contains('*') {
            continue;
        }
        if let Some(parsed_amount) = parse_won_amount_token(token) {
            if skip_next_won {
                skip_next_won = false;
            } else if amount.is_none() {
                amount = parsed_amount.or(previous_number);
            }
            previous_number = None;
            continue;
        }
        if let Some(date) = extract_date(token) {
            full_date.get_or_insert(date);
            previous_number = None;
            continue;
        }
        if is_full_date_shaped(token) {
            // Date-shaped but not a real calendar date (e.g. 2026-04-31) —
            // contributes no date and must not pollute merchant text.
            previous_number = None;
            continue;
        }
        if let Some(parts) = parse_month_day(token) {
            month_day.get_or_insert(parts);
            previous_number = None;
            continue;
        }
        if let Some(hhmm) = parse_hour_minute(token) {
            time.get_or_insert(hhmm);
            previous_number = None;
            continue;
        }
        if is_pure_number(token) {
            previous_number = parse_amount_digits(token);
            continue;
        }
        previous_number = None;
        counterparty_tokens.push(token);
    }

    let direction = direction?;
    let amount = amount.filter(|value| *value > 0 && *value <= i32::MAX as i64)?;
    let (spent_at, date_confidence) = resolve_line_date(full_date, month_day, received_date);

    Some(KoreanNotificationLine {
        merchant: non_empty(&counterparty_tokens.join(" ")),
        amount_minor: amount,
        spent_at,
        date_confidence,
        spent_at_time: time,
        direction,
        is_cancellation: false,
        payment_method_label: bank_label,
    })
}

#[allow(clippy::result_large_err)]
fn build_receipt_from_notification(
    input: &BookkeepingEmailReceiptInput,
    text: &str,
    received_date: Option<&str>,
    line: KoreanNotificationLine,
) -> Result<ParsedBookkeepingReceipt, BookkeepingEmailParseError> {
    let mut field_confidence: Vec<(&'static str, f64)> = vec![("amount", 0.95)];
    let mut review_reasons: Vec<ParsedBookkeepingReviewReason> = Vec::new();

    let spent_at = if let Some(date) = line.spent_at {
        field_confidence.push(("spent_at", line.date_confidence));
        date
    } else if let Some(date) = extract_date(text) {
        field_confidence.push(("spent_at", 0.6));
        date
    } else if let Some(date) = received_date {
        field_confidence.push(("spent_at", 0.55));
        review_reasons.push(ParsedBookkeepingReviewReason {
            code: "date_from_received_at",
            detail: "거래일 미검출 — 메일 수신일로 대체".to_string(),
        });
        date.to_string()
    } else {
        return Err(BookkeepingEmailParseError::MissingDate);
    };

    let merchant = match line.merchant {
        Some(merchant) => {
            field_confidence.push(("merchant", 0.85));
            merchant
        }
        None => {
            field_confidence.push(("merchant", 0.3));
            review_reasons.push(ParsedBookkeepingReviewReason {
                code: "low_confidence",
                detail: "가맹점/거래처명 미검출".to_string(),
            });
            bracketed_subject_label(&input.subject)
                .filter(|label| label != "Web발신")
                .or_else(|| merchant_from_email(&input.from))
                .unwrap_or_else(|| "unknown merchant".to_string())
        }
    };

    if line.spent_at_time.is_some() {
        field_confidence.push(("spent_at_time", 0.9));
    }
    field_confidence.push(("direction", 0.9));

    if line.is_cancellation {
        review_reasons.push(ParsedBookkeepingReviewReason {
            code: "cancellation_notice",
            detail: "승인취소/취소 알림 — 지출 반영 여부(환불) 확인 필요".to_string(),
        });
    }

    let mut confidence = field_confidence
        .iter()
        .map(|(_, value)| *value)
        .fold(1.0_f64, f64::min);
    if line.is_cancellation {
        // Cancellations must never look like a confidently booked expense.
        confidence = confidence.min(0.5);
    }

    Ok(ParsedBookkeepingReceipt {
        merchant,
        description: non_empty(input.subject.trim()),
        amount_minor: line.amount_minor as i32,
        currency: "KRW".to_string(),
        spent_at,
        category: "uncategorized".to_string(),
        spent_at_time: line.spent_at_time,
        direction: line.direction,
        is_cancellation: line.is_cancellation,
        payment_method_label: line.payment_method_label,
        confidence: Some(confidence),
        field_confidence,
        review_reasons,
    })
}

fn clean_notification_token(raw: &str) -> &str {
    raw.trim_matches(|ch: char| {
        matches!(
            ch,
            '(' | ')' | '[' | ']' | '{' | '}' | ';' | ',' | '.' | '"' | '\''
        )
    })
}

fn is_balance_context(token: &str) -> bool {
    BALANCE_CONTEXT_PREFIXES
        .iter()
        .any(|prefix| token.starts_with(prefix))
}

fn card_issuer_label(token: &str) -> Option<String> {
    if KNOWN_CARD_ISSUERS.contains(&token) {
        return Some(token.to_string());
    }
    if token.ends_with("카드") && token.chars().count() > 2 {
        return Some(token.to_string());
    }
    None
}

fn bank_label_token(token: &str) -> Option<String> {
    if KNOWN_BANK_LABELS.contains(&token) {
        return Some(token.to_string());
    }
    if (token.ends_with("은행") || token.ends_with("뱅크")) && token.chars().count() > 2 {
        return Some(token.to_string());
    }
    None
}

fn bank_direction_keyword(token: &str) -> Option<ParsedBookkeepingDirection> {
    if token == "입금" || token.ends_with("입금") {
        return Some(ParsedBookkeepingDirection::Income);
    }
    if token == "출금" || token.ends_with("출금") {
        return Some(ParsedBookkeepingDirection::Expense);
    }
    None
}

/// `3개월` 등 할부 표기.
fn is_installment_token(token: &str) -> bool {
    token
        .strip_suffix("개월")
        .is_some_and(|months| !months.is_empty() && months.chars().all(|ch| ch.is_ascii_digit()))
}

/// `MM/DD` (year-less) token → validated (month, day).
fn parse_month_day(token: &str) -> Option<(u32, u32)> {
    let (month, day) = token.split_once('/')?;
    if month.is_empty() || month.len() > 2 || day.is_empty() || day.len() > 2 {
        return None;
    }
    if !month.chars().all(|ch| ch.is_ascii_digit()) || !day.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let month: u32 = month.parse().ok()?;
    let day: u32 = day.parse().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some((month, day))
}

/// `HH:MM` token → validated `HH:MM:00`.
fn parse_hour_minute(token: &str) -> Option<String> {
    let (hour, minute) = token.split_once(':')?;
    if hour.is_empty() || hour.len() > 2 || minute.len() != 2 {
        return None;
    }
    if !hour.chars().all(|ch| ch.is_ascii_digit()) || !minute.chars().all(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    (hour < 24 && minute < 60).then(|| format!("{hour:02}:{minute:02}:00"))
}

fn is_pure_number(token: &str) -> bool {
    token.chars().any(|ch| ch.is_ascii_digit())
        && token.chars().all(|ch| ch.is_ascii_digit() || ch == ',')
}

/// Strictly numeric-shaped won amount token.
///
/// - `"12,345원"` (entire token = digits/commas + `원` suffix) → `Some(Some(12345))`
/// - `"원"` alone → `Some(None)` (amount comes from the preceding number token)
/// - `"원스토어"`, `"100원샵"` (merchant-like) → `None` — flows into merchant
///   collection instead of shadowing the real amount.
#[allow(clippy::option_option)]
fn parse_won_amount_token(token: &str) -> Option<Option<i64>> {
    let before = token.strip_suffix('원')?;
    if before.is_empty() {
        return Some(None);
    }
    is_pure_number(before).then(|| parse_amount_digits(before))
}

fn resolve_line_date(
    full_date: Option<String>,
    month_day: Option<(u32, u32)>,
    received_date: Option<&str>,
) -> (Option<String>, f64) {
    if let Some(date) = full_date {
        return (Some(date), 0.9);
    }
    if let (Some((month, day)), Some(received)) = (month_day, received_date) {
        if let Some(resolved) = resolve_month_day_with_year(month, day, received) {
            return (Some(resolved), 0.85);
        }
    }
    (None, 0.0)
}

/// Forward grace for year-less `MM/DD` resolution — a txn may look up to this
/// many days *after* the mail's (possibly UTC) internal date.
const MMDD_FORWARD_GRACE_DAYS: i64 = 7;
/// Backward bound — transaction notifications are near-real-time (at worst a
/// monthly digest), so a candidate further back than this is treated as wrong
/// and the parse falls back to the received date (with a review reason).
const MMDD_BACKWARD_LIMIT_DAYS: i64 = 45;

/// Infer the year for a year-less `MM/DD` from the mail's internal date
/// (`YYYY-MM-DD`). Candidate dates for year-1/year/year+1 are first validated
/// against the real calendar (days-in-month incl. leap rule — `04/31` or a
/// non-leap `02/29` must not be fabricated), then compared against the
/// received date; candidates outside
/// `[-MMDD_BACKWARD_LIMIT_DAYS, +MMDD_FORWARD_GRACE_DAYS]` are rejected and
/// the closest remaining candidate wins. Resolves both directions across new
/// year: 12/31 mail + `01/01` → next year; 01/03 mail + `12/30` → previous
/// year. `None` makes the caller fall back to the received date with a
/// `date_from_received_at` review reason.
fn resolve_month_day_with_year(month: u32, day: u32, received: &str) -> Option<String> {
    let year: i32 = received.get(0..4)?.parse().ok()?;
    let received_month: u32 = received.get(5..7)?.parse().ok()?;
    let received_day: u32 = received.get(8..10)?.parse().ok()?;
    let received_days = days_from_civil(year, received_month, received_day);

    let mut best: Option<(i64, i32)> = None;
    for candidate_year in [year - 1, year, year + 1] {
        if !is_valid_civil_date(candidate_year, month, day) {
            continue;
        }
        let offset = days_from_civil(candidate_year, month, day) - received_days;
        if !(-MMDD_BACKWARD_LIMIT_DAYS..=MMDD_FORWARD_GRACE_DAYS).contains(&offset) {
            continue;
        }
        let distance = offset.abs();
        if best.is_none_or(|(best_distance, _)| distance < best_distance) {
            best = Some((distance, candidate_year));
        }
    }
    let (_, resolved_year) = best?;
    Some(format!("{resolved_year:04}-{month:02}-{day:02}"))
}

/// True when (year, month, day) is a real proleptic-Gregorian calendar date.
fn is_valid_civil_date(year: i32, month: u32, day: u32) -> bool {
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    day <= max_day
}

/// Days since civil epoch 1970-01-01 (Howard Hinnant's `days_from_civil`,
/// proleptic Gregorian, leap-year exact) — used only for date ordering/distance.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = i64::from(if month <= 2 { year - 1 } else { year });
    let m = i64::from(month);
    let d = i64::from(day);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// Generic (legacy) extraction helpers.
// ---------------------------------------------------------------------------

fn extract_merchant(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        for label in ["상호", "상호명", "가맹점", "가맹점명", "merchant", "store"] {
            if let Some(value) = value_after_label(trimmed, label) {
                return Some(value);
            }
        }
    }
    None
}

fn value_after_label(line: &str, label: &str) -> Option<String> {
    let lower_line = line.to_ascii_lowercase();
    let lower_label = label.to_ascii_lowercase();
    let idx = lower_line.find(&lower_label)?;
    let after = line[idx + label.len()..]
        .trim_start_matches(|ch: char| ch == ':' || ch == '-' || ch.is_whitespace())
        .trim();
    let value = after.split(['\n', '\r']).next().unwrap_or_default().trim();
    non_empty(value)
}

fn bracketed_subject_label(subject: &str) -> Option<String> {
    let start = subject.find('[')?;
    let rest = &subject[start + '['.len_utf8()..];
    let end = rest.find(']')?;
    non_empty(rest[..end].trim())
}

fn merchant_from_email(from: &str) -> Option<String> {
    let domain = from.split('@').nth(1)?;
    let first = domain.split('.').next()?.trim();
    non_empty(first)
}

fn extract_won_amount(text: &str) -> Option<i32> {
    let mut amounts = Vec::new();
    let mut previous_number: Option<i64> = None;
    for raw in text.split_whitespace() {
        let token = raw.trim_matches(|ch: char| {
            matches!(
                ch,
                '(' | ')' | '[' | ']' | '{' | '}' | ':' | ';' | ',' | '.'
            )
        });
        if token.contains('원') {
            if let Some(amount) = digits_before_won(token).or(previous_number) {
                amounts.push(amount);
            }
            previous_number = None;
            continue;
        }
        previous_number = parse_amount_digits(token);
    }
    amounts
        .into_iter()
        .filter(|amount| *amount > 0 && *amount <= i32::MAX as i64)
        .max()
        .map(|amount| amount as i32)
}

fn digits_before_won(token: &str) -> Option<i64> {
    let before = token.split('원').next().unwrap_or_default();
    parse_amount_digits(before)
}

fn parse_amount_digits(token: &str) -> Option<i64> {
    let digits = token
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Finds the first `YYYY?MM?DD` (`-`/`.`/`/` separators) that is also a real
/// calendar date. Date-*shaped* but impossible windows (e.g. `2026-04-31`,
/// non-leap `2026-02-29`) are skipped so they can never land in `spent_at` —
/// scanning continues in case a valid date appears later in the text. Shared
/// by the notification path, the legacy generic path, and received-at parsing,
/// so all date sources get the same calendar validation.
fn extract_date(text: &str) -> Option<String> {
    let chars = text.chars().collect::<Vec<_>>();
    for idx in 0..chars.len().saturating_sub(9) {
        let window = &chars[idx..idx + 10];
        if is_date_shaped_window(window) {
            let digit = |ch: char| ch.to_digit(10).unwrap_or(0);
            let year = (digit(window[0]) * 1000
                + digit(window[1]) * 100
                + digit(window[2]) * 10
                + digit(window[3])) as i32;
            let month = digit(window[5]) * 10 + digit(window[6]);
            let day = digit(window[8]) * 10 + digit(window[9]);
            if !is_valid_civil_date(year, month, day) {
                continue;
            }
            return Some(format!("{year:04}-{month:02}-{day:02}"));
        }
    }
    None
}

fn is_date_shaped_window(window: &[char]) -> bool {
    window.len() == 10
        && window[0].is_ascii_digit()
        && window[1].is_ascii_digit()
        && window[2].is_ascii_digit()
        && window[3].is_ascii_digit()
        && matches!(window[4], '-' | '.' | '/')
        && window[5].is_ascii_digit()
        && window[6].is_ascii_digit()
        && matches!(window[7], '-' | '.' | '/')
        && window[8].is_ascii_digit()
        && window[9].is_ascii_digit()
}

/// True when the whole token is date-shaped (`YYYY?MM?DD`), valid or not.
/// The notification loops use this to drop impossible full-date tokens
/// instead of letting them leak into merchant/counterparty text.
fn is_full_date_shaped(token: &str) -> bool {
    let chars = token.chars().collect::<Vec<_>>();
    is_date_shaped_window(&chars)
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn email(
        from: &str,
        subject: &str,
        body: &str,
        received_at: Option<&str>,
    ) -> BookkeepingEmailReceiptInput {
        BookkeepingEmailReceiptInput {
            project_id: None,
            message_id: "gmail-test-1".to_string(),
            from: from.to_string(),
            subject: subject.to_string(),
            snippet: String::new(),
            body_text: body.to_string(),
            received_at: received_at.map(str::to_string),
        }
    }

    fn field_conf(parsed: &ParsedBookkeepingReceipt, key: &str) -> Option<f64> {
        parsed
            .field_confidence
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }

    // -- Family: card approval SMS-forward line ------------------------------

    #[test]
    fn card_approval_sms_line_parses_structured_fields() {
        let input = email(
            "noreply@hanacard.test",
            "카드 승인 안내",
            "[Web발신]\n하나카드 승인 홍*동 12,345원 일시불 06/18 12:34 스타벅스코리아",
            Some("2026-06-20T01:02:03+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("card approval parses");
        assert_eq!(parsed.merchant, "스타벅스코리아");
        assert_eq!(parsed.amount_minor, 12_345);
        assert_eq!(parsed.spent_at, "2026-06-18");
        assert_eq!(parsed.spent_at_time.as_deref(), Some("12:34:00"));
        assert_eq!(parsed.direction, ParsedBookkeepingDirection::Expense);
        assert!(!parsed.is_cancellation);
        assert_eq!(parsed.payment_method_label.as_deref(), Some("하나카드"));
        assert_eq!(parsed.currency, "KRW");

        let confidence = parsed.confidence.expect("structured parse sets confidence");
        assert!((0.5..=1.0).contains(&confidence));
        assert!(field_conf(&parsed, "amount").expect("amount conf") >= 0.9);
        assert!(field_conf(&parsed, "merchant").expect("merchant conf") >= 0.8);
        assert!(field_conf(&parsed, "spent_at").expect("date conf") >= 0.8);

        let json = parsed.field_confidence_json().expect("field json");
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert!(value.is_object(), "field_confidence_json must be an object");
    }

    #[test]
    fn card_line_without_status_keyword_falls_back_to_generic_path() {
        // Near miss: issuer + amount but no 승인/취소/사용 keyword.
        let input = email(
            "alert@hanacard.test",
            "카드 이용 안내",
            "하나카드 안내 홍*동 12,345원 06/18 12:34 스타벅스코리아",
            Some("2026-06-20T01:02:03+09:00"),
        );
        assert!(
            parse_card_notification_line(
                "하나카드 안내 홍*동 12,345원 06/18 12:34 스타벅스코리아",
                Some("2026-06-20"),
            )
            .is_none(),
            "no status keyword → no structured card parse"
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("generic still parses");
        assert!(
            parsed.confidence.is_none(),
            "generic path stays confidence-less"
        );
        assert_ne!(parsed.merchant, "스타벅스코리아");
        assert_eq!(
            parsed.spent_at, "2026-06-20",
            "generic path uses received date"
        );
    }

    #[test]
    fn card_installment_months_are_not_merchant_tokens() {
        let input = email(
            "noreply@lottecard.test",
            "롯데카드 승인",
            "[Web발신] 롯데카드 승인 박*영 240,000원 3개월 06/19 09:10 애플코리아",
            Some("2026-06-20T00:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("installment approval parses");
        assert_eq!(parsed.merchant, "애플코리아");
        assert_eq!(parsed.amount_minor, 240_000);
        assert_eq!(parsed.spent_at, "2026-06-19");
        assert_eq!(parsed.payment_method_label.as_deref(), Some("롯데카드"));
    }

    // -- Family: card usage line (merchant before amount) --------------------

    #[test]
    fn card_usage_line_variant_parses_merchant_between_time_and_amount() {
        let input = email(
            "noreply@kbcard.test",
            "KB국민카드 이용내역",
            "KB국민카드 6/18 12:34 GS25 서울역점 4,500원 사용",
            Some("2026-06-18T13:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("usage line parses");
        assert_eq!(parsed.merchant, "GS25 서울역점");
        assert_eq!(parsed.amount_minor, 4_500);
        assert_eq!(parsed.spent_at, "2026-06-18");
        assert_eq!(parsed.spent_at_time.as_deref(), Some("12:34:00"));
        assert_eq!(parsed.payment_method_label.as_deref(), Some("KB국민카드"));
        assert!(!parsed.is_cancellation);
    }

    // -- Family: cancellation -------------------------------------------------

    #[test]
    fn card_cancellation_is_flagged_for_review() {
        let input = email(
            "noreply@wooricard.test",
            "우리카드 승인취소 안내",
            "[Web발신] 우리카드 승인취소 김*수 30,000원 06/18 15:00 배달의민족",
            Some("2026-06-18T16:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("cancellation parses");
        assert!(parsed.is_cancellation, "취소 keyword must set the flag");
        assert!(
            parsed
                .review_reasons
                .iter()
                .any(|reason| reason.code == "cancellation_notice"),
            "cancellation must carry a review reason"
        );
        let confidence = parsed.confidence.expect("confidence set");
        assert!(
            confidence <= 0.5,
            "cancellation must not look like a confident expense (got {confidence})"
        );
        let json = parsed.review_reasons_json().expect("review reasons json");
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        let reasons = value.as_array().expect("array shape");
        assert!(reasons
            .iter()
            .any(|reason| reason["code"] == "cancellation_notice" && reason["detail"].is_string()));
    }

    // -- Family: bank deposit/withdrawal notifications ------------------------

    #[test]
    fn bank_withdrawal_parses_expense_and_ignores_balance() {
        let input = email(
            "noreply@kakaobank.test",
            "카카오뱅크 출금 알림",
            "카카오뱅크 06/18 12:34 출금 4,500원 스타벅스 잔액 1,234,567원",
            Some("2026-06-18T13:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("withdrawal parses");
        assert_eq!(parsed.direction, ParsedBookkeepingDirection::Expense);
        assert_eq!(parsed.amount_minor, 4_500, "balance figure must not win");
        assert_eq!(parsed.merchant, "스타벅스");
        assert_eq!(parsed.spent_at, "2026-06-18");
        assert_eq!(parsed.payment_method_label.as_deref(), Some("카카오뱅크"));
    }

    #[test]
    fn bank_deposit_parses_income_direction() {
        let input = email(
            "noreply@toss.test",
            "토스 입금 알림",
            "토스 입금 50,000원 홍길동",
            Some("2026-06-18T13:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("deposit parses");
        assert_eq!(
            parsed.direction,
            ParsedBookkeepingDirection::Income,
            "입금 must not become a positive expense"
        );
        assert_eq!(parsed.amount_minor, 50_000);
        assert_eq!(parsed.merchant, "홍길동");
        assert!(field_conf(&parsed, "direction").expect("direction conf") >= 0.9);
    }

    #[test]
    fn bank_counterparty_starting_with_won_is_not_treated_as_amount() {
        let input = email(
            "noreply@toss.test",
            "토스 입금 알림",
            "토스 입금 50,000원 원스토어",
            Some("2026-06-18T13:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("deposit parses");
        assert_eq!(parsed.amount_minor, 50_000);
        assert_eq!(
            parsed.merchant, "원스토어",
            "원-prefixed counterparty must not be eaten as an amount token"
        );
    }

    #[test]
    fn card_merchant_containing_won_does_not_shadow_real_amount() {
        let input = email(
            "noreply@kbcard.test",
            "KB국민카드 이용내역",
            "KB국민카드 6/18 12:34 100원샵 강남점 4,500원 사용",
            Some("2026-06-18T13:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("usage line parses");
        assert_eq!(
            parsed.amount_minor, 4_500,
            "merchant token 100원샵 must not shadow the real amount"
        );
        assert_eq!(parsed.merchant, "100원샵 강남점");
    }

    #[test]
    fn bank_line_without_direction_keyword_is_not_bank_parsed() {
        // Near miss: bank brand + amount, but no 입금/출금 keyword.
        assert!(
            parse_bank_transfer_line("카카오뱅크 이자 지급 안내 4,500원", Some("2026-06-18"))
                .is_none()
        );
        let input = email(
            "noreply@kakaobank.test",
            "카카오뱅크 안내",
            "카카오뱅크 이자 지급 안내 4,500원",
            Some("2026-06-18T13:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("generic fallback");
        assert!(
            parsed.confidence.is_none(),
            "must fall back to generic path"
        );
        assert_eq!(parsed.direction, ParsedBookkeepingDirection::Expense);
    }

    // -- Year inference for year-less MM/DD ----------------------------------

    #[test]
    fn year_less_date_wraps_to_previous_year_across_new_year() {
        let input = email(
            "noreply@wooricard.test",
            "우리카드 승인",
            "[Web발신] 우리카드 승인 김*수 30,000원 일시불 12/31 23:50 배달의민족",
            Some("2026-01-02T09:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("parses");
        assert_eq!(parsed.spent_at, "2025-12-31");
    }

    #[test]
    fn year_less_date_resolves_forward_across_new_year() {
        // HIGH: 12/31 (UTC) mail + 01/01 txn token must land in the NEXT year.
        assert_eq!(
            resolve_month_day_with_year(1, 1, "2025-12-31").as_deref(),
            Some("2026-01-01")
        );
        // 01/03 mail + 12/30 token → previous year.
        assert_eq!(
            resolve_month_day_with_year(12, 30, "2026-01-03").as_deref(),
            Some("2025-12-30")
        );
        // In-year sanity: nearby past date stays in the received year.
        assert_eq!(
            resolve_month_day_with_year(6, 10, "2026-06-16").as_deref(),
            Some("2026-06-10")
        );
    }

    #[test]
    fn card_line_year_boundary_resolves_forward_end_to_end() {
        let input = email(
            "noreply@hanacard.test",
            "하나카드 승인",
            "[Web발신] 하나카드 승인 홍*동 12,000원 일시불 01/01 00:10 스타벅스코리아",
            Some("2025-12-31T15:20:00Z"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("parses");
        assert_eq!(parsed.spent_at, "2026-01-01");
    }

    #[test]
    fn year_less_date_tolerates_utc_skew_without_wrapping() {
        // Mail internal date (UTC) can lag the KST transaction date by a day.
        assert_eq!(
            resolve_month_day_with_year(6, 18, "2026-06-17").as_deref(),
            Some("2026-06-18")
        );
        assert_eq!(
            resolve_month_day_with_year(12, 31, "2026-01-02").as_deref(),
            Some("2025-12-31")
        );
    }

    #[test]
    fn impossible_month_day_candidates_are_rejected() {
        // 2025 is not a leap year, and the nearest real 02/29 (2024) is ~1yr
        // back — outside the backward bound → no candidate.
        assert_eq!(resolve_month_day_with_year(2, 29, "2025-03-01"), None);
        // 2024 IS a leap year: 02/29 one day before the mail is valid.
        assert_eq!(
            resolve_month_day_with_year(2, 29, "2024-03-01").as_deref(),
            Some("2024-02-29")
        );
        // 04/31 exists in no year.
        assert_eq!(resolve_month_day_with_year(4, 31, "2026-05-02"), None);
    }

    #[test]
    fn card_line_with_impossible_date_falls_back_to_received_date() {
        let input = email(
            "noreply@hanacard.test",
            "하나카드 승인",
            "[Web발신] 하나카드 승인 홍*동 9,900원 일시불 04/31 12:00 스타벅스코리아",
            Some("2026-05-02T01:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("parses via received date");
        assert_eq!(
            parsed.spent_at, "2026-05-02",
            "impossible 04/31 must not be fabricated"
        );
        assert!(parsed
            .review_reasons
            .iter()
            .any(|reason| reason.code == "date_from_received_at"));
    }

    #[test]
    fn impossible_full_dates_are_rejected_by_extract_date() {
        assert_eq!(extract_date("2026-04-31"), None);
        assert_eq!(extract_date("2026.02.29"), None, "2026 is not a leap year");
        assert_eq!(extract_date("2024-02-29").as_deref(), Some("2024-02-29"));
        // Invalid window first, valid date later → scanning continues.
        assert_eq!(
            extract_date("정산일 2026-04-31 결제일 2026-04-30").as_deref(),
            Some("2026-04-30")
        );
    }

    #[test]
    fn card_line_with_impossible_full_date_falls_back_to_received_date() {
        let input = email(
            "noreply@hanacard.test",
            "하나카드 승인",
            "[Web발신] 하나카드 승인 홍*동 9,900원 일시불 2026-04-31 12:00 스타벅스코리아",
            Some("2026-05-02T01:00:00+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("parses via received date");
        assert_eq!(
            parsed.spent_at, "2026-05-02",
            "impossible full date must not land in spent_at"
        );
        assert_eq!(
            parsed.merchant, "스타벅스코리아",
            "invalid date token must not leak into merchant"
        );
        assert!(parsed
            .review_reasons
            .iter()
            .any(|reason| reason.code == "date_from_received_at"));
    }

    #[test]
    fn legacy_generic_path_skips_impossible_full_date() {
        let input = email(
            "receipts@coupang.test",
            "[쿠팡] 결제 영수증",
            "상호: 쿠팡\n결제일: 2026.04.31\n결제금액 23,400원",
            Some("2026-05-02T10:11:12+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("legacy receipt parses");
        assert_eq!(
            parsed.spent_at, "2026-05-02",
            "legacy path shares the validated extract_date → received date wins"
        );
        assert_eq!(parsed.merchant, "쿠팡");
    }

    #[test]
    fn card_line_without_any_date_uses_received_date_with_review_reason() {
        let input = email(
            "noreply@hanacard.test",
            "하나카드 승인",
            "하나카드 승인 홍*동 9,900원 일시불 스타벅스코리아",
            Some("2026-06-20T01:02:03+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("parses via received date");
        assert_eq!(parsed.spent_at, "2026-06-20");
        assert!(parsed
            .review_reasons
            .iter()
            .any(|reason| reason.code == "date_from_received_at"));
        assert!(field_conf(&parsed, "spent_at").expect("date conf") < 0.6 + f64::EPSILON);
    }

    // -- Legacy generic path stays intact -------------------------------------

    #[test]
    fn legacy_generic_receipt_still_parses_unchanged() {
        let input = email(
            "receipts@coupang.test",
            "[쿠팡] 결제 영수증",
            "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원",
            Some("2026-06-16T10:11:12+09:00"),
        );
        let parsed = parse_bookkeeping_email_receipt(&input).expect("legacy receipt parses");
        assert_eq!(parsed.merchant, "쿠팡");
        assert_eq!(parsed.amount_minor, 23_400);
        assert_eq!(parsed.spent_at, "2026-06-16");
        assert!(parsed.confidence.is_none());
        assert!(parsed.field_confidence.is_empty());
        assert!(parsed.review_reasons.is_empty());
        assert_eq!(parsed.direction, ParsedBookkeepingDirection::Expense);
        assert!(!parsed.is_cancellation);
        assert!(parsed.field_confidence_json().is_none());
        assert!(parsed.review_reasons_json().is_none());
    }

    #[test]
    fn unparseable_mail_still_reports_missing_amount() {
        let input = email(
            "buyer@example.test",
            "hello",
            "no amount or merchant here",
            Some("2026-06-16T10:11:12+09:00"),
        );
        let err = parse_bookkeeping_email_receipt(&input).expect_err("must fail");
        assert_eq!(err, BookkeepingEmailParseError::MissingAmount);
        assert_eq!(err.code(), "gmail.parse_missing_amount");
    }
}
