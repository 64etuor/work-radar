//! External Action Gate: Gmail 발송 커넥터(Phase 5, AI-origin).
//! 제안은 MCP/사용자가 만들고, 실행은 승인 후 여기서만(Rust·토큰 keychain·단일 시도 send).
//! Gmail send는 **사람-폼 경로가 없다** — 전부 외부 에이전트 제안(external_actions 큐)이 게이트를 거쳐
//! 흐른다(spec §4 이중 경로 중 AI-origin만). `calendar/write.rs::execute_calendar_action`을 그대로
//! 미러한다 — 단, raw MIME 빌드는 US-002 `build_raw_message`에 위임하고, send는 비멱등이라
//! `send_message_once`(단일 시도)로 호출해 **중복 발송**을 막는다(send_message의 bounded retry 아님).

/// 승인된 Gmail 액션을 단일-시도 send로 dispatch한다. 토큰은 호출 측(라우터)이 cref로 resolve해
/// `access_token`으로 넘긴다 — 여기선 입력 검증 + raw 빌드(US-002) + provider 호출 + outcome 매핑만
/// (테스트는 mock provider로 네트워크 없이 라우팅 검증). 비-Gmail 액션은 호출 측 라우터가 거르지만
/// 방어적으로 거부한다.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(execute_calendar_action 등과 동일).
#[allow(clippy::result_large_err)]
pub(crate) async fn execute_gmail_action<P: crate::gmail::GmailProvider>(
    provider: &P,
    access_token: &str,
    action: &crate::external_actions::ExternalAction,
) -> Result<crate::external_actions::ExecOutcome, crate::error::AppError> {
    use crate::error::AppError;
    use crate::external_actions::{ExecOutcome, ExternalAction};
    match action {
        ExternalAction::GmailSendEmail { to, subject, body } => {
            // 외부 호출 전 검증(거부 전용). to/subject는 필수, body는 비어도 허용(빈 본문 메일 가능).
            if to.trim().is_empty() {
                return Err(AppError::validation(
                    "gmail.empty_to",
                    "수신자가 비었습니다",
                ));
            }
            if subject.trim().is_empty() {
                return Err(AppError::validation(
                    "gmail.empty_subject",
                    "제목이 비었습니다",
                ));
            }
            // US-002 빌더가 헤더 인젝션(\r\n 등)을 하드 거부하고 base64url raw를 만든다(GmailError→AppError).
            let raw = crate::gmail::build_raw_message(to, subject, body)?;
            // 비멱등 send → 단일 시도(send_message_once). 중복 발송 방지(WRITE_MAX_ATTEMPTS=1).
            let message_id = provider.send_message_once(access_token, &raw).await?;
            // external_ref=Gmail message id(콘텐츠-free). threadId/subject/snippet은 audit `detail`/result에
            // 절대 들어가면 안 된다(INVARIANT #7 — 식별자만, 본문 금지). 그래서 id만 노출한다.
            // bytes = 결합 header+body 길이(to.len()+subject.len()+body.len())뿐 — 내용이 아닌 크기만.
            Ok(ExecOutcome {
                external_ref: Some(message_id),
                bytes: Some((to.len() + subject.len() + body.len()) as i64),
            })
        }
        other => Err(AppError::unexpected(
            "gmail.dispatch.kind",
            format!("Gmail 커넥터가 처리할 수 없는 액션: {}", other.kind_str()),
        )),
    }
}

#[cfg(test)]
mod gmail_dispatch_tests {
    use crate::external_actions::ExternalAction;
    use crate::gmail::execute_gmail_action;
    use crate::gmail::{GmailCreds, GmailError, GmailProvider, TokenResponse};
    use std::sync::Mutex;

    /// 네트워크 없는 mock Gmail provider — send_message_once 호출 인자를 기록해 dispatch 라우팅/검증을
    /// 확인한다. 반환 message id는 어떤 수신자/제목 슬러그도 담지 않는다(콘텐츠-free 식별자).
    #[derive(Default)]
    struct MockGmailProvider {
        calls: Mutex<Vec<(String, String)>>, // (access_token, raw)
    }
    impl GmailProvider for MockGmailProvider {
        async fn exchange_code(
            &self,
            _creds: &GmailCreds,
            _code: &str,
            _verifier: &str,
            _redirect_uri: &str,
        ) -> Result<TokenResponse, GmailError> {
            unreachable!("dispatch 테스트는 토큰 교환을 호출하지 않음")
        }
        async fn refresh_access(&self, _creds: &GmailCreds) -> Result<TokenResponse, GmailError> {
            unreachable!("dispatch 테스트는 refresh를 호출하지 않음")
        }
        async fn send_message(
            &self,
            _access_token: &str,
            _raw: &str,
        ) -> Result<String, GmailError> {
            // gate dispatch는 비멱등이라 send_message(bounded retry)가 아니라 send_message_once를 써야 한다.
            unreachable!("gate dispatch는 send_message_once를 써야 함(중복 발송 방지)")
        }
        async fn send_message_once(
            &self,
            access_token: &str,
            raw: &str,
        ) -> Result<String, GmailError> {
            self.calls
                .lock()
                .unwrap()
                .push((access_token.into(), raw.into()));
            // message id != 어떤 수신자/제목 슬러그 — external_ref가 콘텐츠-free id인지 검증용.
            Ok("msg-id-1".into())
        }
    }

    /// raw(base64url URL_SAFE_NO_PAD) → 디코드된 RFC822 문자열(헤더 검증용 헬퍼).
    fn decode_raw(raw: &str) -> String {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw)
            .expect("raw는 base64url");
        String::from_utf8(bytes).expect("RFC822는 UTF-8")
    }

    fn sample_action() -> ExternalAction {
        ExternalAction::GmailSendEmail {
            to: "a@b.com".into(),
            subject: "회의 일정".into(),
            body: "본문입니다".into(),
        }
    }

    /// GmailSendEmail → send_message_once로 라우팅되고 US-002 raw가 전달되며, outcome.external_ref가
    /// **콘텐츠-free message id**이고 bytes가 결합 길이다. raw에는 승인된 수신자가 실제로 담긴다(chain-of-custody).
    #[tokio::test]
    async fn dispatch_routes_send_once_with_built_message() {
        let p = MockGmailProvider::default();
        let out = execute_gmail_action(&p, "tok", &sample_action())
            .await
            .unwrap();
        // 감사 계약(식별자만, 본문 금지): message id를 external_ref로 쓴다.
        assert_eq!(out.external_ref.as_deref(), Some("msg-id-1"));
        // bytes = to.len()+subject.len()+body.len() (길이만, 내용 아님).
        let expected_bytes = ("a@b.com".len() + "회의 일정".len() + "본문입니다".len()) as i64;
        assert_eq!(out.bytes, Some(expected_bytes));
        let calls = p.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "정확히 1회 send(단일 시도)");
        let (token, raw) = &calls[0];
        assert_eq!(token, "tok");
        // chain-of-custody: 사람-승인된 수신자가 실제 발송될 raw MIME에 담긴다.
        let msg = decode_raw(raw);
        assert!(
            msg.contains("To: a@b.com\r\n"),
            "raw에 승인된 수신자가 담겨야 함: {msg}"
        );
    }

    /// M1 (non-vacuous audit-PII): 수신자/제목이 external_ref에도, 합성 audit `detail`에도 새지 않는다.
    /// detail 포맷은 store.rs:230-236의 실제 포맷터(`ref={r},bytes={b}`)를 재구성해 검증한다.
    /// 단 수신자는 실제 발송될 raw MIME에는 정당하게 존재한다(이메일 본체) — 감사 표면에만 없다.
    #[tokio::test]
    async fn audit_detail_and_external_ref_omit_recipient() {
        let p = MockGmailProvider::default();
        let recipient = "leak@x.test";
        let subject = "SECRET_SUBJECT_marker";
        let action = ExternalAction::GmailSendEmail {
            to: recipient.into(),
            subject: subject.into(),
            body: "body".into(),
        };
        let outcome = execute_gmail_action(&p, "tok", &action).await.unwrap();

        // external_ref(=message id)에는 수신자/제목이 없다.
        let ext = outcome.external_ref.as_deref().unwrap_or_default();
        assert!(
            !ext.contains(recipient) && !ext.contains(subject),
            "external_ref에 수신자/제목이 새면 안 됨: {ext}"
        );

        // store.rs:230-236 실제 audit-detail 포맷터 재구성.
        let detail = match (&outcome.external_ref, outcome.bytes) {
            (Some(r), Some(b)) => format!("ref={r},bytes={b}"),
            (Some(r), None) => format!("ref={r}"),
            (None, Some(b)) => format!("bytes={b}"),
            (None, None) => String::new(),
        };
        assert!(
            !detail.contains(recipient),
            "audit detail에 수신자가 새면 안 됨: {detail}"
        );
        assert!(
            !detail.contains(subject),
            "audit detail에 제목이 새면 안 됨: {detail}"
        );

        // 대비: 수신자는 실제 발송될 raw MIME에는 존재한다(이메일 본체 — 감사 표면에만 없음).
        let raw = &p.calls.lock().unwrap()[0].1;
        let msg = decode_raw(raw);
        assert!(
            msg.contains(recipient),
            "수신자는 실제 raw MIME에 존재해야 함(chain-of-custody)"
        );
    }

    /// 빈 to/subject는 외부 호출 전에 validation 에러로 거른다(provider 미호출).
    #[tokio::test]
    async fn dispatch_rejects_empty_to_or_subject_before_send() {
        let p = MockGmailProvider::default();
        let empty_to = ExternalAction::GmailSendEmail {
            to: "  ".into(),
            subject: "subj".into(),
            body: "b".into(),
        };
        assert!(execute_gmail_action(&p, "tok", &empty_to).await.is_err());
        let empty_subject = ExternalAction::GmailSendEmail {
            to: "a@b.com".into(),
            subject: "".into(),
            body: "b".into(),
        };
        assert!(execute_gmail_action(&p, "tok", &empty_subject)
            .await
            .is_err());
        assert!(
            p.calls.lock().unwrap().is_empty(),
            "검증 실패 시 send 0(provider 미호출)"
        );
    }

    /// 비-Gmail 액션은 방어적으로 거부한다(라우터가 먼저 거르지만 이중 방어).
    #[tokio::test]
    async fn dispatch_rejects_non_gmail_action() {
        let p = MockGmailProvider::default();
        let action = ExternalAction::Noop { note: "x".into() };
        assert!(execute_gmail_action(&p, "tok", &action).await.is_err());
        assert!(p.calls.lock().unwrap().is_empty());
    }
}
