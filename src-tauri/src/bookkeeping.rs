//! Pure bookkeeping parsers used by ingest adapters.

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBookkeepingReceipt {
    pub merchant: String,
    pub description: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub spent_at: String,
    pub category: String,
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
    let amount_minor =
        extract_won_amount(&text).ok_or(BookkeepingEmailParseError::MissingAmount)?;
    let spent_at = extract_date(&text)
        .or_else(|| input.received_at.as_deref().and_then(extract_date))
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
    })
}

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

fn extract_date(text: &str) -> Option<String> {
    let chars = text.chars().collect::<Vec<_>>();
    for idx in 0..chars.len().saturating_sub(9) {
        let window = &chars[idx..idx + 10];
        if window[0].is_ascii_digit()
            && window[1].is_ascii_digit()
            && window[2].is_ascii_digit()
            && window[3].is_ascii_digit()
            && matches!(window[4], '-' | '.' | '/')
            && window[5].is_ascii_digit()
            && window[6].is_ascii_digit()
            && matches!(window[7], '-' | '.' | '/')
            && window[8].is_ascii_digit()
            && window[9].is_ascii_digit()
        {
            return Some(format!(
                "{}{}{}{}-{}{}-{}{}",
                window[0],
                window[1],
                window[2],
                window[3],
                window[5],
                window[6],
                window[8],
                window[9]
            ));
        }
    }
    None
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}
