use sha2::{Digest, Sha256};

use crate::models::{
    BookkeepingDirection, BookkeepingLineItem, BookkeepingSource, BookkeepingTransaction,
};

#[derive(Debug, Clone)]
pub struct BookkeepingExportRow {
    pub transaction: BookkeepingTransaction,
    pub line_items: Vec<BookkeepingLineItem>,
}

pub fn export_csv(rows: &[BookkeepingExportRow]) -> String {
    let mut out = String::from(
        "\u{feff}날짜,시각,자산,분류,소분류,내용,수입·지출,금액,화폐,메모,가맹점,source,sourceRef\n",
    );
    for row in rows {
        let tx = &row.transaction;
        push_csv_record(
            &mut out,
            &[
                tx.spent_at.as_str(),
                tx.spent_at_time.as_deref().unwrap_or(""),
                tx.account.as_deref().unwrap_or(""),
                tx.category.as_str(),
                tx.subcategory.as_deref().unwrap_or(""),
                tx.description.as_deref().unwrap_or(""),
                direction_label(tx.direction),
                format_minor(tx.amount_minor, &tx.currency).as_str(),
                tx.currency.as_str(),
                tx.note.as_deref().unwrap_or(""),
                tx.merchant.as_str(),
                source_label(tx.source),
                tx.source_ref.as_deref().unwrap_or(""),
            ],
        );
    }
    out
}

pub fn export_qif(rows: &[BookkeepingExportRow]) -> String {
    let mut out = String::from("!Type:Bank\n");
    for row in rows {
        let tx = &row.transaction;
        out.push('D');
        out.push_str(&qif_date(&tx.spent_at));
        out.push('\n');
        out.push('T');
        out.push_str(&signed_amount(tx));
        out.push('\n');
        out.push('P');
        out.push_str(&qif_text(&tx.merchant));
        out.push('\n');
        out.push('L');
        out.push_str(&qif_category(tx));
        out.push('\n');
        if let Some(note) = tx.note.as_deref().or(tx.description.as_deref()) {
            out.push('M');
            out.push_str(&qif_text(note));
            out.push('\n');
        }
        for item in &row.line_items {
            out.push('S');
            out.push_str(item.category_code.as_deref().unwrap_or(&tx.category));
            out.push('\n');
            out.push('E');
            out.push_str(&qif_text(&item.name));
            out.push('\n');
            out.push('$');
            out.push_str(&signed_line_amount(
                tx.direction,
                item.amount_minor * item.quantity,
                &tx.currency,
            ));
            out.push('\n');
        }
        out.push_str("^\n");
    }
    out
}

pub fn export_ofx(rows: &[BookkeepingExportRow]) -> String {
    let mut out = String::from(
        "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:UTF-8\nCHARSET:UTF-8\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1\n<STATUS><CODE>0<SEVERITY>INFO</STATUS>\n<STMTRS>\n<BANKTRANLIST>\n",
    );
    for row in rows {
        let tx = &row.transaction;
        out.push_str("<STMTTRN>\n");
        out.push_str("<TRNTYPE>");
        out.push_str(if tx.direction == BookkeepingDirection::Income {
            "CREDIT"
        } else {
            "DEBIT"
        });
        out.push('\n');
        out.push_str("<DTPOSTED>");
        out.push_str(&ofx_datetime(tx));
        out.push('\n');
        out.push_str("<TRNAMT>");
        out.push_str(&signed_amount(tx));
        out.push('\n');
        out.push_str("<FITID>");
        out.push_str(&fitid(tx));
        out.push('\n');
        out.push_str("<NAME>");
        out.push_str(&ofx_text(&tx.merchant));
        out.push('\n');
        let memo = tx
            .note
            .as_deref()
            .or(tx.description.as_deref())
            .unwrap_or(&tx.category);
        out.push_str("<MEMO>");
        out.push_str(&ofx_text(memo));
        out.push('\n');
        out.push_str("</STMTTRN>\n");
    }
    out.push_str("</BANKTRANLIST>\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n");
    out
}

pub fn format_minor(amount_minor: i32, currency: &str) -> String {
    let exponent = currency_exponent(currency);
    if exponent == 0 {
        return amount_minor.to_string();
    }
    let divisor = 10_i32.pow(exponent);
    let absolute = amount_minor.unsigned_abs();
    let divisor = divisor as u32;
    let major = absolute / divisor;
    let minor = absolute % divisor;
    let sign = if amount_minor < 0 { "-" } else { "" };
    format!("{sign}{major}.{minor:0width$}", width = exponent as usize)
}

pub fn fitid(tx: &BookkeepingTransaction) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_label(tx.source).as_bytes());
    hasher.update(b"|");
    hasher.update(tx.source_ref.as_deref().unwrap_or("").as_bytes());
    hasher.update(b"|");
    hasher.update(tx.id.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn signed_amount(tx: &BookkeepingTransaction) -> String {
    signed_line_amount(tx.direction, tx.amount_minor, &tx.currency)
}

fn signed_line_amount(
    direction: BookkeepingDirection,
    amount_minor: i32,
    currency: &str,
) -> String {
    let signed_minor = match direction {
        BookkeepingDirection::Expense => amount_minor.saturating_neg(),
        BookkeepingDirection::Income => amount_minor,
    };
    format_minor(signed_minor, currency)
}

fn currency_exponent(currency: &str) -> u32 {
    match currency.to_ascii_uppercase().as_str() {
        "KRW" | "JPY" => 0,
        _ => 2,
    }
}

fn direction_label(direction: BookkeepingDirection) -> &'static str {
    match direction {
        BookkeepingDirection::Expense => "지출",
        BookkeepingDirection::Income => "수입",
    }
}

fn source_label(source: BookkeepingSource) -> &'static str {
    match source {
        BookkeepingSource::Manual => "manual",
        BookkeepingSource::Ocr => "ocr",
        BookkeepingSource::Gmail => "gmail",
        BookkeepingSource::Csv => "csv",
    }
}

fn qif_category(tx: &BookkeepingTransaction) -> String {
    match tx.subcategory.as_deref() {
        Some(subcategory) if !subcategory.is_empty() => format!("{}:{}", tx.category, subcategory),
        _ => tx.category.clone(),
    }
}

fn qif_date(date: &str) -> String {
    if date.len() == 10 {
        format!("{}/{}/{}", &date[5..7], &date[8..10], &date[0..4])
    } else {
        date.to_string()
    }
}

fn ofx_datetime(tx: &BookkeepingTransaction) -> String {
    let time = tx
        .spent_at_time
        .as_deref()
        .unwrap_or("000000")
        .replace(':', "");
    format!("{}{}", tx.spent_at.replace('-', ""), time)
}

fn qif_text(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

fn ofx_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace(['\r', '\n'], " ")
}

fn push_csv_record(out: &mut String, fields: &[&str]) {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_csv_field(out, field);
    }
    out.push('\n');
}

fn push_csv_field(out: &mut String, field: &str) {
    if field.contains([',', '"', '\n', '\r']) {
        out.push('"');
        out.push_str(&field.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(field);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        BookkeepingExpenseKind, BookkeepingPaymentMethodKind, BookkeepingReviewStatus,
    };

    fn tx(
        id: &str,
        direction: BookkeepingDirection,
        amount_minor: i32,
        currency: &str,
    ) -> BookkeepingTransaction {
        BookkeepingTransaction {
            id: id.to_string(),
            project_id: Some("project-a".to_string()),
            source: BookkeepingSource::Gmail,
            source_ref: Some("msg-1".to_string()),
            merchant: "Cafe, Momo".to_string(),
            description: Some("morning coffee".to_string()),
            amount_minor,
            currency: currency.to_string(),
            spent_at: "2026-06-18".to_string(),
            category: "식비".to_string(),
            review_status: BookkeepingReviewStatus::Approved,
            note: Some("latte".to_string()),
            payment_method_kind: BookkeepingPaymentMethodKind::Card,
            payment_method_label: Some("Visa".to_string()),
            payment_method_last4: Some("1234".to_string()),
            expense_kind: BookkeepingExpenseKind::Variable,
            recurring_expense_id: None,
            recurring_occurrence_id: None,
            direction,
            account: Some("Checking".to_string()),
            subcategory: Some("카페".to_string()),
            category_code: Some("food".to_string()),
            subcategory_code: Some("food_cafe".to_string()),
            raw_category: None,
            spent_at_time: Some("09:30:00".to_string()),
            confidence: None,
            field_confidence_json: "{}".to_string(),
            review_reasons_json: "[]".to_string(),
            duplicate_of_transaction_id: None,
            order_no: None,
            payment_no: None,
            created_at: "2026-06-18T00:00:00Z".to_string(),
            updated_at: "2026-06-18T00:00:00Z".to_string(),
            reviewed_at: Some("2026-06-18T00:00:00Z".to_string()),
            deleted_at: None,
        }
    }

    fn line_item() -> BookkeepingLineItem {
        BookkeepingLineItem {
            id: "li-1".to_string(),
            transaction_id: "tx-1".to_string(),
            name: "Latte".to_string(),
            amount_minor: 2500,
            quantity: 2,
            category_code: Some("food_cafe".to_string()),
            sort_order: 0,
            created_at: "2026-06-18T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn csv_uses_bom_korean_headers_and_escaped_fields() {
        let rows = vec![BookkeepingExportRow {
            transaction: tx("tx-1", BookkeepingDirection::Expense, 4500, "KRW"),
            line_items: vec![],
        }];

        let out = export_csv(&rows);

        assert!(out.starts_with("\u{feff}날짜,시각,자산,분류"));
        assert!(out.contains("\"Cafe, Momo\""));
        assert!(out.contains(",지출,4500,KRW,"));
    }

    #[test]
    fn qif_emits_split_rows_and_income_sign() {
        let rows = vec![BookkeepingExportRow {
            transaction: tx("tx-1", BookkeepingDirection::Income, 12_500, "KRW"),
            line_items: vec![line_item()],
        }];

        let out = export_qif(&rows);

        assert!(out.contains("T12500\n"));
        assert!(out.contains("Sfood_cafe\nELatte\n$5000\n"));
        assert!(out.contains("L식비:카페\n"));
    }

    #[test]
    fn qif_emits_usd_decimal_major_units_for_transaction_and_splits() {
        let rows = vec![BookkeepingExportRow {
            transaction: tx("tx-1", BookkeepingDirection::Income, 12_500, "USD"),
            line_items: vec![line_item()],
        }];

        let out = export_qif(&rows);

        assert!(out.contains("T125.00\n"));
        assert!(out.contains("Sfood_cafe\nELatte\n$50.00\n"));
    }

    #[test]
    fn ofx_emits_stable_fitid_and_expense_sign() {
        let row = BookkeepingExportRow {
            transaction: tx("tx-1", BookkeepingDirection::Expense, 4500, "KRW"),
            line_items: vec![],
        };
        let first = fitid(&row.transaction);
        let second = fitid(&row.transaction);
        let out = export_ofx(&[row]);

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(out.contains("<TRNTYPE>DEBIT\n"));
        assert!(out.contains("<TRNAMT>-4500\n"));
        assert!(out.contains(&format!("<FITID>{first}\n")));
    }

    #[test]
    fn ofx_emits_usd_decimal_major_units_and_direction_signs() {
        let income = BookkeepingExportRow {
            transaction: tx("tx-usd-income", BookkeepingDirection::Income, 12_500, "USD"),
            line_items: vec![],
        };
        let expense = BookkeepingExportRow {
            transaction: tx("tx-usd-expense", BookkeepingDirection::Expense, 4500, "USD"),
            line_items: vec![],
        };

        let out = export_ofx(&[income, expense]);

        assert!(out.contains("<TRNTYPE>CREDIT\n<DTPOSTED>20260618093000\n<TRNAMT>125.00\n"));
        assert!(out.contains("<TRNTYPE>DEBIT\n<DTPOSTED>20260618093000\n<TRNAMT>-45.00\n"));
    }

    #[test]
    fn format_minor_respects_currency_exponents() {
        assert_eq!(format_minor(4500, "KRW"), "4500");
        assert_eq!(format_minor(4500, "USD"), "45.00");
        assert_eq!(format_minor(-125, "USD"), "-1.25");
        assert_eq!(format_minor(-5, "USD"), "-0.05");
    }
}
