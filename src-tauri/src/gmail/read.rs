use base64::Engine as _;

use super::GmailError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailLabelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailReceiptCandidate {
    pub message_id: String,
    pub from: String,
    pub subject: String,
    pub snippet: String,
    pub body_text: String,
    pub received_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailMessageSearch {
    pub label_ids: Vec<String>,
    pub query: Option<String>,
    pub max_results: u32,
}

pub trait GmailReadProvider {
    fn list_labels(
        &self,
        access_token: &str,
    ) -> impl std::future::Future<Output = Result<Vec<GmailLabelInfo>, GmailError>> + Send;

    fn list_message_ids(
        &self,
        access_token: &str,
        search: &GmailMessageSearch,
    ) -> impl std::future::Future<Output = Result<Vec<String>, GmailError>> + Send;

    fn get_receipt_candidate(
        &self,
        access_token: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = Result<GmailReceiptCandidate, GmailError>> + Send;
}

pub(super) fn parse_labels(json: &serde_json::Value) -> Vec<GmailLabelInfo> {
    json.get("labels")
        .and_then(|v| v.as_array())
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| {
                    let id = label.get("id")?.as_str()?.trim();
                    let name = label.get("name")?.as_str()?.trim();
                    if id.is_empty() || name.is_empty() {
                        return None;
                    }
                    Some(GmailLabelInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_message_ids(json: &serde_json::Value) -> Vec<String> {
    json.get("messages")
        .and_then(|v| v.as_array())
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| message.get("id")?.as_str())
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn parse_next_page_token(json: &serde_json::Value) -> Option<String> {
    json.get("nextPageToken")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn parse_receipt_candidate(
    message_id: &str,
    json: &serde_json::Value,
) -> Result<GmailReceiptCandidate, GmailError> {
    let id = json
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(message_id)
        .trim()
        .to_string();
    let snippet = json
        .get("snippet")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let received_at = json
        .get("internalDate")
        .and_then(|v| v.as_str())
        .and_then(parse_internal_date_ms);

    let payload = json.get("payload").ok_or_else(|| {
        GmailError::Terminal("message payload missing (response body hidden)".into())
    })?;
    let from = header_value(payload, "From").unwrap_or_default();
    let subject = header_value(payload, "Subject").unwrap_or_default();
    let body_text = extract_body_text(payload);

    Ok(GmailReceiptCandidate {
        message_id: id,
        from,
        subject,
        snippet,
        body_text,
        received_at,
    })
}

fn parse_internal_date_ms(raw: &str) -> Option<String> {
    let ms = raw.parse::<i64>().ok()?;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn header_value(payload: &serde_json::Value, name: &str) -> Option<String> {
    payload
        .get("headers")?
        .as_array()?
        .iter()
        .find(|h| {
            h.get("name")
                .and_then(|v| v.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })?
        .get("value")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn extract_body_text(payload: &serde_json::Value) -> String {
    let mut plain = Vec::new();
    let mut html = Vec::new();
    collect_body_parts(payload, &mut plain, &mut html);
    let body = if plain.is_empty() { html } else { plain };
    body.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_body_parts(
    payload: &serde_json::Value,
    plain: &mut Vec<String>,
    html: &mut Vec<String>,
) {
    let mime = payload
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if let Some(decoded) = payload
        .get("body")
        .and_then(|body| body.get("data"))
        .and_then(|v| v.as_str())
        .and_then(decode_gmail_body_data)
    {
        if mime.starts_with("text/plain") {
            plain.push(decoded);
        } else if mime.starts_with("text/html") {
            html.push(strip_html(&decoded));
        }
    }

    if let Some(parts) = payload.get("parts").and_then(|v| v.as_array()) {
        for part in parts {
            collect_body_parts(part, plain, html);
        }
    }
}

fn decode_gmail_body_data(data: &str) -> Option<String> {
    let decoded = base64::engine::general_purpose::URL_SAFE
        .decode(data)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(data))
        .ok()?;
    Some(String::from_utf8_lossy(&decoded).into_owned())
}

fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    html_escape::decode_html_entities(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_message_ids_returns_empty_when_no_messages() {
        assert!(parse_message_ids(&serde_json::json!({})).is_empty());
        assert_eq!(
            parse_message_ids(&serde_json::json!({ "messages": [{ "id": "m1" }] })),
            vec!["m1".to_string()]
        );
    }

    #[test]
    fn parse_receipt_candidate_extracts_headers_and_body() {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode("상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원");
        let json = serde_json::json!({
            "id": "m1",
            "snippet": "쿠팡 23,400원",
            "internalDate": "1781582400000",
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [
                    { "name": "From", "value": "receipts@coupang.test" },
                    { "name": "Subject", "value": "[쿠팡] 결제 영수증" }
                ],
                "parts": [
                    {
                        "mimeType": "text/plain",
                        "body": { "data": body }
                    }
                ]
            }
        });

        let parsed = parse_receipt_candidate("fallback", &json).expect("candidate");

        assert_eq!(parsed.message_id, "m1");
        assert_eq!(parsed.from, "receipts@coupang.test");
        assert_eq!(parsed.subject, "[쿠팡] 결제 영수증");
        assert!(parsed.body_text.contains("결제금액 23,400원"));
        assert!(parsed
            .received_at
            .as_deref()
            .is_some_and(|v| v.starts_with("2026-")));
    }

    #[test]
    fn parse_receipt_candidate_falls_back_to_html_body() {
        let html = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            "<html><body><b>상호: 네이버페이</b><br>결제일: 2026.06.16<br>결제금액 9,900원</body></html>",
        );
        let json = serde_json::json!({
            "id": "m2",
            "payload": {
                "mimeType": "text/html",
                "headers": [],
                "body": { "data": html }
            }
        });

        let parsed = parse_receipt_candidate("m2", &json).expect("candidate");

        assert!(parsed.body_text.contains("상호: 네이버페이"));
        assert!(parsed.body_text.contains("결제금액 9,900원"));
    }
}
