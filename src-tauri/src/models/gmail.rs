use serde::{Deserialize, Serialize};
use specta::Type;

/// 프로젝트별 Gmail 연결 상태(graceful degrade 판정용). 토큰/이메일 본문 미포함 — 불리언 + 상세만.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    /// OAuth client(client_id/secret)이 입력됨(연결 시도 가능).
    pub has_client: bool,
    /// refresh_token 보유(OAuth 연결 완료 — 발송 가능).
    pub connected: bool,
    /// 사람이 읽을 상태 상세(토큰/이메일 미포함).
    pub detail: String,
}
