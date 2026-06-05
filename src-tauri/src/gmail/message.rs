//! RFC822/MIME 메시지 빌더 (Gmail send, US-002) — **보안 핵심 슬라이스**.
//!
//! `build_raw_message(to, subject, body)`가 base64url 인코딩된 RFC822 `raw` 문자열을 만든다.
//! Gmail `users.messages.send`의 `raw` 필드에 그대로 들어간다.
//!
//! 위협 모델(헤더 인젝션):
//!  AI-origin send 제안의 `to`/`subject`에 `\r\n`이 끼면, 그 줄바꿈이 헤더 구분자로 해석되어
//!  사람 승인 미리보기를 통과한 뒤 `Bcc:` 같은 헤더를 **밀반입**할 수 있다(INVARIANT #2 우회).
//!  방어:
//!   1) **검증 우선 · 거부 전용(sanitize 아님).** `to`/`subject`는 헤더 필드라 인코딩/조립 전에
//!      C0 제어문자(`< 0x20`, `\r`/`\n`/NUL 포함)와 DEL(`0x7F`)이 하나라도 있으면 **하드 거부**
//!      (`GmailError::Terminal`). strip/escape 하지 않는다 — 거부한다. `\r`/`\n` 거부가
//!      folded-continuation(`\r\n ` / `\r\n\t`)까지 자연히 막는다.
//!   2) **에러 메시지에 입력 미포함.** 검증 실패 메시지는 **정적 사유 문자열**만 — `to`/`subject`/
//!      `body` 내용을 절대 interpolate 하지 않는다(로그/에러로의 PII·인젝션 페이로드 유출 차단).
//!   3) body는 헤더가 아니라 본문이라 임의 UTF-8(줄바꿈 포함) 허용 — 제어문자 검증 대상 아님.
//!      대신 `Content-Transfer-Encoding: base64`로 인코딩해 임의 바이트가 그대로 살아남고
//!      8bit/줄길이 이슈를 피한다(항상 정확한 단순 선택).
//!   4) 비-ASCII subject는 제어문자 검증 통과 **후**에만 RFC 2047 encoded-word(`=?UTF-8?B?..?=`).
//!
//! 순수 함수 — 네트워크/IO 없음. `From:`은 넣지 않는다(Gmail이 인증된 발신자로 채움).
//! `Cc:`/`Bcc:`는 받지도 내보내지도 않는다(스코프 밖).

use base64::Engine;

use super::GmailError;

/// 헤더 필드(`to`/`subject`)에 허용되지 않는 바이트(제어문자)가 있으면 **거부**한다.
/// 거부 대상: 모든 C0 제어문자(`0x00..=0x1F` — `\r`=0x0D, `\n`=0x0A, NUL=0x00 포함)와 DEL(`0x7F`).
/// 이게 인젝션 방어의 핵심: `\r`/`\n` 거부가 `Bcc:` 밀반입(folded-continuation 포함)을 원천 차단한다.
///
/// 거부 시 에러 메시지는 **정적 사유**만 — 위반 값(인젝션 페이로드/PII)을 절대 interpolate 하지 않는다.
/// sanitize/strip 하지 않고 거부하는 이유: strip은 페이로드를 조용히 변형해 미리보기와 실제 송신을
/// 어긋나게 만들 수 있다. 거부가 미리보기-송신 동치성을 보장한다.
fn validate_header_field(value: &str) -> Result<(), GmailError> {
    // bytes() 검사: UTF-8 멀티바이트의 continuation 바이트(>= 0x80)는 C0/DEL이 아니므로 통과,
    // ASCII 제어문자만 정확히 걸린다.
    if value.bytes().any(|b| b < 0x20 || b == 0x7F) {
        // 정적 사유만 — value를 메시지에 넣지 않는다(no-leak 요구사항).
        return Err(GmailError::Terminal("헤더 필드에 제어문자 불가".into()));
    }
    Ok(())
}

/// subject 헤더 값을 만든다. 순수 ASCII면 그대로, 비-ASCII가 섞이면 RFC 2047 encoded-word
/// (`=?UTF-8?B?{base64(subject)}?=`). **제어문자 검증은 호출자가 먼저 통과시킨 뒤** 호출한다.
fn encode_subject(subject: &str) -> String {
    if subject.is_ascii() {
        subject.to_string()
    } else {
        // RFC 2047 'B' encoding: 표준(padded) base64. 비-ASCII display 부분만 인코딩.
        let b64 = base64::engine::general_purpose::STANDARD.encode(subject.as_bytes());
        format!("=?UTF-8?B?{b64}?=")
    }
}

/// base64 본문을 76열로 줄바꿈(RFC 2045 권장 최대 줄 길이). 표준 base64 디코더는 줄바꿈을 무시한다.
fn wrap_base64(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 76 + 1);
    for (i, chunk) in bytes.chunks(76).enumerate() {
        if i > 0 {
            out.push_str("\r\n");
        }
        // chunk는 base64 출력(ASCII)이라 from_utf8 무손실.
        out.push_str(std::str::from_utf8(chunk).expect("base64 출력은 ASCII"));
    }
    out
}

/// `to`/`subject`/`body`로 base64url 인코딩된 RFC822 메시지를 만든다(Gmail `raw` 필드용). 순수.
///
/// 보안 순서(모듈 docs 위협 모델):
///  1. `to`/`subject` 제어문자 **검증(거부 전용)** — 인코딩/조립 전.
///  2. subject 비-ASCII면 RFC 2047 encoded-word, body는 base64 CTE.
///  3. `\r\n` 줄바꿈 RFC822 조립 → base64url 인코딩.
///
/// `From:` 미포함(Gmail이 인증 발신자로 채움), `Cc:`/`Bcc:` 미지원(스코프 밖).
pub fn build_raw_message(to: &str, subject: &str, body: &str) -> Result<String, GmailError> {
    // ── 1) 검증 우선: 헤더 필드 제어문자 거부 (인코딩 전, 거부 전용) ──
    validate_header_field(to)?;
    validate_header_field(subject)?;

    // ── 2) 인코딩: subject(비-ASCII→encoded-word), body(base64 CTE) ──
    let subject_header = encode_subject(subject);
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(body.as_bytes());
    let body_wrapped = wrap_base64(&body_b64);

    // ── 3) RFC822 조립 (\r\n 줄끝, 헤더-본문 사이 빈 줄) ──
    // 최소 헤더 집합. From/Cc/Bcc 없음.
    let message = format!(
        "MIME-Version: 1.0\r\n\
         To: {to}\r\n\
         Subject: {subject_header}\r\n\
         Content-Type: text/plain; charset=\"UTF-8\"\r\n\
         Content-Transfer-Encoding: base64\r\n\
         \r\n\
         {body_wrapped}"
    );

    // ── 4) Gmail raw 필드용 base64url 인코딩 ──
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// raw(base64url) → 디코드된 RFC822 문자열로 되돌린다(라운드트립 헬퍼).
    fn decode_raw(raw: &str) -> String {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw)
            .expect("raw는 base64url");
        String::from_utf8(bytes).expect("RFC822는 UTF-8")
    }

    /// RFC822 문자열에서 본문(빈 줄 이후) base64를 디코드해 원문 body를 복원.
    fn decode_body(rfc822: &str) -> String {
        let (_, body_section) = rfc822.split_once("\r\n\r\n").expect("헤더-본문 구분 빈 줄");
        // 줄바꿈 제거 후 표준 base64 디코드.
        let joined: String = body_section.split("\r\n").collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(joined)
            .expect("body는 base64");
        String::from_utf8(bytes).expect("body는 UTF-8")
    }

    /// 1) 유효 ASCII 입력 → 라운드트립: To 하나, Subject 하나, Bcc 없음, body 정확 복원.
    #[test]
    fn build_valid_roundtrips() {
        let raw = build_raw_message("a@b.com", "Hello there", "Body line 1\nBody line 2").unwrap();
        let msg = decode_raw(&raw);

        // 정확히 하나의 To:, 하나의 Subject:.
        assert_eq!(msg.matches("To: ").count(), 1, "정확히 하나의 To: 헤더");
        assert_eq!(
            msg.matches("Subject:").count(),
            1,
            "정확히 하나의 Subject 헤더"
        );
        assert!(msg.contains("To: a@b.com\r\n"));
        assert!(msg.contains("Subject: Hello there\r\n"));
        // Bcc 절대 없음.
        assert!(!msg.contains("Bcc"), "Bcc 없어야 함");
        // 필수 MIME 헤더.
        assert!(msg.contains("MIME-Version: 1.0\r\n"));
        assert!(msg.contains("Content-Type: text/plain; charset=\"UTF-8\"\r\n"));
        assert!(msg.contains("Content-Transfer-Encoding: base64\r\n"));
        // body 정확 복원.
        assert_eq!(decode_body(&msg), "Body line 1\nBody line 2");
    }

    /// 2) CRLF 인젝션(to에 Bcc 밀반입) → Terminal 거부.
    #[test]
    fn rejects_crlf_injection_in_to() {
        let err = build_raw_message("a@b.com\r\nBcc: evil@x", "subj", "body").unwrap_err();
        assert!(matches!(err, GmailError::Terminal(_)));
    }

    /// 3) folded-continuation 변종(`\r\n ` 선행 공백) → 거부.
    #[test]
    fn rejects_folded_continuation_in_to() {
        let err = build_raw_message("a@b.com\r\n Bcc: evil@x", "subj", "body").unwrap_err();
        assert!(matches!(err, GmailError::Terminal(_)));
        // 탭 변종도.
        let err_tab = build_raw_message("a@b.com\r\n\tBcc: evil@x", "subj", "body").unwrap_err();
        assert!(matches!(err_tab, GmailError::Terminal(_)));
    }

    /// 4) bare \n, bare \r, NUL — to와 subject 양쪽 모두 거부.
    #[test]
    fn rejects_control_chars() {
        for bad in ["a@b.com\n", "a@b.com\r", "a@b.com\0"] {
            assert!(
                matches!(
                    build_raw_message(bad, "subj", "body"),
                    Err(GmailError::Terminal(_))
                ),
                "to={bad:?} 거부되어야 함"
            );
        }
        for bad in ["subj\n", "subj\r", "subj\0"] {
            assert!(
                matches!(
                    build_raw_message("a@b.com", bad, "body"),
                    Err(GmailError::Terminal(_))
                ),
                "subject={bad:?} 거부되어야 함"
            );
        }
    }

    /// 5) 에러 메시지에 입력(distinctive recipient) 미포함 — no-leak 보장.
    #[test]
    fn error_does_not_leak_input() {
        let err = build_raw_message("leak@x.test\r\nBcc: x", "subj", "body").unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("leak@x.test"),
            "에러 문자열에 입력 값 노출 금지: {msg}"
        );
    }

    /// 6) 비-ASCII subject/body 라운드트립: 한글+이모지 정확 복원.
    #[test]
    fn non_ascii_subject_and_body_roundtrip() {
        let subject = "회의 일정 🗓️";
        let body = "안녕하세요 👋\n오늘 회의 잘 부탁드립니다.";
        let raw = build_raw_message("a@b.com", subject, body).unwrap();
        let msg = decode_raw(&raw);

        // subject는 RFC 2047 encoded-word로 인코딩(원시 한글이 헤더에 노출 안 됨).
        assert!(
            msg.contains("Subject: =?UTF-8?B?"),
            "비-ASCII subject는 encoded-word: {msg}"
        );
        // encoded-word 디코드 → 원문 subject 복원.
        let recovered_subject = {
            // "Subject: " 다음의 encoded-word 추출.
            let line = msg
                .lines()
                .find(|l| l.starts_with("Subject:"))
                .expect("Subject 줄");
            let ew = line.trim_start_matches("Subject: ");
            let inner = ew.trim_start_matches("=?UTF-8?B?").trim_end_matches("?=");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(inner)
                .expect("encoded-word base64");
            String::from_utf8(bytes).expect("subject UTF-8")
        };
        assert_eq!(recovered_subject, subject);
        // body 정확 복원.
        assert_eq!(decode_body(&msg), body);
    }

    /// 7) 유효 빌드에 Bcc: 가 어디에도 없음(추가 가드).
    #[test]
    fn valid_build_has_no_bcc_anywhere() {
        let raw = build_raw_message("a@b.com", "subj", "body").unwrap();
        let msg = decode_raw(&raw);
        assert!(!msg.contains("Bcc:"), "Bcc: 없어야 함");
        assert!(!msg.contains("Cc:"), "Cc: 없어야 함");
        assert!(!msg.contains("From:"), "From: 없어야 함(Gmail이 채움)");
    }
}
