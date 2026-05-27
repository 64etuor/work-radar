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
    /// 포함할 Google Calendar 선택 목록 (JSON `[{id,summary}]`). Phase 10b. NULL/빈 목록이면 fetch 없음.
    /// INVARIANT #7: 선택 목록만 로컬 SSOT — 이벤트는 ambient(영속 없음), 토큰은 keychain.
    pub google_calendar_ids: Option<String>,
    /// 캘린더 표시 배경색(`#RRGGBB`). NULL이면 project id 기반 기본 팔레트.
    pub calendar_color: Option<String>,
    /// "일정 생성 기본 캘린더" id. NULL=미설정 → 프런트가 드롭 시 popover로 첫 선택을 저장.
    /// `google_calendar_ids` JSON array에 없는 id면 무효 → 프런트가 NULL 취급.
    pub default_write_calendar_id: Option<String>,
    pub credential_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 프로젝트 생성 입력. credential_ref는 백엔드가 생성한다(프런트가 정하지 않음).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub kind: ProjectKind,
    pub notion_backlog_db_id: Option<String>,
    pub notion_agenda_db_id: Option<String>,
}

/// 프로젝트별 캘린더 표시 색상 변경 입력. `color=NULL`은 기본 팔레트로 되돌림.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectCalendarColorInput {
    pub project_id: String,
    pub color: Option<String>,
}

/// 프로젝트별 "일정 생성 기본 캘린더" 변경 입력. `calendarId=NULL`은 미설정으로 되돌림.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectDefaultWriteCalendarInput {
    pub project_id: String,
    pub calendar_id: Option<String>,
}

// ── 레포(Repo) ────────────────────────────────────────────────────────────────

/// 레포 제공자. github = remote_url, local = local_path(Codex worktree 베이스).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Provider {
    Github,
    Local,
}

/// project별 레포. PR Radar(Phase 4)·worktree(Phase 5)의 단위.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub project_id: String,
    pub provider: Provider,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    pub default_branch: String,
    pub enabled: bool,
    pub created_at: String,
}

/// 레포 추가 입력.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepoInput {
    pub project_id: String,
    pub provider: Provider,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    /// 기본 브랜치. 비면 'main'.
    pub default_branch: Option<String>,
}
