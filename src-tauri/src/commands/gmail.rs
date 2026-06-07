use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{Mutex, MutexGuard};

use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::commands::tokens::project_credential_ref;
use crate::db::Db;
use crate::error::AppError;
use crate::gmail::{self, GmailCreds};
use crate::keychain;
use crate::models::{GmailStatus, TokenKind};

// ── Gmail OAuth 연결 표면 (External Action Gate 5번째 암, Phase 5 US-006) ─────────────
//
// INVARIANT: client_id/secret/refresh_token은 keychain blob({credential_ref}:gmail = TokenKind::Gmail)에만 —
// 인자로만 들어오고 절대 반환되지 않는다(status도 불리언+상세만, 토큰/이메일 미노출). 외부 호출은
// Rust(reqwest). send(송신)는 **AI-origin(자동화 제안)** 경로라 External Action Gate를 거친다(US-004~005) —
// 이 표면은 *연결만* 담당한다(실 송신 아님). 연결은 calendar OAuth(read 레일)와 토큰 흐름이 닮았지만
// 스코프(gmail.send)·관심사가 달라 모듈별로 분리(선례: github≠notion). 실 OAuth/네트워크는 사용자 관찰
// (헤드리스 제외).

#[derive(Clone)]
struct GmailOauthAttempt {
    id: u64,
    cancel: CancellationToken,
}

fn oauth_attempts() -> &'static Mutex<HashMap<String, GmailOauthAttempt>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, GmailOauthAttempt>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_oauth_attempts() -> MutexGuard<'static, HashMap<String, GmailOauthAttempt>> {
    match oauth_attempts().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn begin_gmail_oauth_attempt(project_id: &str) -> GmailOauthAttempt {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let attempt = GmailOauthAttempt {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        cancel: CancellationToken::new(),
    };
    let previous = lock_oauth_attempts().insert(project_id.to_string(), attempt.clone());
    if let Some(previous) = previous {
        previous.cancel.cancel();
    }
    attempt
}

fn finish_gmail_oauth_attempt(project_id: &str, attempt_id: u64) {
    let mut attempts = lock_oauth_attempts();
    if attempts
        .get(project_id)
        .is_some_and(|attempt| attempt.id == attempt_id)
    {
        attempts.remove(project_id);
    }
}

fn cancel_gmail_oauth_attempt(project_id: &str) -> bool {
    let attempt = lock_oauth_attempts().remove(project_id);
    if let Some(attempt) = attempt {
        attempt.cancel.cancel();
        true
    } else {
        false
    }
}

/// OAuth state(CSRF) 검증. recv != expected면 거부. **calendar(commands/calendar.rs:170-175)와
/// 중복된 정책 — 둘 다 바꿔라(R5 parity tripwire).** 순수 함수라 단위 테스트 가능.
#[allow(clippy::result_large_err)]
fn verify_oauth_state(recv: &str, expected: &str) -> Result<(), AppError> {
    if recv != expected {
        return Err(AppError::terminal(
            "gmail.oauth_state_mismatch",
            "OAuth state 불일치 (CSRF 의심) — 다시 시도하세요",
        ));
    }
    Ok(())
}

/// 저장된 creds blob을 읽는다(없으면 None). 토큰 본문은 호출 내부에서만 쓰인다(반환 안 함).
pub(crate) async fn load_gmail_creds(
    db: &Db,
    project_id: &str,
) -> Result<Option<GmailCreds>, String> {
    let cref = project_credential_ref(db, project_id).await?;
    match keychain::get_token(&cref, TokenKind::Gmail).map_err(|e| e.to_string())? {
        Some(s) => Ok(Some(GmailCreds::from_blob(&s).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// OAuth client(client_id/secret)을 keychain blob에 저장(반환 없음). 같은 client면 refresh_token 보존,
/// client가 바뀌면 refresh_token은 버린다(다른 client엔 무효 — 재연결 필요).
///
/// R4 — Google OAuth client는 `gmail.send` 스코프가 활성화된 client여야 한다 — calendar client(calendar
/// 스코프만)와 별개 client를 등록할 것으로 기대한다(실 연결 스모크에서 사용자가 확인). 같은 GCP
/// 프로젝트에서 gmail.send를 추가 활성화해 재사용하는 것도 가능하나, 스코프 동의가 다르므로 재연결이
/// 필요하다.
#[tauri::command]
#[specta::specta]
pub async fn set_gmail_oauth_client(
    db: State<'_, Db>,
    project_id: String,
    client_id: String,
    client_secret: String,
) -> Result<(), AppError> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(AppError::validation(
            "gmail.empty_client",
            "client_id/secret이 비었습니다",
        ));
    }
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.project_not_found", e))?;
    let refresh_token = keychain::get_token(&cref, TokenKind::Gmail)?
        .and_then(|s| GmailCreds::from_blob(&s).ok())
        .filter(|c| c.client_id == client_id) // 같은 client일 때만 기존 연결 유지.
        .and_then(|c| c.refresh_token);
    let creds = GmailCreds {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        refresh_token,
    };
    Ok(keychain::set_token(
        &cref,
        TokenKind::Gmail,
        &creds.to_blob(),
    )?)
}

/// loopback + PKCE(S256) OAuth 실행 → refresh_token을 keychain blob에 저장. bounded(loopback timeout).
/// client 미입력이면 Err(graceful degrade). 실 네트워크/브라우저라 cargo test 아님(사용자 관찰).
#[tauri::command]
#[specta::specta]
pub async fn start_gmail_oauth(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.project_not_found", e))?;
    let creds = load_gmail_creds(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.creds_load", e))?
        .filter(|c| !c.client_id.is_empty() && !c.client_secret.is_empty())
        .ok_or_else(|| {
            AppError::validation(
                "gmail.client_missing",
                "먼저 OAuth client(client_id/secret)를 입력하세요",
            )
        })?;

    let attempt = begin_gmail_oauth_attempt(&project_id);
    let result = async {
        // PKCE + state + loopback bind(redirect_uri 확정) → 브라우저 열기 → redirect 수신(bounded).
        let verifier = gmail::gen_code_verifier();
        let challenge = gmail::pkce_challenge(&verifier);
        let state = gmail::gen_state();
        let loopback = gmail::Loopback::bind().await?;
        let redirect_uri = loopback.redirect_uri.clone();
        let url = gmail::auth_url(&creds.client_id, &redirect_uri, &challenge, &state);
        tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| {
            AppError::terminal("gmail.browser_open", format!("브라우저 열기 실패: {e}"))
        })?;

        let (code, recv_state) = tokio::select! {
            result = loopback.wait_for_redirect(gmail::LOOPBACK_TIMEOUT) => result?,
            _ = attempt.cancel.cancelled() => {
                return Err(AppError::cancelled(
                    "gmail.oauth_cancelled",
                    "Gmail 연결 대기를 취소했습니다",
                ));
            }
        };
        // R5: state(CSRF) 불일치면 코드 교환 전에 거부. calendar와 중복된 정책 — 둘 다 바꿔라.
        verify_oauth_state(&recv_state, &state)?;

        let provider = gmail::HttpGmailProvider::new()?;
        let updated =
            gmail::connect_core(&provider, creds, &code, &verifier, &redirect_uri).await?;
        Ok(keychain::set_token(
            &cref,
            TokenKind::Gmail,
            &updated.to_blob(),
        )?)
    }
    .await;
    finish_gmail_oauth_attempt(&project_id, attempt.id);
    result
}

/// 진행 중인 loopback OAuth 대기를 취소한다. 브라우저 창을 닫았거나 잘못 열었을 때 UI가 180초
/// timeout을 기다리지 않고 재시도할 수 있게 한다.
#[tauri::command]
#[specta::specta]
pub async fn cancel_gmail_oauth(project_id: String) -> Result<bool, AppError> {
    Ok(cancel_gmail_oauth_attempt(&project_id))
}

/// 연결 상태(client 입력됨 / refresh_token 보유). 토큰/이메일 본문 미노출(graceful degrade 판정용).
/// 로컬 keychain만 읽고 네트워크는 타지 않는다(calendar status 선례).
#[tauri::command]
#[specta::specta]
pub async fn gmail_status(db: State<'_, Db>, project_id: String) -> Result<GmailStatus, AppError> {
    Ok(
        match load_gmail_creds(db.inner(), &project_id)
            .await
            .map_err(|e| AppError::terminal("gmail.creds_load", e))?
        {
            None => GmailStatus {
                has_client: false,
                connected: false,
                detail: "OAuth client 미입력".into(),
            },
            Some(c) => {
                let has_client = !c.client_id.is_empty() && !c.client_secret.is_empty();
                let connected = c.has_refresh();
                let detail = if connected {
                    "연결됨".into()
                } else if has_client {
                    "client 입력됨 — '연결'로 Google 동의 진행".into()
                } else {
                    "OAuth client 미입력".into()
                };
                GmailStatus {
                    has_client,
                    connected,
                    detail,
                }
            }
        },
    )
}

/// 연결 해제: keychain blob 전체(client + refresh_token) 삭제.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_gmail(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.project_not_found", e))?;
    Ok(keychain::delete_token(&cref, TokenKind::Gmail)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R5: state(CSRF) 일치하면 통과, 불일치면 `gmail.oauth_state_mismatch`로 거부.
    #[test]
    fn verify_oauth_state_rejects_mismatch_accepts_match() {
        assert!(verify_oauth_state("a", "a").is_ok());
        let err = verify_oauth_state("a", "b").unwrap_err();
        assert_eq!(err.code, "gmail.oauth_state_mismatch");
    }

    /// 취소 레지스트리: begin → 두 번째가 첫 번째를 취소, cancel은 제거, 잘못된 id finish는 no-op.
    /// (calendar.rs google_oauth_attempts_are_cancelled_and_removed 미러)
    #[test]
    fn gmail_oauth_attempts_are_cancelled_and_removed() {
        static TEST_ID: AtomicU64 = AtomicU64::new(1);
        let project_id = format!(
            "gmail-oauth-test-{}",
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        let first = begin_gmail_oauth_attempt(&project_id);
        assert!(!first.cancel.is_cancelled());

        let second = begin_gmail_oauth_attempt(&project_id);
        assert!(first.cancel.is_cancelled());
        assert!(!second.cancel.is_cancelled());

        assert!(cancel_gmail_oauth_attempt(&project_id));
        assert!(second.cancel.is_cancelled());
        assert!(!cancel_gmail_oauth_attempt(&project_id));

        let third = begin_gmail_oauth_attempt(&project_id);
        finish_gmail_oauth_attempt(&project_id, third.id + 1);
        assert!(cancel_gmail_oauth_attempt(&project_id));
        assert!(third.cancel.is_cancelled());
    }
}
