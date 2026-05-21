//! OS keychain 래퍼. INVARIANT: 모든 토큰/비밀은 여기로만 저장된다.
//! SQLite 평문 저장 금지, 렌더러 노출 금지. project별로 키가 분리된다.
//!
//! Phase 0에서는 모듈/계약만 세운다(아직 호출부 없음). Phase 2에서 Add Project
//! 토큰 저장 경로가 이 API를 사용한다.
#![allow(dead_code)]

use keyring::Entry;

const SERVICE: &str = "co.kr.mirrorless.workradar";

/// project별로 분리된 keychain 엔트리. (개인 GitHub ≠ 업무 org, Notion 워크스페이스 별개)
fn entry(credential_ref: &str) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, credential_ref)
}

/// 토큰 저장 (덮어쓰기).
pub fn set_token(credential_ref: &str, token: &str) -> Result<(), keyring::Error> {
    entry(credential_ref)?.set_password(token)
}

/// 토큰 조회. 없으면 `None` (에러 아님).
pub fn get_token(credential_ref: &str) -> Result<Option<String>, keyring::Error> {
    match entry(credential_ref)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 토큰 삭제. 이미 없으면 성공으로 간주.
pub fn delete_token(credential_ref: &str) -> Result<(), keyring::Error> {
    match entry(credential_ref)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}
