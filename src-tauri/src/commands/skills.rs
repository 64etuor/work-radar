//! 스킬 공유 레지스트리 (Phase 20 #21). 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부
//! Claude/Codex/Openclaw 스킬(`~/.{claude,codex,agents,openclaw}/skills/*/SKILL.md`)을 한
//! 레지스트리에서 보기/편집/추가/토글한다(P0: 멀티루트 frontmatter 스캔, 읽기 전용).
//!
//! INVARIANT #1/#2 (구조적 보호):
//!  - 인앱 프롬프트 편집은 codex가 내는 *제안 내용*만 바꾼다. 잡 트리거는 binding으로 활성 프롬프트를
//!    조회하지만(`resolve_prompt`), 그 잡은 여전히 `gated=true`로 spawn되어 awaiting_approval에서 멈추고
//!    accept 코드(execute_accept_*)는 suggested_*/proposal만 쓴다 — 스킬을 편집해도 자동 분류/자동 적용
//!    경로는 절대 생기지 않는다. 스킬은 결코 자동 실행/적용되지 않는다.
//!  - 레지스트리가 비어 있거나 행이 비활성이면 잡 lookup은 코드 상수로 **폴백**한다(기본 동작 불변).
//!
//! INVARIANT #7: 인앱 프롬프트는 로컬 SQLite SSOT. 외부 스킬은 디스크가 SSOT이고 표는 캐시하지 않는다
//! (매 스캔마다 ROOTS의 각 `*/SKILL.md`에서 frontmatter만 읽는다 — 콘텐츠 해싱 없음).
//!
//! 토큰/비밀은 다루지 않는다(프롬프트 템플릿은 비밀 아님). 외부 스킬 파일을 *실행*하지 않는다 — 읽기/
//! (선택) 사용자 명시 편집만. 스캔 로그는 provider+count만 — 절대 경로/frontmatter 본문 금지(C7).
//!
//! ADR-0006 (풀 매니저 채택): P0는 멀티루트 frontmatter 스캔(claude/codex/openclaw)까지 — **읽기 전용·
//! 외부 dir 무쓰기**(viewer 절반). Phase G부터 중앙 라이브러리 SSOT + 외부 dir 설치/sync를 ADR-0006
//! 레일(사용자 발동·가역·audit / Rust+keychain+bounded)로 도입한다. **비실행 및 #1/#2(스킬 설치/sync ≠
//! 잡 자동실행)는 G에서도 불변.** 정본: docs/adr/0006-skills-registry-full-manager.md.

use tauri::State;

use crate::commands::agents::{BATCH_ENRICH_PROMPT, CI_TRIAGE_PROMPT, PR_SELFCHECK_PROMPT};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{CreateSkillInput, ExternalSkill, Skill, SkillEnvironment, SkillProvider};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 인앱 프롬프트 binding 키(잡 트리거가 lookup에 쓰는 식별자). 하드코딩 프롬프트와 1:1.
pub(crate) const BINDING_BATCH_ENRICH: &str = "batch_enrich";
pub(crate) const BINDING_CI_TRIAGE: &str = "ci_triage";
pub(crate) const BINDING_PR_SELFCHECK: &str = "pr_selfcheck";
pub(crate) const BINDING_WORKTREE_REVIEW: &str = "worktree_review";
pub(crate) const BINDING_WORKTREE_CLEANUP: &str = "worktree_cleanup";
pub(crate) const FAST_CODEX_MODEL: &str = "gpt-5.3-codex-spark";

const WORKTREE_REVIEW_PROMPT: &str = "You are reviewing a worktree in read-only mode. Focus on architectural issues, risky changes, dead code, dependency impact, missing tests, and merge conflict risk. Do not edit files. Return a concise Korean review with findings ordered by severity and concrete file references when available.";
const WORKTREE_CLEANUP_PROMPT: &str = "Review the listed local worktree cleanup candidates. Identify which items are safe to delete and explain the evidence for each recommendation. Use a conservative rule: stale means 2+ days with no activity, merged branches are safer than unmerged stale branches, protected/current/base branches must stay, and destructive cleanup needs human confirmation. Return concise bullets with keep/delete/review labels.";

/// (binding, 표시 이름, 코드 상수 프롬프트) 시드 정의. 시드/폴백 둘 다 이 표에서 도출한다(단일 출처).
pub(crate) fn seed_defs() -> [(&'static str, &'static str, &'static str); 5] {
    [
        (
            BINDING_BATCH_ENRICH,
            "브레인덤프 enrich (배치)",
            BATCH_ENRICH_PROMPT,
        ),
        (BINDING_CI_TRIAGE, "CI 실패 triage", CI_TRIAGE_PROMPT),
        (BINDING_PR_SELFCHECK, "코드 리뷰", PR_SELFCHECK_PROMPT),
        (
            BINDING_WORKTREE_REVIEW,
            "worktree 리뷰",
            WORKTREE_REVIEW_PROMPT,
        ),
        (
            BINDING_WORKTREE_CLEANUP,
            "worktree cleanup 추천",
            WORKTREE_CLEANUP_PROMPT,
        ),
    ]
}

/// binding으로 코드 상수 프롬프트(폴백 출처)를 돌려준다. 미지의 binding이면 None.
fn fallback_prompt(binding: &str) -> Option<&'static str> {
    seed_defs()
        .into_iter()
        .find(|(b, _, _)| *b == binding)
        .map(|(_, _, p)| p)
}

/// 4개 인앱 프롬프트를 레지스트리에 시드한다(첫 실행/마이그레이션 후 멱등). 행이 이미 있으면 prompt를
/// 덮어쓰지 않는다(사용자 편집 보존) — `INSERT OR IGNORE`로 binding당 한 번만 들어간다. 기본 동작
/// 불변: 시드 프롬프트 = 코드 상수와 동일하므로 잡 lookup이 이 행을 써도 결과가 같다.
pub async fn seed_in_app_skills(db: &Db) -> Result<(), sqlx::Error> {
    for (binding, name, prompt) in seed_defs() {
        sqlx::query(
            "INSERT OR IGNORE INTO skills (id, name, kind, prompt, binding, rail, enabled) \
             VALUES (?1, ?2, 'in_app_prompt', ?3, ?4, 'suggestion', 1)",
        )
        .bind(format!("skill_{binding}"))
        .bind(name)
        .bind(prompt)
        .bind(binding)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// 잡 트리거가 쓸 프롬프트를 결정한다(레지스트리 lookup + 폴백). binding의 활성(enabled=1) 인앱 행이
/// 있고 prompt가 비어 있지 않으면 그 편집된 템플릿을, 아니면 코드 상수(fallback)를 돌려준다.
/// **레지스트리 조회 실패/부재 시 항상 코드 상수로 폴백** — 기본 동작은 절대 바뀌지 않는다.
/// 이 함수는 *제안 내용*(프롬프트)만 고른다. 잡의 게이트/accept 경로는 호출자 쪽에서 불변이다(#1/#2).
#[cfg_attr(not(test), allow(dead_code))]
pub async fn resolve_prompt(db: &Db, binding: &str, fallback: &str) -> String {
    resolve_agent_prompt_runtime(db, binding, fallback)
        .await
        .prompt
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AgentPromptRuntime {
    pub prompt: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<crate::models::AgentReasoningEffort>,
    pub fast_mode: bool,
}

type RuntimeRow = (
    Option<String>,
    Option<String>,
    Option<crate::models::AgentReasoningEffort>,
    bool,
);

/// 내부 프롬프트 실행 설정을 잡 트리거 직전에 해석한다.
/// 행이 없거나 비활성이면 프롬프트는 코드 상수로, 실행 설정은 전역 기본값으로 폴백한다.
pub(crate) async fn resolve_agent_prompt_runtime(
    db: &Db,
    binding: &str,
    fallback: &str,
) -> AgentPromptRuntime {
    let row: Option<RuntimeRow> = sqlx::query_as(
        "SELECT prompt, model, reasoning_effort, fast_mode FROM skills \
         WHERE binding = ?1 AND kind = 'in_app_prompt' AND enabled = 1",
    )
    .bind(binding)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    match row {
        Some((prompt, model, reasoning_effort, fast_mode)) => AgentPromptRuntime {
            prompt: prompt
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(|| fallback.to_string()),
            model: model
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty()),
            reasoning_effort,
            fast_mode,
        },
        None => AgentPromptRuntime {
            prompt: fallback.to_string(),
            ..Default::default()
        },
    }
}

/// 레지스트리 목록: 인앱 프롬프트 + (디스크 스캔한) 외부 스킬을 합쳐 돌려준다. 인앱은 DB에서, 외부는
/// ROOTS(claude/codex/agents/openclaw)를 스캔해 ExternalSkill→Skill(kind="external", provider 태깅)으로
/// 합성한다(영속 안 함 — 디스크 SSOT).
#[tauri::command]
#[specta::specta]
pub async fn list_skills(db: State<'_, Db>) -> Result<Vec<Skill>, AppError> {
    list_skills_core(db.inner(), &skill_roots()).await
}

/// `list_skills`의 코어(roots 주입 → hermetic 테스트). 인앱 DB 행 + ROOTS 외부 스캔을 병합한다.
async fn list_skills_core(db: &Db, roots: &[SkillRoot]) -> Result<Vec<Skill>, AppError> {
    // 인앱(편집 가능 잡 템플릿) — DB SSOT. provider 컬럼은 없어 FromRow가 None을 채운다(#[sqlx(skip)]).
    let mut skills: Vec<Skill> = sqlx::query_as::<_, Skill>(
        "SELECT id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at \
         FROM skills WHERE kind = 'in_app_prompt' ORDER BY binding, name",
    )
    .fetch_all(db)
    .await
    .map_err(AppError::from)?;

    // 외부(디스크 스킬) — 멀티루트 스캔해서 합성 행으로 덧붙인다(영속 안 함). 부재/읽기불가 루트는
    // per-root skip(무에러)이라 항상 가능분을 반환한다.
    for ex in scan_external_skills_core(roots) {
        skills.push(Skill {
            id: format!("ext:{}", ex.path),
            name: ex.name,
            kind: "external".into(),
            prompt: Some(ex.description),
            binding: None,
            rail: None,
            enabled: true,
            model: None,
            reasoning_effort: None,
            fast_mode: false,
            source_path: Some(ex.path),
            provider: Some(ex.provider),
            created_at: String::new(),
            updated_at: String::new(),
        });
    }
    Ok(skills)
}

/// 인앱 스킬 수정(prompt/name/enabled/binding). 외부 스킬(id="ext:…")은 DB 행이 아니라 수정 불가 —
/// 외부는 파일 자체를 사용자가 명시 편집한다(write_external_skill). prompt 편집은 codex 제안 내용만
/// 바꾼다(#1/#2 — 잡 게이트/accept 불변). None 인자는 미변경(부분 업데이트).
#[tauri::command]
#[specta::specta]
pub async fn update_skill(
    db: State<'_, Db>,
    id: String,
    prompt: Option<String>,
    name: Option<String>,
    enabled: Option<bool>,
) -> Result<Skill, AppError> {
    if id.starts_with("ext:") {
        return Err(AppError::validation(
            "skills.external_readonly",
            "외부 스킬은 레지스트리에서 수정할 수 없습니다(파일을 직접 편집하세요).",
        ));
    }
    // COALESCE로 부분 업데이트(None은 기존값 유지). enabled는 0/1로 바인딩.
    sqlx::query_as::<_, Skill>(
        "UPDATE skills SET \
            prompt = COALESCE(?2, prompt), \
            name = COALESCE(?3, name), \
            enabled = COALESCE(?4, enabled), \
            updated_at = datetime('now') \
         WHERE id = ?1 AND kind = 'in_app_prompt' \
         RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
    )
    .bind(&id)
    .bind(prompt)
    .bind(name)
    .bind(enabled)
    .fetch_optional(db.inner())
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::not_found("skills.not_found", "인앱 스킬을 찾을 수 없습니다."))
}

/// 인앱 프롬프트 추가(미바인딩 또는 binding 지정). binding은 닫힌 세트(4개 잡 키)에서만 — 미지의
/// binding은 거부(잡 lookup이 못 찾는 죽은 행 방지). binding UNIQUE라 이미 그 잡에 행이 있으면 거부.
#[tauri::command]
#[specta::specta]
pub async fn create_skill(db: State<'_, Db>, input: CreateSkillInput) -> Result<Skill, AppError> {
    let name = input.name.trim();
    let prompt = input.prompt.trim();
    if name.is_empty() {
        return Err(AppError::validation(
            "skills.name_empty",
            "이름이 비었습니다.",
        ));
    }
    if prompt.is_empty() {
        return Err(AppError::validation(
            "skills.prompt_empty",
            "프롬프트가 비었습니다.",
        ));
    }
    if let Some(b) = &input.binding {
        if fallback_prompt(b).is_none() {
            return Err(AppError::validation(
                "skills.unknown_binding",
                format!(
                    "알 수 없는 binding '{b}' — 설정 > Agents의 내부 프롬프트 binding 중 하나여야 합니다."
                ),
            ));
        }
    }
    let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
        .fetch_one(db.inner())
        .await
        .map_err(AppError::from)?;
    sqlx::query_as::<_, Skill>(
        "INSERT INTO skills (id, name, kind, prompt, binding, rail, enabled) \
         VALUES (?1, ?2, 'in_app_prompt', ?3, ?4, 'suggestion', 1) \
         RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
    )
    .bind(&id.0)
    .bind(name)
    .bind(prompt)
    .bind(input.binding.as_deref())
    .fetch_one(db.inner())
    .await
    .map_err(|e| {
        // binding UNIQUE 충돌은 사람이 읽을 메시지로.
        if e.to_string().contains("UNIQUE") {
            AppError::terminal(
                "skills.binding_conflict",
                "이미 그 잡에 바인딩된 인앱 프롬프트가 있습니다(기존 것을 편집하세요).",
            )
        } else {
            AppError::from(e)
        }
    })
}

/// 인앱 스킬 삭제(외부 스킬은 삭제 불가 — 파일은 사용자 소유). 시드된 4개 binding 행은 삭제 시 잡이
/// 폴백(코드 상수)으로 돌아가므로 안전(기본 동작 보존). 외부 id는 거부.
#[tauri::command]
#[specta::specta]
pub async fn delete_skill(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    if id.starts_with("ext:") {
        return Err(AppError::validation(
            "skills.external_readonly",
            "외부 스킬은 레지스트리에서 삭제할 수 없습니다(파일은 사용자 소유).",
        ));
    }
    let res = sqlx::query("DELETE FROM skills WHERE id = ?1 AND kind = 'in_app_prompt'")
        .bind(&id)
        .execute(db.inner())
        .await
        .map_err(AppError::from)?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found(
            "skills.not_found",
            "인앱 스킬을 찾을 수 없습니다.",
        ));
    }
    Ok(())
}

/// 재귀 루트의 깊이 캡(루트 기준). 실측(2026-05-30): hermes 스킬 최심 = depth 3, claude 중첩 = depth 2.
/// 4는 카테고리/그룹 중첩에 충분한 헤드룸이면서, 거대 트리(레포 등)에서 무한 하강을 막는 상한이다
/// (node_modules 등은 `is_ignored_dir`로 별도 차단, 리프 규칙으로 보통 더 일찍 멈춤).
const RECURSIVE_MAX_DEPTH: usize = 4;

/// 스캔·path-guard·detect가 **공유하는 단 하나의 루트 정의**(C6). P0=`(provider, path, recursive)`
/// 3-튜플이었으나 P1.5에서 깊이 메타(`max_depth`)를 더해 구조체로. `recursive`=true면 바운디드 재귀로
/// 중첩 카테고리 스킬까지 발견한다(아래 `scan_root`). ignore 리스트는 전 루트 동일(`is_ignored_dir`)이라
/// per-root 필드 대신 공유 술어로 둔다(YAGNI — 향후 per-root override가 필요하면 구조체라 비파괴 추가).
#[derive(Debug, Clone)]
pub(crate) struct SkillRoot {
    pub provider: SkillProvider,
    pub path: PathBuf,
    /// true면 리프 규칙 기반 바운디드 재귀, false면 직속 자식만(P0 동작).
    pub recursive: bool,
    /// recursive일 때 루트 기준 최대 하강 깊이(리프 규칙으로 보통 더 일찍 멈춤). 비재귀는 1.
    pub max_depth: usize,
}

impl SkillRoot {
    /// 비재귀 루트(직속 자식만 — P0 동작). 현재 테스트 전용.
    #[cfg_attr(not(test), allow(dead_code))]
    fn flat(provider: SkillProvider, path: PathBuf) -> Self {
        Self {
            provider,
            path,
            recursive: false,
            max_depth: 1,
        }
    }

    /// 바운디드 재귀 루트.
    fn recursive(provider: SkillProvider, path: PathBuf, max_depth: usize) -> Self {
        Self {
            provider,
            path,
            recursive: true,
            max_depth,
        }
    }
}

/// 재귀 하강 시 건너뛸 디렉터리 이름: 숨김 dir(`.git`/`.venv`/벤더된 에이전트 dotfile 등) + 표준
/// 빌드/벤더 dir. 특히 레포-로컬 루트(P1.5 #4)에서 거대 트리(node_modules 등) 폭주를 막는다. 루트 자체는
/// 명시 경로라 이 술어의 대상이 아니다(하강 중 하위 dir에만 적용).
fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist" | "vendor")
}

/// 스캔·path-guard·detect가 공유하는 ROOTS(C6 단일 출처). 정적 상수 → P1 env-aware resolution →
/// P1.5에서 재귀 + Hermes 루트로 진화. C6 단일 출처는 유지: 한 함수가 전 소비자에 같은 슬라이스를 준다.
///
/// `.agents/skills`는 도구 간 공유 발견 dir이라 P0부터 **Codex로 태깅**(upstream codex 귀속).
/// ⚑ Copilot 추가 시 `.agents/skills`는 공유되므로 **귀속 재검토 필요**.
fn skill_roots() -> Vec<SkillRoot> {
    resolve_skill_roots(&SkillRootEnv::from_process())
}

/// 루트 resolution 입력(테스트는 직접 주입 → hermetic, 프로세스 env 전역 변이 없음). 프로세스 env를
/// 한 번에 캡처한다.
struct SkillRootEnv {
    home: Option<PathBuf>,
    claude_config_dir: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
}

impl SkillRootEnv {
    fn from_process() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        Self {
            home: var("HOME"),
            claude_config_dir: var("CLAUDE_CONFIG_DIR"),
            codex_home: var("CODEX_HOME"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
        }
    }
}

/// env → 루트 경로 목록 해석(C6 단일 출처). 도구별 우선순위:
/// 1. **명시 override env**(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`)가 set이면 존재 무관 그 위치(`<dir>/skills`)
///    — 사용자가 명시적으로 가리킨 곳이므로 존재를 따지지 않는다(스캔은 graceful).
/// 2. `XDG_CONFIG_HOME/<name>/skills`가 **존재하면** 그 경로 — 미존재 XDG 후보는 폴백한다(Linux에서
///    XDG_CONFIG_HOME 상존이 dotfile을 가로채지 않도록 **존재 게이트**).
/// 3. 표준 dotfile `~/.<dotfile>/skills` 폴백(언제나 안정적 가드 루트).
///
/// HOME 미설정이면 빈 목록(전부 graceful — 스캔 0건, 가드는 모든 경로 거부).
///
/// **P1.5**: 도구 루트는 전부 `recursive=true`(중첩 카테고리 스킬 발견). Hermes 루트(`~/.hermes/skills`)
/// 추가. skm 자체 스토어(`~/.skills-manager/skills`)는 여기서 합성하지 않아 ROOTS에서 자동 제외된다
/// (대량 중복 방지 — 정본 Phase 1.5 #6).
fn resolve_skill_roots(env: &SkillRootEnv) -> Vec<SkillRoot> {
    let Some(home) = env.home.clone() else {
        return Vec::new();
    };
    let resolve = |override_dir: Option<&PathBuf>, xdg_name: &str, dotfile: &str| -> PathBuf {
        if let Some(dir) = override_dir {
            return dir.join("skills");
        }
        if let Some(xdg) = &env.xdg_config_home {
            let cand = xdg.join(xdg_name).join("skills");
            if cand.is_dir() {
                return cand;
            }
        }
        home.join(dotfile).join("skills")
    };
    vec![
        SkillRoot::recursive(
            SkillProvider::Claude,
            resolve(env.claude_config_dir.as_ref(), "claude", ".claude"),
            RECURSIVE_MAX_DEPTH,
        ),
        SkillRoot::recursive(
            SkillProvider::Codex,
            resolve(env.codex_home.as_ref(), "codex", ".codex"),
            RECURSIVE_MAX_DEPTH,
        ),
        // `.agents`는 도구 간 공유 발견 dir(Codex 태깅). 전용 override env 없음.
        SkillRoot::recursive(
            SkillProvider::Codex,
            resolve(None, "agents", ".agents"),
            RECURSIVE_MAX_DEPTH,
        ),
        SkillRoot::recursive(
            SkillProvider::Openclaw,
            resolve(None, "openclaw", ".openclaw"),
            RECURSIVE_MAX_DEPTH,
        ),
        // Hermes(P1.5): 대부분 카테고리 중첩(`<root>/<cat>/<skill>/SKILL.md`, 실측 depth 2~3). 전용
        // override env 없음 → dotfile만.
        SkillRoot::recursive(
            SkillProvider::Hermes,
            home.join(".hermes").join("skills"),
            RECURSIVE_MAX_DEPTH,
        ),
    ]
}

/// 환경(provider)별 감지 집계(C6 동일 ROOTS 소비). 동일 provider의 여러 루트(Codex=`.codex`+`.agents`)는
/// 하나로 집계: `present`=루트 중 하나라도 존재, `skill_count`=합, `root_path`=첫(주) 루트. provider
/// 출현 순서를 보존한다. 읽기 전용 — 외부 dir 무쓰기.
pub(crate) fn detect_skill_environments_core(roots: &[SkillRoot]) -> Vec<SkillEnvironment> {
    let scanned = scan_external_skills_core(roots);
    // provider 첫 출현 순서로 누적(주 루트=첫 루트). present는 루트별 OR 집계.
    let mut envs: Vec<SkillEnvironment> = Vec::new();
    for root in roots {
        let exists = std::fs::metadata(&root.path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        match envs.iter_mut().find(|e| e.provider == root.provider) {
            Some(e) => e.present = e.present || exists,
            None => envs.push(SkillEnvironment {
                provider: root.provider,
                present: exists,
                skill_count: 0,
                root_path: root.path.to_string_lossy().into_owned(),
            }),
        }
    }
    for s in &scanned {
        if let Some(e) = envs.iter_mut().find(|e| e.provider == s.provider) {
            e.skill_count += 1;
        }
    }
    // no-PII(C7): provider+present+count만 — root_path(절대경로)는 로그 금지.
    for e in &envs {
        tracing::debug!(target: "skills.detect", provider = ?e.provider, present = e.present, count = e.skill_count, "detected skill environment");
    }
    envs
}

/// 환경 감지: 설치된(존재하는) 스킬 환경 + provider별 스킬 수를 돌려준다(P1 사이드바 전용 소비자).
/// 동일 ROOTS(`skill_roots`) 소비 — 두 번째 루트 정의 없음(C6). 읽기 전용.
#[tauri::command]
#[specta::specta]
pub async fn detect_skill_environments() -> Result<Vec<SkillEnvironment>, AppError> {
    Ok(detect_skill_environments_core(&skill_roots()))
}

/// SKILL.md의 YAML frontmatter에서 name/description을 얕게 파싱한다(외부 의존 없이 라인 스캔).
/// frontmatter는 `---`로 감싼 첫 블록. 키는 `name:`/`description:`만 본다(따옴표 제거). 없으면 빈 값.
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    // 첫 비공백 라인이 `---`여야 frontmatter.
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let t = line.trim();
        if t == "---" {
            break; // frontmatter 끝.
        }
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(unquote(v.trim()));
        } else if let Some(v) = t.strip_prefix("description:") {
            description = Some(unquote(v.trim()));
        }
    }
    (
        name.filter(|s| !s.is_empty()),
        description.filter(|s| !s.is_empty()),
    )
}

/// 양끝 따옴표(', ") 제거(YAML 스칼라 단순화).
fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// ROOTS의 `SKILL.md`를 스캔해 frontmatter(name/description) + provider + 경로를 모은다(읽기 전용).
/// roots **주입**(테스트는 tempdir roots → hermetic). 콘텐츠 해싱 없음(frontmatter-only). 파일은
/// 실행하지 않는다.
///
/// **P1.5 깊이**: `recursive=true` 루트는 바운디드 재귀로 중첩 카테고리 스킬(`<root>/<cat>/<skill>/`)까지
/// 발견한다 — 리프 규칙(SKILL.md를 가진 dir에서 하강 중단), `max_depth` 캡, `is_ignored_dir` 스킵,
/// 재귀 하강 중 심링크 미추적 + visited 사이클 가드(상세: `scan_root`).
///
/// 부분실패 정책(C6): per-root **skip-and-continue** — 부재/읽기불가 루트(또는 하위 dir)는 스킵하고
/// 나머지를 반환한다(전체 스캔 에러 없음).
pub(crate) fn scan_external_skills_core(roots: &[SkillRoot]) -> Vec<ExternalSkill> {
    let mut out: Vec<ExternalSkill> = Vec::new();
    for root in roots {
        let before = out.len();
        let mut visited: HashSet<PathBuf> = HashSet::new();
        scan_root(root.provider, &root.path, 1, root, &mut visited, &mut out);
        // no-PII(C7): provider+count만 기록 — 절대 경로/frontmatter 본문 금지.
        let root_count = out.len() - before;
        tracing::debug!(target: "skills.scan", provider = ?root.provider, count = root_count, "scanned skill root");
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// `dir`의 직속 자식을 검사한다(`child_depth` = 그 자식들의 루트 기준 깊이). SKILL.md를 가진 자식 =
/// 스킬(**리프 규칙** — 기록 후 그 하위로 하강하지 않아 이중 카운트·무한 하강을 막는다). 그 외 자식은
/// `root.recursive`일 때만, 아래 가드 하에 재귀한다:
///  - **depth cap**: `child_depth >= max_depth`면 더 하강하지 않는다.
///  - **심링크 미추적**: 재귀 하강 중 심링크 dir은 따라가지 않는다(사이클 차단). 단 최상위/중간의 심링크
///    *스킬* dir는 위 리프 검사(`read_to_string`이 심링크를 따라감)에서 이미 수용된다(P0 동작 보존).
///  - **ignore**: `is_ignored_dir`(숨김 + node_modules/target/dist/vendor) — 레포 거대 트리 방어.
///  - **visited 사이클 가드**: 정규화 실경로 방문 셋(심링크 차단의 방어적 보강).
fn scan_root(
    provider: SkillProvider,
    dir: &Path,
    child_depth: usize,
    root: &SkillRoot,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<ExternalSkill>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 부재/읽기불가 — graceful skip.
    };
    for entry in entries.flatten() {
        let child = entry.path();
        // is_dir()는 심링크를 따라가므로 심링크→dir도 통과하고, 깨진/비-dir 심링크는 SKILL.md 읽기에서
        // 자연 스킵된다. 명시적으로 is_symlink()도 수용해 의도를 드러낸다.
        if !(child.is_dir() || child.is_symlink()) {
            continue;
        }
        // 리프 규칙: SKILL.md를 가진 dir은 스킬 — 기록하고 하강하지 않는다.
        let skill_md = child.join("SKILL.md");
        if let Ok(content) = std::fs::read_to_string(&skill_md) {
            let (name, description) = parse_frontmatter(&content);
            let dir_name = child
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("(unknown)")
                .to_string();
            out.push(ExternalSkill {
                name: name.unwrap_or(dir_name),
                description: description.unwrap_or_default(),
                path: skill_md.to_string_lossy().into_owned(),
                provider,
            });
            continue;
        }
        // 스킬 아님 — recursive 루트에서만 바운디드 하강.
        if !root.recursive || child_depth >= root.max_depth {
            continue;
        }
        // 재귀 하강 중 심링크는 따라가지 않는다(사이클 차단; 최상위 심링크 스킬 dir는 위 리프에서 수용).
        if child.is_symlink() {
            continue;
        }
        let name = child.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if is_ignored_dir(name) {
            continue;
        }
        // visited 사이클 가드(실경로 정규화 실패 시 원본 경로로 폴백).
        let canon = std::fs::canonicalize(&child).unwrap_or_else(|_| child.clone());
        if !visited.insert(canon) {
            continue;
        }
        scan_root(provider, &child, child_depth + 1, root, visited, out);
    }
}

/// 외부 스킬 멀티루트 스캔(ROOTS의 `*/SKILL.md` frontmatter → name/description/path/provider).
/// 읽기 전용 브라우즈. 부재 루트는 스킵(graceful degrade) — 항상 가능분을 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn scan_external_skills() -> Result<Vec<ExternalSkill>, AppError> {
    Ok(scan_external_skills_core(&skill_roots()))
}

/// 외부 스킬 파일 내용 읽기(~/.claude/skills 하위 SKILL.md만). 디렉터리 탈출 방지(가드). 토큰 무관.
#[tauri::command]
#[specta::specta]
pub async fn read_external_skill(path: String) -> Result<String, AppError> {
    ensure_within_skills_dir(&path).map_err(|e| AppError::validation("skills.path_guard", e))?;
    std::fs::read_to_string(&path).map_err(|e| {
        AppError::terminal("skills.read_failed", format!("파일을 읽지 못했습니다: {e}"))
    })
}

/// 외부 스킬 파일 내용 쓰기(사용자 명시 액션 — 자기 파일 편집). ~/.claude/skills 하위만 허용(가드).
/// 실행하지 않는다(쓰기만). 외부 스킬을 work-radar가 자동 적용/실행하는 경로는 없다.
#[tauri::command]
#[specta::specta]
pub async fn write_external_skill(path: String, content: String) -> Result<(), AppError> {
    ensure_within_skills_dir(&path).map_err(|e| AppError::validation("skills.path_guard", e))?;
    std::fs::write(&path, content).map_err(|e| {
        AppError::terminal(
            "skills.write_failed",
            format!("파일을 쓰지 못했습니다: {e}"),
        )
    })
}

/// 경로가 ROOTS 중 하나 안에 있고 SKILL.md인지 검증(C1 — 디렉터리 탈출/임의 파일 접근 방지).
/// 스캔과 가드는 **동일 ROOTS**를 소비한다. `#[command]` 경계용 래퍼(실제 $HOME ROOTS).
fn ensure_within_skills_dir(path: &str) -> Result<(), String> {
    ensure_within_skills_dir_roots(path, &skill_roots())
}

/// 일반화된 path-guard(C1): `(.. 컴포넌트 없음) AND (basename==SKILL.md) AND (ROOTS 중 하나로 starts_with)`.
/// roots 주입으로 테스트 hermetic. roots가 비면(HOME 없음) 모든 경로 거부(안전).
fn ensure_within_skills_dir_roots(path: &str, roots: &[SkillRoot]) -> Result<(), String> {
    let p = std::path::Path::new(path);
    // 디렉터리 탈출 방지: `..` 컴포넌트 거부. starts_with는 `..`를 해소하지 않아
    // `<root>/../../tmp/SKILL.md`처럼 root 접두를 공유하면서 탈출하는 경로가 통과하므로 별도 차단.
    if p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("경로에 '..'를 쓸 수 없습니다.".into());
    }
    if p.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return Err("SKILL.md 파일만 읽고 쓸 수 있습니다.".into());
    }
    if !roots.iter().any(|r| p.starts_with(&r.path)) {
        return Err("스킬 루트 밖의 경로는 접근할 수 없습니다.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;
    use tempfile::TempDir;

    /// tempdir 루트에 `<root>/<dir>/SKILL.md`를 frontmatter와 함께 만든다(hermetic 헬퍼).
    fn make_skill(root: &std::path::Path, dir: &str, frontmatter: &str) {
        let d = root.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), frontmatter).unwrap();
    }

    /// 멀티루트 스캔: 루트별 provider 분류 + frontmatter(name/description) 파싱 + 부재 루트 graceful +
    /// 이름 정렬. (`.agents`는 Codex 태깅과 동일한 provider 매핑을 ROOTS가 책임지므로 여기선 직접 주입.)
    #[test]
    fn scan_tags_provider_parses_frontmatter_and_skips_absent_root() {
        let claude = TempDir::new().unwrap();
        let codex = TempDir::new().unwrap();
        make_skill(
            claude.path(),
            "alpha",
            "---\nname: alpha\ndescription: \"클로드 스킬 A\"\n---\n# 본문\n",
        );
        make_skill(
            claude.path(),
            "beta",
            "---\nname: beta\ndescription: B\n---\n",
        );
        make_skill(
            codex.path(),
            "gamma",
            "---\nname: gamma\ndescription: G\n---\n",
        );
        // 존재하지 않는 openclaw 루트 — per-root skip(무에러).
        let absent = codex.path().join("nope");

        let roots = vec![
            SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Openclaw, absent),
        ];
        let out = scan_external_skills_core(&roots);

        // 부재 루트 스킵 → 3건, 이름 오름차순 정렬.
        assert_eq!(
            out.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "beta", "gamma"],
        );
        let by = |n: &str| out.iter().find(|s| s.name == n).unwrap();
        assert_eq!(by("alpha").provider, SkillProvider::Claude);
        assert_eq!(by("alpha").description, "클로드 스킬 A");
        assert_eq!(by("beta").provider, SkillProvider::Claude);
        assert_eq!(by("gamma").provider, SkillProvider::Codex);
        assert_eq!(by("gamma").description, "G");
    }

    /// 부분실패(C6): 읽기 가능 루트 + 읽기 불가 루트(파일=read_dir 실패) → 가능분만 반환·무에러.
    #[test]
    fn scan_skips_unreadable_root_returns_rest() {
        let good = TempDir::new().unwrap();
        make_skill(good.path(), "alpha", "---\nname: alpha\n---\n");
        // 루트 경로가 디렉터리가 아니라 파일이면 read_dir 실패 → 스킵.
        let file_root = good.path().join("not-a-dir");
        std::fs::write(&file_root, "x").unwrap();

        let roots = vec![
            SkillRoot::flat(SkillProvider::Claude, good.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Codex, file_root),
        ];
        let out = scan_external_skills_core(&roots);
        assert_eq!(out.len(), 1, "읽기 불가 루트는 스킵하고 가능분만 반환");
        assert_eq!(out[0].name, "alpha");
        assert_eq!(out[0].provider, SkillProvider::Claude);
    }

    /// 심링크로 설치된 스킬 dir도 발견한다(`is_dir() || is_symlink()`).
    #[cfg(unix)]
    #[test]
    fn scan_discovers_symlinked_skill_dir() {
        let target = TempDir::new().unwrap();
        let real = target.path().join("real-skill");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(
            real.join("SKILL.md"),
            "---\nname: linked\ndescription: L\n---\n",
        )
        .unwrap();

        let root = TempDir::new().unwrap();
        std::os::unix::fs::symlink(&real, root.path().join("linked-skill")).unwrap();

        let roots = vec![SkillRoot::flat(
            SkillProvider::Claude,
            root.path().to_path_buf(),
        )];
        let out = scan_external_skills_core(&roots);
        assert_eq!(out.len(), 1, "심링크된 스킬 dir을 발견해야 함");
        assert_eq!(out[0].name, "linked");
        assert_eq!(out[0].provider, SkillProvider::Claude);
    }

    /// 빈 ROOTS는 빈 결과(HOME 없음 graceful).
    #[test]
    fn scan_empty_roots_is_empty() {
        assert!(scan_external_skills_core(&[]).is_empty());
    }

    /// path-guard 루트별(C1): in-root 허용(각 루트) / `<root>/../../tmp/SKILL.md` 거부 / 전 루트 밖 거부 /
    /// 非SKILL.md 거부 / 빈 roots는 모든 경로 거부.
    #[test]
    fn path_guard_per_root() {
        let claude = TempDir::new().unwrap();
        let codex = TempDir::new().unwrap();
        let roots = vec![
            SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
        ];
        let g = |p: &str| ensure_within_skills_dir_roots(p, &roots);

        // in-root 허용(두 루트 각각).
        let ok_claude = claude.path().join("s").join("SKILL.md");
        assert!(g(ok_claude.to_str().unwrap()).is_ok());
        let ok_codex = codex.path().join("s").join("SKILL.md");
        assert!(g(ok_codex.to_str().unwrap()).is_ok());

        // `<root>/../../tmp/SKILL.md` 거부(.. 탈출).
        let escape = claude
            .path()
            .join("..")
            .join("..")
            .join("tmp")
            .join("SKILL.md");
        assert!(
            g(escape.to_str().unwrap()).is_err(),
            "prefix 공유 traversal 거부"
        );

        // 전 루트 밖 거부 + 非SKILL.md 거부.
        assert!(g("/etc/passwd").is_err());
        let not_skill = claude.path().join("s").join("notes.md");
        assert!(g(not_skill.to_str().unwrap()).is_err());

        // roots 비면 모든 경로 거부(HOME 없음 안전).
        assert!(ensure_within_skills_dir_roots(ok_claude.to_str().unwrap(), &[]).is_err());
    }

    /// 통합: `list_skills_core` = 인앱(DB) + 멀티루트 외부 병합, 외부 행에 provider, 인앱 행은 provider=None.
    #[tokio::test]
    async fn list_skills_core_merges_in_app_and_external_with_provider() {
        let db = fresh_db().await;
        seed_in_app_skills(&db).await.unwrap();

        let claude = TempDir::new().unwrap();
        let codex = TempDir::new().unwrap();
        make_skill(
            claude.path(),
            "alpha",
            "---\nname: alpha\ndescription: A\n---\n",
        );
        make_skill(
            codex.path(),
            "gamma",
            "---\nname: gamma\ndescription: G\n---\n",
        );
        let roots = vec![
            SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
        ];

        let all = list_skills_core(&db, &roots).await.unwrap();
        let in_app: Vec<_> = all.iter().filter(|s| s.kind == "in_app_prompt").collect();
        let external: Vec<_> = all.iter().filter(|s| s.kind == "external").collect();

        assert_eq!(in_app.len(), seed_defs().len(), "인앱 시드 전부 병합");
        assert!(
            in_app.iter().all(|s| s.provider.is_none()),
            "인앱 행은 provider=None"
        );

        assert_eq!(external.len(), 2, "외부 두 루트 병합");
        let ext = |n: &str| external.iter().find(|s| s.name == n).unwrap();
        assert_eq!(ext("alpha").provider, Some(SkillProvider::Claude));
        assert_eq!(ext("gamma").provider, Some(SkillProvider::Codex));
        assert!(ext("alpha").id.starts_with("ext:"));
    }

    /// 시드: 인앱 프롬프트가 들어가고, 시드 프롬프트 = 코드 상수와 동일(기본 동작 보존)이며 멱등.
    #[tokio::test]
    async fn seed_inserts_in_app_prompts_idempotently() {
        let db = fresh_db().await;
        seed_in_app_skills(&db).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM skills WHERE kind='in_app_prompt'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, seed_defs().len() as i64, "인앱 프롬프트 시드");

        // 시드 프롬프트는 코드 상수와 동일해야 한다(잡 lookup이 시드 행을 써도 결과 불변).
        let (p,): (String,) =
            sqlx::query_as("SELECT prompt FROM skills WHERE binding='batch_enrich'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(p, BATCH_ENRICH_PROMPT);

        // 재시드는 멱등(행 수 불변, 편집 덮어쓰지 않음).
        sqlx::query("UPDATE skills SET prompt='편집됨' WHERE binding='batch_enrich'")
            .execute(&db)
            .await
            .unwrap();
        seed_in_app_skills(&db).await.unwrap();
        let (n2,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM skills WHERE kind='in_app_prompt'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(n2, seed_defs().len() as i64, "재시드 멱등 — 행 수 불변");
        let (p2,): (String,) =
            sqlx::query_as("SELECT prompt FROM skills WHERE binding='batch_enrich'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(p2, "편집됨", "재시드는 사용자 편집을 보존(덮어쓰지 않음)");
    }

    /// 잡 lookup+폴백: 시드 행이 있으면 그 프롬프트, 편집하면 편집된 프롬프트, 행이 없으면 코드 상수,
    /// 비활성이면 코드 상수(기본 동작 불변). 핵심 INVARIANT — 레지스트리 부재/비활성 = 오늘과 동일.
    #[tokio::test]
    async fn resolve_prompt_uses_registry_then_falls_back() {
        let db = fresh_db().await;

        // (1) 레지스트리 비어 있음 → 폴백(코드 상수).
        let p = resolve_prompt(&db, BINDING_BATCH_ENRICH, BATCH_ENRICH_PROMPT).await;
        assert_eq!(p, BATCH_ENRICH_PROMPT, "레지스트리 부재 → 코드 상수 폴백");

        // (2) 시드 후 → 시드 프롬프트(= 코드 상수, 기본 동작 불변).
        seed_in_app_skills(&db).await.unwrap();
        let p = resolve_prompt(&db, BINDING_BATCH_ENRICH, BATCH_ENRICH_PROMPT).await;
        assert_eq!(p, BATCH_ENRICH_PROMPT, "시드 프롬프트 = 코드 상수");

        // (3) 편집 후 → 편집된 프롬프트(잡이 쓰는 제안 내용만 바뀐다).
        sqlx::query("UPDATE skills SET prompt='커스텀 enrich 지침' WHERE binding='batch_enrich'")
            .execute(&db)
            .await
            .unwrap();
        let p = resolve_prompt(&db, BINDING_BATCH_ENRICH, BATCH_ENRICH_PROMPT).await;
        assert_eq!(p, "커스텀 enrich 지침", "편집된 프롬프트를 잡이 사용");

        // (4) 비활성(enabled=0) → 코드 상수 폴백(끄면 오늘 동작으로 복귀).
        sqlx::query("UPDATE skills SET enabled=0 WHERE binding='batch_enrich'")
            .execute(&db)
            .await
            .unwrap();
        let p = resolve_prompt(&db, BINDING_BATCH_ENRICH, BATCH_ENRICH_PROMPT).await;
        assert_eq!(p, BATCH_ENRICH_PROMPT, "비활성 → 코드 상수 폴백");

        // (5) 빈 프롬프트 → 코드 상수 폴백(공백만 있는 행은 폴백).
        sqlx::query("UPDATE skills SET enabled=1, prompt='   ' WHERE binding='batch_enrich'")
            .execute(&db)
            .await
            .unwrap();
        let p = resolve_prompt(&db, BINDING_BATCH_ENRICH, BATCH_ENRICH_PROMPT).await;
        assert_eq!(p, BATCH_ENRICH_PROMPT, "빈 프롬프트 → 코드 상수 폴백");
    }

    /// CRUD: create(닫힌 binding 강제) → update(부분) → delete. 외부 id는 거부.
    #[tokio::test]
    async fn crud_in_app_prompts() {
        let db = fresh_db().await;

        // 미지의 binding은 거부(죽은 행 방지).
        let bad = create_skill_core(&db, "x", "p", Some("nonsense")).await;
        assert!(bad.is_err());

        // 미바인딩 생성 OK.
        let s = create_skill_core(&db, "내 템플릿", "지침", None)
            .await
            .unwrap();
        assert_eq!(s.kind, "in_app_prompt");
        assert!(s.binding.is_none());
        assert!(s.enabled);

        // 부분 업데이트(enabled만).
        let updated = update_skill_core(&db, &s.id, None, None, Some(false))
            .await
            .unwrap();
        assert!(!updated.enabled);
        assert_eq!(updated.prompt.as_deref(), Some("지침"), "prompt 미변경");

        // 삭제.
        delete_skill_core(&db, &s.id).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM skills WHERE id = ?1")
            .bind(&s.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0);

        // 외부 id는 update/delete 모두 거부(파일은 사용자 소유).
        assert!(
            update_skill_core(&db, "ext:/x/SKILL.md", Some("p"), None, None)
                .await
                .is_err()
        );
        assert!(delete_skill_core(&db, "ext:/x/SKILL.md").await.is_err());
    }

    /// 루트 resolution(C6 단일 출처, P1): 명시 override env가 최우선(존재 무관). override 없는 도구는
    /// dotfile 폴백. HOME 미설정이면 빈 목록.
    #[test]
    fn resolve_explicit_override_wins_else_dotfile() {
        let codex = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let env = SkillRootEnv {
            home: Some(home.path().to_path_buf()),
            claude_config_dir: None,
            codex_home: Some(codex.path().to_path_buf()),
            xdg_config_home: None,
        };
        let roots = resolve_skill_roots(&env);
        // CODEX_HOME set → `<CODEX_HOME>/skills`(존재 무관, 첫 Codex 루트).
        let codex_root = roots
            .iter()
            .find(|r| r.provider == SkillProvider::Codex)
            .unwrap();
        assert_eq!(codex_root.path, codex.path().join("skills"));
        // claude override 없음 → dotfile 폴백.
        let claude_root = roots
            .iter()
            .find(|r| r.provider == SkillProvider::Claude)
            .unwrap();
        assert_eq!(claude_root.path, home.path().join(".claude").join("skills"));
    }

    /// XDG 후보는 **존재할 때만** 채택(미존재 XDG는 dotfile 폴백 — Linux XDG 상존이 dotfile을 가로채지
    /// 않도록 존재 게이트).
    #[test]
    fn resolve_uses_existing_xdg_then_dotfile_fallback() {
        let xdg = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        // XDG codex/skills 존재 → 채택. claude는 XDG 후보 미존재 → dotfile.
        std::fs::create_dir_all(xdg.path().join("codex").join("skills")).unwrap();
        let env = SkillRootEnv {
            home: Some(home.path().to_path_buf()),
            claude_config_dir: None,
            codex_home: None,
            xdg_config_home: Some(xdg.path().to_path_buf()),
        };
        let roots = resolve_skill_roots(&env);
        let codex_root = roots
            .iter()
            .find(|r| r.provider == SkillProvider::Codex)
            .unwrap();
        assert_eq!(codex_root.path, xdg.path().join("codex").join("skills"));
        let claude_root = roots
            .iter()
            .find(|r| r.provider == SkillProvider::Claude)
            .unwrap();
        assert_eq!(claude_root.path, home.path().join(".claude").join("skills"));
    }

    /// HOME 미설정 → 빈 목록(graceful: 스캔 0건, 가드 전부 거부).
    #[test]
    fn resolve_no_home_is_empty() {
        let env = SkillRootEnv {
            home: None,
            claude_config_dir: None,
            codex_home: None,
            xdg_config_home: None,
        };
        assert!(resolve_skill_roots(&env).is_empty());
    }

    /// detect: provider별 집계(Codex=`.codex`+`.agents` 합산) + present(부재 루트 false) + 주 루트 root_path
    /// + provider 출현 순서 보존.
    #[test]
    fn detect_aggregates_per_provider_present_and_counts() {
        let claude = TempDir::new().unwrap();
        let codex = TempDir::new().unwrap();
        let agents = TempDir::new().unwrap();
        make_skill(claude.path(), "a", "---\nname: a\n---\n");
        make_skill(codex.path(), "b", "---\nname: b\n---\n");
        make_skill(agents.path(), "c", "---\nname: c\n---\n");
        let absent = codex.path().join("nope-openclaw");

        let roots = vec![
            SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Codex, agents.path().to_path_buf()),
            SkillRoot::flat(SkillProvider::Openclaw, absent),
        ];
        let envs = detect_skill_environments_core(&roots);

        // provider 출현 순서 보존 + Codex 한 줄로 집계.
        assert_eq!(
            envs.iter().map(|e| e.provider).collect::<Vec<_>>(),
            vec![
                SkillProvider::Claude,
                SkillProvider::Codex,
                SkillProvider::Openclaw
            ],
        );
        let by = |p: SkillProvider| envs.iter().find(|e| e.provider == p).unwrap();
        assert_eq!(by(SkillProvider::Claude).skill_count, 1);
        assert_eq!(
            by(SkillProvider::Codex).skill_count,
            2,
            ".codex + .agents 합산"
        );
        assert!(by(SkillProvider::Claude).present);
        assert!(by(SkillProvider::Codex).present);
        assert!(
            !by(SkillProvider::Openclaw).present,
            "부재 루트 → present=false"
        );
        // root_path = 주 루트(첫 Codex = `.codex` 대응).
        assert_eq!(
            by(SkillProvider::Codex).root_path,
            codex.path().to_string_lossy().into_owned(),
        );
    }

    /// frontmatter 파서: name/description 추출 + 따옴표 제거 + 비-frontmatter는 빈 값.
    #[test]
    fn frontmatter_parse() {
        let md = "---\nname: my-skill\ndescription: \"테스트 스킬\"\nother: x\n---\n# 본문\n";
        let (n, d) = parse_frontmatter(md);
        assert_eq!(n.as_deref(), Some("my-skill"));
        assert_eq!(d.as_deref(), Some("테스트 스킬"));

        // frontmatter 없으면 둘 다 None.
        let (n2, d2) = parse_frontmatter("# 그냥 본문\nname: 안 셈\n");
        assert!(n2.is_none() && d2.is_none());
    }

    // ── P1.5: 바운디드 재귀(깊이) ──────────────────────────────────────────────────────

    /// 재귀(P1.5 깊이): 중첩 카테고리 스킬을 발견하고, 리프 규칙으로 스킬 dir 하위는 하강하지 않는다.
    #[test]
    fn scan_recursive_finds_nested_and_leaf_rule_stops_descent() {
        let root = TempDir::new().unwrap();
        // 평면 스킬(depth1).
        make_skill(root.path(), "flat-skill", "---\nname: flat\n---\n");
        // 카테고리 중첩 스킬(depth2): <root>/cat/nested/SKILL.md.
        make_skill(
            &root.path().join("cat"),
            "nested",
            "---\nname: nested\n---\n",
        );
        // 리프 규칙: 스킬 dir 안에 또 SKILL.md가 있어도 그 하위는 안 본다(이중 카운트 방지).
        make_skill(
            &root.path().join("flat-skill"),
            "inner",
            "---\nname: inner\n---\n",
        );

        let roots = vec![SkillRoot::recursive(
            SkillProvider::Claude,
            root.path().to_path_buf(),
            4,
        )];
        let out = scan_external_skills_core(&roots);
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"flat"), "평면 스킬 발견");
        assert!(names.contains(&"nested"), "중첩 스킬 재귀 발견");
        assert!(
            !names.contains(&"inner"),
            "리프 규칙: 스킬 dir 하위는 미하강"
        );
        assert_eq!(out.len(), 2);
    }

    /// 재귀 안전: ignore 디렉터리(node_modules/숨김)는 스킵하고 `max_depth`를 초과하면 하강하지 않는다.
    #[test]
    fn scan_recursive_skips_ignored_dirs_and_respects_depth_cap() {
        let root = TempDir::new().unwrap();
        // ignore 대상: node_modules / 숨김 dir 안의 스킬은 무시.
        make_skill(
            &root.path().join("node_modules"),
            "junk",
            "---\nname: junk\n---\n",
        );
        make_skill(&root.path().join(".hidden"), "hid", "---\nname: hid\n---\n");
        // depth cap: max_depth=2면 depth3 스킬(<root>/a/b/deep)은 미발견.
        make_skill(
            &root.path().join("a").join("b"),
            "deep",
            "---\nname: deep\n---\n",
        );
        // depth2 스킬은 발견.
        make_skill(&root.path().join("c"), "ok2", "---\nname: ok2\n---\n");

        let roots = vec![SkillRoot::recursive(
            SkillProvider::Claude,
            root.path().to_path_buf(),
            2,
        )];
        let out = scan_external_skills_core(&roots);
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"ok2"), "depth2(=max) 스킬 발견");
        assert!(!names.contains(&"deep"), "depth3 > max_depth 미발견");
        assert!(!names.contains(&"junk"), "node_modules 무시");
        assert!(!names.contains(&"hid"), "숨김 dir 무시");
        assert_eq!(out.len(), 1);
    }

    /// 비재귀 루트는 중첩을 발견하지 않는다(P0 동작 회귀 보호).
    #[test]
    fn scan_non_recursive_ignores_nested() {
        let root = TempDir::new().unwrap();
        make_skill(root.path(), "top", "---\nname: top\n---\n");
        make_skill(
            &root.path().join("cat"),
            "nested",
            "---\nname: nested\n---\n",
        );

        let roots = vec![SkillRoot::flat(
            SkillProvider::Claude,
            root.path().to_path_buf(),
        )];
        let out = scan_external_skills_core(&roots);
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"top"));
        assert!(
            !names.contains(&"nested"),
            "비재귀 루트는 중첩 미발견(P0 동작)"
        );
    }

    /// 심링크 사이클(조상으로 되돌아가는 심링크)이 있어도 무한 루프 없이 종료하고 실제 스킬은 발견한다.
    #[cfg(unix)]
    #[test]
    fn scan_recursive_symlink_cycle_does_not_loop() {
        let root = TempDir::new().unwrap();
        make_skill(&root.path().join("cat"), "real", "---\nname: real\n---\n");
        // 사이클: <root>/cat/loop -> <root>(조상).
        std::os::unix::fs::symlink(root.path(), root.path().join("cat").join("loop")).unwrap();

        let roots = vec![SkillRoot::recursive(
            SkillProvider::Claude,
            root.path().to_path_buf(),
            4,
        )];
        let out = scan_external_skills_core(&roots);
        assert!(
            out.iter().any(|s| s.name == "real"),
            "실제 스킬 발견(무한 루프 없음)"
        );
    }

    /// 루트 resolution(P1.5): Hermes 재귀 루트가 포함되고, 도구 루트도 재귀이며, skm 자체 스토어는 제외.
    #[test]
    fn resolve_includes_hermes_recursive_and_excludes_skills_manager() {
        let home = TempDir::new().unwrap();
        let env = SkillRootEnv {
            home: Some(home.path().to_path_buf()),
            claude_config_dir: None,
            codex_home: None,
            xdg_config_home: None,
        };
        let roots = resolve_skill_roots(&env);

        let hermes = roots
            .iter()
            .find(|r| r.provider == SkillProvider::Hermes)
            .expect("Hermes 루트 존재");
        assert_eq!(hermes.path, home.path().join(".hermes").join("skills"));
        assert!(hermes.recursive, "Hermes는 재귀");
        // 도구 루트도 P1.5에서 전부 재귀.
        assert!(roots.iter().all(|r| r.recursive), "모든 루트 재귀");
        // skm 자체 스토어는 ROOTS에서 제외(대량 중복 방지 — Phase 1.5 #6).
        assert!(
            roots
                .iter()
                .all(|r| !r.path.to_string_lossy().contains(".skills-manager")),
            "skm 스토어 제외"
        );
    }

    // ── 테스트 코어(State 래퍼 없이 직접 호출) ──
    async fn create_skill_core(
        db: &Db,
        name: &str,
        prompt: &str,
        binding: Option<&str>,
    ) -> Result<Skill, String> {
        if let Some(b) = binding {
            if fallback_prompt(b).is_none() {
                return Err(format!("알 수 없는 binding '{b}'"));
            }
        }
        let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
            .fetch_one(db)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query_as::<_, Skill>(
            "INSERT INTO skills (id, name, kind, prompt, binding, rail, enabled) \
             VALUES (?1, ?2, 'in_app_prompt', ?3, ?4, 'suggestion', 1) \
             RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
        )
        .bind(&id.0)
        .bind(name)
        .bind(prompt)
        .bind(binding)
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())
    }

    async fn update_skill_core(
        db: &Db,
        id: &str,
        prompt: Option<&str>,
        name: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<Skill, String> {
        if id.starts_with("ext:") {
            return Err("외부 스킬은 수정 불가".into());
        }
        sqlx::query_as::<_, Skill>(
            "UPDATE skills SET prompt = COALESCE(?2, prompt), name = COALESCE(?3, name), \
                enabled = COALESCE(?4, enabled), updated_at = datetime('now') \
             WHERE id = ?1 AND kind = 'in_app_prompt' \
             RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
        )
        .bind(id)
        .bind(prompt)
        .bind(name)
        .bind(enabled)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "없음".to_string())
    }

    async fn delete_skill_core(db: &Db, id: &str) -> Result<(), String> {
        if id.starts_with("ext:") {
            return Err("외부 스킬은 삭제 불가".into());
        }
        let res = sqlx::query("DELETE FROM skills WHERE id = ?1 AND kind = 'in_app_prompt'")
            .bind(id)
            .execute(db)
            .await
            .map_err(|e| e.to_string())?;
        if res.rows_affected() == 0 {
            return Err("없음".into());
        }
        Ok(())
    }
}
