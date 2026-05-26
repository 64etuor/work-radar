use serde::{Deserialize, Serialize};
use specta::Type;
// ── Phase 20 #15: Hermes 메신저 브리지 (외부 Hermes를 Telegram Bot API류로 제어) ───────
//
// INVARIANT: 봇 토큰은 keychain(TokenKind::HermesBridge)만 — DTO/렌더러/DB 평문에 절대 안 담긴다.
// 비밀 아닌 chat_id·getUpdates offset은 로컬 SQLite(hermes_bridge) SSOT. #5: 수신은 bounded 단발
// getUpdates(무한 long-poll 금지). 외부 호출은 Rust(reqwest)·bounded retry·graceful degrade. specta
// i64/u64 금지(여기 카운트/플래그는 bool/u32) — update_id는 백엔드 내부에서만 쓰고 DTO엔 미노출.

/// Hermes 브리지 연결 상태(graceful degrade 판정용). 봇 토큰 본문은 절대 미포함(INVARIANT).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesBridgeStatus {
    /// 봇 토큰이 keychain에 있고 chat_id가 설정됨(송수신 가능).
    pub configured: bool,
    /// 설정된 chat_id(비밀 아님 — 라우팅 대상 표시용). 미설정이면 None.
    pub chat_id: Option<String>,
    /// 사람이 읽을 상태 상세(토큰 본문 미포함).
    pub detail: String,
}

/// 제어 surface(채팅형 뷰)에 표시할 메시지 한 건. 송신/수신 로그(hermes_messages)에서 도출.
/// 토큰 미포함. direction = "sent"|"received".
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct HermesMessage {
    pub id: String,
    /// "sent"(work-radar→Hermes) | "received"(Hermes→work-radar).
    pub direction: String,
    pub text: String,
    pub created_at: String,
}

/// fetch_hermes_messages 결과(bounded 단발 getUpdates). 이번 호출에서 새로 받은 메시지 수.
/// 메시지 본문은 별도 list_hermes_messages로 조회(제어 surface). specta i64/u64 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesFetchResult {
    /// 이번 bounded 호출에서 새로 수신·기록한 메시지 수.
    pub received: u32,
}

/// detect_hermes_chat_id 결과. getUpdates에서 감지된 실 사용자 chat.
/// 봇 토큰 본문은 절대 미포함(INVARIANT) — chat_id + 라벨만 노출한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedChat {
    /// 감지된 chat.id (숫자 → 문자열).
    pub chat_id: String,
    /// 사람이 읽을 라벨(채팅 이름/username/first_name 폴백).
    pub label: String,
}
