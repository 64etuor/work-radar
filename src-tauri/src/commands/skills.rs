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
use crate::models::{CreateSkillInput, ExternalSkill, Skill, SkillProvider};
use std::path::PathBuf;

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
async fn list_skills_core(
    db: &Db,
    roots: &[(SkillProvider, PathBuf, bool)],
) -> Result<Vec<Skill>, AppError> {
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

/// 스캔·path-guard(·후속 P1 detect)가 **공유하는 단 하나의 루트 정의**(C6). 각 항목은
/// `(provider, 절대경로, recursive)`. `recursive`는 컬럼만 두고 P0는 전부 false(재귀 미반입).
/// HOME 미설정이면 빈 목록(전부 graceful — 스캔 0건, 가드는 모든 경로 거부).
///
/// `.agents/skills`는 도구 간 공유 발견 dir이라 P0에선 **Codex로 태깅**(upstream codex 귀속).
/// ⚑ Copilot 추가 시 `.agents/skills`는 공유되므로 **P1에서 귀속 재검토**. Hermes는 경로 미확인이라 제외.
fn skill_roots() -> Vec<(SkillProvider, PathBuf, bool)> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let skills_of = |dir: &str| home.join(dir).join("skills");
    vec![
        (SkillProvider::Claude, skills_of(".claude"), false),
        (SkillProvider::Codex, skills_of(".codex"), false),
        (SkillProvider::Codex, skills_of(".agents"), false),
        (SkillProvider::Openclaw, skills_of(".openclaw"), false),
    ]
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

/// ROOTS 각 `*/SKILL.md`를 스캔해 frontmatter(name/description) + provider + 경로를 모은다(읽기 전용).
/// roots **주입**(테스트는 tempdir roots → hermetic). 콘텐츠 해싱 없음(frontmatter-only). 파일은
/// 실행하지 않는다.
///
/// 부분실패 정책(C6): per-root **skip-and-continue** — 부재/읽기불가 루트는 스킵하고 나머지 루트의
/// 스킬을 반환한다(전체 스캔 에러 없음). 디렉터리 엔트리는 `is_dir() || is_symlink()`를 수용해
/// 심링크로 설치된 스킬 dir을 미드롭한다.
pub(crate) fn scan_external_skills_core(
    roots: &[(SkillProvider, PathBuf, bool)],
) -> Vec<ExternalSkill> {
    let mut out: Vec<ExternalSkill> = Vec::new();
    for (provider, root, _recursive) in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue; // 부재/읽기불가 루트는 스킵(graceful).
        };
        let mut root_count = 0usize;
        for entry in entries.flatten() {
            let dir = entry.path();
            // is_dir()는 심링크를 따라가므로 심링크→dir은 통과하고, 깨진/비-dir 심링크는 SKILL.md 읽기에서
            // 자연 스킵된다. 명시적으로 is_symlink()도 수용해 의도를 드러낸다.
            if !(dir.is_dir() || dir.is_symlink()) {
                continue;
            }
            let skill_md = dir.join("SKILL.md");
            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                continue; // SKILL.md 없는 디렉터리는 스킬 아님.
            };
            let (name, description) = parse_frontmatter(&content);
            let dir_name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("(unknown)")
                .to_string();
            out.push(ExternalSkill {
                name: name.unwrap_or(dir_name),
                description: description.unwrap_or_default(),
                path: skill_md.to_string_lossy().into_owned(),
                provider: *provider,
            });
            root_count += 1;
        }
        // no-PII(C7): provider+count만 기록 — 절대 경로/frontmatter 본문 금지.
        tracing::debug!(target: "skills.scan", provider = ?provider, count = root_count, "scanned skill root");
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
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
fn ensure_within_skills_dir_roots(
    path: &str,
    roots: &[(SkillProvider, PathBuf, bool)],
) -> Result<(), String> {
    let p = std::path::Path::new(path);
    // 디렉터리 탈출 방지: `..` 컴포넌트 거부. starts_with는 `..`를 해소하지 않아
    // `<root>/../../tmp/SKILL.md`처럼 root 접두를 공유하면서 탈출하는 경로가 통과하므로 별도 차단.
    if p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("경로에 '..'를 쓸 수 없습니다.".into());
    }
    if p.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return Err("SKILL.md 파일만 읽고 쓸 수 있습니다.".into());
    }
    if !roots.iter().any(|(_, root, _)| p.starts_with(root)) {
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
            (SkillProvider::Claude, claude.path().to_path_buf(), false),
            (SkillProvider::Codex, codex.path().to_path_buf(), false),
            (SkillProvider::Openclaw, absent, false),
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
            (SkillProvider::Claude, good.path().to_path_buf(), false),
            (SkillProvider::Codex, file_root, false),
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

        let roots = vec![(SkillProvider::Claude, root.path().to_path_buf(), false)];
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
            (SkillProvider::Claude, claude.path().to_path_buf(), false),
            (SkillProvider::Codex, codex.path().to_path_buf(), false),
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
            (SkillProvider::Claude, claude.path().to_path_buf(), false),
            (SkillProvider::Codex, codex.path().to_path_buf(), false),
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
