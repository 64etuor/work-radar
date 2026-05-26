use serde::{Deserialize, Serialize};
use specta::Type;
// ── 토큰 / 외부 ping (토큰 본문은 절대 이 타입들에 담기지 않는다) ────────────────

/// project별 분리되는 토큰 종류. keychain account 접미사로 쓰인다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Notion,
    Github,
    /// Google Calendar 자격증명 blob ({clientId, clientSecret, refreshToken}). Phase 10a.
    GoogleCalendar,
    /// Hermes 메신저 브리지 봇 토큰(Telegram Bot API류). 앱 레벨 단일 브리지(외부 Hermes 하나). Phase 20.
    HermesBridge,
}

impl TokenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenKind::Notion => "notion",
            TokenKind::Github => "github",
            TokenKind::GoogleCalendar => "google_calendar",
            TokenKind::HermesBridge => "hermes_bridge",
        }
    }
}

/// 토큰 존재 여부만 노출 (본문 미노출 — INVARIANT: 토큰 렌더러 노출 금지).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub has_notion: bool,
    pub has_github: bool,
}

/// 외부 API ping 결과 (read-only). 토큰 본문은 포함하지 않는다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub ok: bool,
    /// 성공 시 식별 정보(예: GitHub login, Notion bot 이름), 실패 시 에러 메시지.
    pub detail: String,
}

/// CLI 토큰 import 도구(gh/ntn) 가용성 (graceful degrade 판정용, Phase 14).
/// 토큰 본문은 절대 담기지 않는다(INVARIANT) — 설치/로그인 여부와 import 가능성만.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliToolStatus {
    /// CLI 바이너리가 PATH(또는 알려진 경로)에서 발견됨.
    pub installed: bool,
    /// 로그인/토큰 import 가능 (gh=`gh auth status`, ntn=auth 파일 존재). false면 로그인 필요.
    pub logged_in: bool,
    /// 사람이 읽을 상태 상세 (토큰 본문 미포함).
    pub detail: String,
}
