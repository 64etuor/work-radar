//! 도메인 타입. serde(camelCase)로 프런트에 노출되고 specta로 TS 타입이 생성된다.
//! INVARIANT: 토큰 같은 비밀은 절대 이 타입들에 담기지 않는다 (keychain 참조만).

use serde::{Deserialize, Serialize};
use specta::Type;

/// 프로젝트 종류. 개인/업무는 별도 토큰·Notion 워크스페이스로 분리된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ProjectKind {
    Personal,
    Work,
}

/// 최상위 그룹. `credential_ref`는 keychain 키일 뿐, 토큰 평문이 아니다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: ProjectKind,
    pub notion_backlog_db_id: Option<String>,
    pub notion_agenda_db_id: Option<String>,
    pub ticket_key_pattern: Option<String>,
    pub credential_ref: String,
    pub created_at: String,
    pub updated_at: String,
}
