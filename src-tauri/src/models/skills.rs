use serde::{Deserialize, Serialize};
use specta::Type;
// ── 스킬 공유 레지스트리 (Phase 20 #21) ─────────────────────────────────────────────
//
// 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부 Claude/Codex 스킬(~/.claude/skills)을 한
// 레지스트리에서 본다. INVARIANT #1/#2: 프롬프트 편집은 codex 제안 *내용*만 바꾼다 — 잡은 여전히
// 제안 레일 + Acceptance 게이트를 거치고 accept는 suggested_*/proposal만 쓴다(스킬 자동 실행 없음).

/// 레지스트리 한 행. kind="in_app_prompt"면 prompt/binding이 의미 있고(편집 가능 잡 템플릿),
/// kind="external"이면 source_path/prompt(=디스크에서 읽은 description)가 의미 있다(읽기 전용 브라우즈).
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    /// "in_app_prompt" | "external".
    pub kind: String,
    /// in_app_prompt: 편집 가능 템플릿. external: 디스크 description(스캔 시 채움).
    pub prompt: Option<String>,
    /// in_app_prompt: 잡 키(enrich/batch_enrich/ci_triage/pr_selfcheck). external: None.
    pub binding: Option<String>,
    /// 표시용 레일(suggestion). 결정 레일 침범 없음(메타).
    pub rail: Option<String>,
    /// 비활성이면 잡 lookup이 코드 상수로 폴백한다(기본 동작 보존).
    pub enabled: bool,
    /// external: SKILL.md 디렉터리/파일 경로. in_app: None.
    pub source_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 외부 스킬 스캔 결과 한 건(~/.claude/skills/<dir>/SKILL.md frontmatter). 디스크가 SSOT이므로
/// DB에 영속하지 않고 매 스캔마다 읽는다(읽기 전용 브라우즈 + 선택적 내용 열람).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSkill {
    /// frontmatter name(없으면 디렉터리명).
    pub name: String,
    /// frontmatter description(없으면 빈 문자열).
    pub description: String,
    /// SKILL.md 파일 절대 경로(내용 열람·편집 대상).
    pub path: String,
}

/// 인앱 프롬프트 생성 입력(레지스트리에 새 편집 가능 템플릿 추가). binding은 선택(미바인딩 템플릿도 가능).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillInput {
    pub name: String,
    pub prompt: String,
    /// 잡 키(enrich/batch_enrich/ci_triage/pr_selfcheck) 또는 None(미바인딩).
    pub binding: Option<String>,
}
