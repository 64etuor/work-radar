//! OS keychain 래퍼. INVARIANT: 모든 토큰/비밀은 여기로만 저장된다.
//! SQLite 평문 저장 금지, 렌더러 노출 금지. project별 + 종류별로 키가 분리된다.
//!
//! Phase 2(Add Project)에서 호출부가 연결된다: 토큰은 IPC 인자로만 들어와 즉시
//! 여기 저장되고, 다시 렌더러로 **반환되지 않는다**(ping/status는 토큰 본문 미노출).

use keyring::Entry;

use crate::models::TokenKind;

const SERVICE: &str = "co.kr.mirrorless.workradar";

/// keychain account = `{credential_ref}:{kind}`.
/// credential_ref는 project별 분리 키(개인 GitHub ≠ 업무 org, Notion 워크스페이스 별개),
/// kind는 같은 프로젝트 안에서 Notion/GitHub 토큰을 분리한다.
fn account(credential_ref: &str, kind: TokenKind) -> String {
    format!("{credential_ref}:{}", kind.as_str())
}

fn entry(credential_ref: &str, kind: TokenKind) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, &account(credential_ref, kind))
}

/// 토큰 저장 (덮어쓰기). 토큰 본문은 여기서만 다뤄지고 밖으로 새지 않는다.
pub fn set_token(credential_ref: &str, kind: TokenKind, token: &str) -> Result<(), keyring::Error> {
    entry(credential_ref, kind)?.set_password(token)
}

/// 토큰 조회. 없으면 `None` (에러 아님). 외부 호출(ping) 내부에서만 사용.
pub fn get_token(credential_ref: &str, kind: TokenKind) -> Result<Option<String>, keyring::Error> {
    match entry(credential_ref, kind)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 토큰 존재 여부만 (본문 미노출). status 표시용.
pub fn has_token(credential_ref: &str, kind: TokenKind) -> Result<bool, keyring::Error> {
    Ok(get_token(credential_ref, kind)?.is_some())
}

/// 토큰 삭제. 이미 없으면 성공으로 간주.
pub fn delete_token(credential_ref: &str, kind: TokenKind) -> Result<(), keyring::Error> {
    match entry(credential_ref, kind)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}
