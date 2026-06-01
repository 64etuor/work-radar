use super::AgentReasoningEffort;
use serde::{Deserialize, Serialize};
use specta::Type;
// ── 스킬 공유 레지스트리 (Phase 20 #21) ─────────────────────────────────────────────
//
// 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부 Claude/Codex 스킬(~/.claude/skills)을 한
// 레지스트리에서 본다. INVARIANT #1/#2: 프롬프트 편집은 codex 제안 *내용*만 바꾼다 — 잡은 여전히
// 제안 레일 + Acceptance 게이트를 거치고 accept는 suggested_*/proposal만 쓴다(스킬 자동 실행 없음).

/// 외부 스킬을 발견한 제공 도구(스캔 루트의 귀속). `project.rs`의 `Provider{Github,Local}`(레포
/// 제공자)와는 **별개 타입** — 이름 충돌 금지(C2). specta가 TS union `"claude"|"codex"|...`로 방출해
/// 프런트의 경로추론(`providerOf`)을 대체한다. `.agents/skills`는 P0에서 Codex로 태깅한다.
// Hash: managed↔discovered 억제(list_skills)에서 `(name, provider)` HashSet 키로 쓴다(G1-PR3). 순수
// 추가 derive — serde/specta(Type) 방출엔 영향 없다(bindings drift 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SkillProvider {
    Claude,
    Codex,
    Openclaw,
    Hermes,
    Other,
}

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
    /// 내부 프롬프트별 Codex 모델 override. None이면 설정 > Agents 기본 모델을 상속한다.
    pub model: Option<String>,
    /// 내부 프롬프트별 thinking 수준 override. None이면 Codex 기본 설정을 상속한다.
    pub reasoning_effort: Option<AgentReasoningEffort>,
    /// true면 모델 override가 없을 때 fast 모델(gpt-5.3-codex-spark)을 사용한다.
    pub fast_mode: bool,
    /// external: SKILL.md 디렉터리/파일 경로. in_app: None.
    pub source_path: Option<String>,
    /// external: 스킬을 발견한 제공 도구(스캔 루트 귀속). in_app: None. DB `skills` 테이블엔 컬럼이
    /// 없어(외부는 디스크 SSOT·비영속) FromRow에서 `#[sqlx(skip)]`로 항상 Default(None)을 쓰고, 외부
    /// 행은 `list_skills`가 합성 시 직접 세팅한다(Decode/Type 불필요).
    #[sqlx(skip)]
    pub provider: Option<SkillProvider>,
    /// 사용자 태그(로컬 SQLite `skill_tags` — 인앱/외부 공통, Phase 3 #12). `skills` 테이블엔 컬럼이
    /// 없어(다대다 매핑은 별표) FromRow에서 `#[sqlx(skip)]`로 항상 Default(빈 vec)이고, `list_skills`가
    /// 합성 시 통합 id(`ext:` 접두 포함)로 일괄 채운다. 사람 태깅 전용(#1 — 자동 분류 없음).
    #[sqlx(skip)]
    pub tags: Vec<String>,
    /// in_app_prompt 중 시드된 binding을 가진 행의 **코드 상수 프롬프트**(폴백 출처 — Phase 4 #18 diff/복원).
    /// `skills` 테이블엔 컬럼이 없어(코드 상수에서 도출) FromRow에서 `#[sqlx(skip)]`로 항상 Default(None)이고,
    /// `list_skills`가 in_app 행에 한해 binding으로 합성한다. 외부/미시드 binding은 None(diff 비대상).
    #[sqlx(skip)]
    pub fallback_prompt: Option<String>,
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
    /// 이 스킬을 발견한 스캔 루트의 제공 도구(`list_skills`가 `Skill.provider`로 전달).
    pub provider: SkillProvider,
}

/// 환경(provider) 감지 결과 한 건 — 사이드바가 "설치된 환경만" 렌더하는 데 쓴다(P1). 동일 provider의
/// 여러 ROOTS(예: Codex = `.codex` + `.agents`)는 하나로 집계한다: `present`=루트 중 하나라도 존재,
/// `skill_count`=합. `root_path`는 표시 전용(주 루트) — **로그엔 절대 싣지 않는다(C7)**. DB 비영속(매
/// 호출 디스크 스캔). 읽기 전용 — 외부 dir에 쓰지 않는다(외부 쓰기는 Phase G).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnvironment {
    /// 환경(스캔 루트 귀속 도구).
    pub provider: SkillProvider,
    /// 이 provider의 루트 중 하나라도 디스크에 존재하면 true(사이드바 렌더 조건).
    pub present: bool,
    /// 이 provider에서 발견한 스킬 수(specta는 i64 미지원 → i32; 스킬 수는 작다).
    pub skill_count: i32,
    /// 주 루트 절대경로(표시 전용 — 로그 금지). 동일 provider 다중 루트면 첫 루트.
    pub root_path: String,
}

/// 사용자가 직접 등록한 임의 스킬 루트(P1.5 #3 — 위치-축 안전망). 우리가 하드코딩하지 않은 디렉터리를
/// 사용자가 명시적으로 추가한다. `app_config`에 JSON 배열로 영속된다(스키마 변경 없음 — Phase 3만 마이그
/// 레이션). provider는 루트별 영속하지 않고 집계 시 `SkillProvider::Other`로 합성한다. 경로는 절대경로만
/// (path-guard가 의미 있으려면 절대 필요) — 아직 존재하지 않는 dir도 허용한다(안전망: 곧 만들 dir).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillRoot {
    /// 스킬 루트 절대 경로(스캔/path-guard 대상). 비절대/공백은 set 시 거부한다.
    pub path: String,
}

/// 프로젝트 워크스페이스 한 건 = enabled Local 레포 1개의 스킬 집계(G3-PR1, #16). DB 비영속(매 호출
/// 디스크 스캔, INVARIANT #7). 읽기 전용 — 외부 dir에 쓰지 않는다. `root_path`는 표시 전용 — **로그
/// 금지(C7)**. `enabled_count`는 두지 않는다: 외부 스킬은 `list_skills`가 항상 enabled로 합성하므로
/// 항상 `skill_count`와 같다(중복).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillWorkspace {
    /// repos.id — 표시/네비 id용(String이라 specta i64 이슈 없음).
    pub repo_id: String,
    /// local_path의 basename(표시 전용). 추출 불가 시 전체 경로.
    pub label: String,
    /// local_path(표시 전용 — 로그 금지).
    pub root_path: String,
    /// 이 레포 스킬 dir들에서 발견한 스킬 수(specta i64 미지원 → i32).
    pub skill_count: i32,
    /// 각 멤버 스킬의 source_path(절대경로) — FE가 Set lookup으로 필터(프런트 경로추론 회피).
    pub member_paths: Vec<String>,
}

/// 프로젝트 vendored 카피의 중앙 라이브러리 대비 드리프트 1건(G3-PR2, #22 부분). 디스크 유도·비영속
/// (#7). 읽기 전용. `member_path`는 표시·매칭 전용 — 로그 금지(C7).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDivergence {
    /// repos.id — 워크스페이스 귀속(String이라 specta i64 이슈 없음).
    pub repo_id: String,
    /// 멤버 스킬의 provider(스캔 루트 귀속).
    pub provider: SkillProvider,
    /// 표시 이름(frontmatter name 우선, dir 폴백) — registry/PR1과 동일 도출.
    pub name: String,
    /// PR1 `SkillWorkspace.member_paths` 와 **동일 문자열**(스킬 SKILL.md 경로) — FE Set-lookup용(C6).
    pub member_path: String,
    /// 비교 결과.
    pub status: DivergenceStatus,
}

/// 2-way 드리프트 상태(베이스라인 없음 — 누가 편집했는지는 표시 안 함). snake_case 방출.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DivergenceStatus {
    InSync,
    Diverged,
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
