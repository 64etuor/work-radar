use serde::{Deserialize, Serialize};
use specta::Type;

use crate::models::ProjectKind;

// ── 연결 점검(Connection Audit) ────────────────────────────────────────────────
//
// 전 프로젝트의 외부 연결을 한 번에 검증한 읽기 전용 집계. INVARIANT: 토큰 본문은 이 타입들 어디에도
// 담기지 않는다(detail은 login/bot/title/에러 메시지만). 외부 호출은 Rust(commands/audit.rs)에서.

/// 단일 연결의 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnState {
    /// 미설정(토큰/바인딩 없음).
    NotConfigured,
    /// 검증 성공.
    Ok,
    /// 검증 실패(토큰 무효/권한/네트워크 등).
    Failed,
}

/// 한 서비스 연결의 점검 결과. `detail`은 사람이 읽을 식별자/에러(토큰 본문 없음).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnCheck {
    pub state: ConnState,
    pub detail: String,
}

impl ConnCheck {
    pub(crate) fn not_configured() -> Self {
        Self {
            state: ConnState::NotConfigured,
            detail: String::new(),
        }
    }
    pub(crate) fn ok(detail: impl Into<String>) -> Self {
        Self {
            state: ConnState::Ok,
            detail: detail.into(),
        }
    }
    pub(crate) fn failed(detail: impl Into<String>) -> Self {
        Self {
            state: ConnState::Failed,
            detail: detail.into(),
        }
    }
}

/// 프로젝트 한 개의 서비스별 연결 상태.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConnectionStatus {
    pub project_id: String,
    pub name: String,
    pub kind: ProjectKind,
    pub github: ConnCheck,
    pub notion: ConnCheck,
    pub notion_backlog_db: ConnCheck,
    pub notion_agenda_db: ConnCheck,
    pub google_calendar: ConnCheck,
    pub gmail: ConnCheck,
}

/// 경고 그룹에 등장하는 프로젝트 참조(개인/업무 구분 포함).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditProjectRef {
    pub id: String,
    pub name: String,
    pub kind: ProjectKind,
}

/// 같은 식별자(레포/DB)가 여러 프로젝트에 중복 설정된 그룹.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// "owner/repo" · local 경로 · Notion DB id.
    pub identity: String,
    pub projects: Vec<AuditProjectRef>,
}

/// 같은 외부 계정(GitHub login / Notion bot)이 여러 프로젝트에 쓰인 그룹.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountDuplicate {
    /// "github" | "notion".
    pub service: String,
    /// login(github) / bot 이름(notion).
    pub identity: String,
    pub projects: Vec<AuditProjectRef>,
    /// 그룹이 개인·업무 프로젝트를 **모두** 포함 → 토큰 분리 권장 위반 가능(강조 경고).
    pub cross_kind: bool,
}

/// 중복 경고 묶음.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateWarnings {
    pub repos: Vec<DuplicateGroup>,
    pub notion_dbs: Vec<DuplicateGroup>,
    pub accounts: Vec<AccountDuplicate>,
}

/// 환경 경고(예: CLI 다중 설치로 우선순위 모호).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvWarning {
    pub code: String,
    pub message: String,
}

/// 연결 점검 결과(읽기 전용 집계).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAudit {
    pub projects: Vec<ProjectConnectionStatus>,
    pub duplicates: DuplicateWarnings,
    pub environment: Vec<EnvWarning>,
}
