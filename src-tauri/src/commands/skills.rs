//! 스킬 공유 레지스트리 (Phase 20 #21). 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부
//! Claude/Codex 스킬(~/.claude/skills/*/SKILL.md)을 한 레지스트리에서 보기/편집/추가/토글한다.
//!
//! INVARIANT #1/#2 (구조적 보호):
//!  - 인앱 프롬프트 편집은 codex가 내는 *제안 내용*만 바꾼다. 잡 트리거는 binding으로 활성 프롬프트를
//!    조회하지만(`resolve_prompt`), 그 잡은 여전히 `gated=true`로 spawn되어 awaiting_approval에서 멈추고
//!    accept 코드(execute_accept_*)는 suggested_*/proposal만 쓴다 — 스킬을 편집해도 자동 분류/자동 적용
//!    경로는 절대 생기지 않는다. 스킬은 결코 자동 실행/적용되지 않는다.
//!  - 레지스트리가 비어 있거나 행이 비활성이면 잡 lookup은 코드 상수로 **폴백**한다(기본 동작 불변).
//!
//! INVARIANT #7: 인앱 프롬프트는 로컬 SQLite SSOT. 외부 스킬은 디스크가 SSOT이고 표는 캐시하지 않는다
//! (매 스캔마다 ~/.claude/skills에서 frontmatter를 읽는다).
//!
//! 토큰/비밀은 다루지 않는다(프롬프트 템플릿은 비밀 아님). 외부 스킬 파일을 *실행*하지 않는다 — 읽기/
//! (선택) 사용자 명시 편집만.

use tauri::State;

use crate::commands::agents::{BATCH_ENRICH_PROMPT, CI_TRIAGE_PROMPT, PR_SELFCHECK_PROMPT};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{CreateSkillInput, ExternalSkill, Skill};

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
/// ~/.claude/skills를 스캔해 ExternalSkill→Skill(kind="external")로 합성한다(영속 안 함 — 디스크 SSOT).
#[tauri::command]
#[specta::specta]
pub async fn list_skills(db: State<'_, Db>) -> Result<Vec<Skill>, AppError> {
    // 인앱(편집 가능 잡 템플릿) — DB SSOT.
    let mut skills: Vec<Skill> = sqlx::query_as::<_, Skill>(
        "SELECT id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at \
         FROM skills WHERE kind = 'in_app_prompt' ORDER BY binding, name",
    )
    .fetch_all(db.inner())
    .await
    .map_err(AppError::from)?;

    // 외부(디스크 스킬) — 스캔해서 합성 행으로 덧붙인다(영속 안 함). 스캔 실패는 인앱만 반환(graceful).
    if let Ok(externals) = scan_external_skills_core() {
        for ex in externals {
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
                created_at: String::new(),
                updated_at: String::new(),
            });
        }
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

/// ~/.claude/skills 디렉터리 경로(HOME 기반). HOME 미설정이면 None.
fn claude_skills_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".claude").join("skills"))
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

/// ~/.claude/skills/*/SKILL.md를 스캔해 frontmatter(name/description) + 경로를 모은다(읽기 전용).
/// 디렉터리 부재/HOME 미설정이면 빈 목록(graceful). 파일 자체는 실행하지 않는다.
pub(crate) fn scan_external_skills_core() -> Result<Vec<ExternalSkill>, String> {
    let Some(root) = claude_skills_dir() else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(Vec::new()); // 디렉터리 없음 = 외부 스킬 없음(graceful).
    };
    let mut out: Vec<ExternalSkill> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
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
        });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// 외부 Claude/Codex 스킬 스캔(~/.claude/skills/*/SKILL.md frontmatter → name/description/path).
/// 읽기 전용 브라우즈. 디렉터리 부재면 빈 목록(graceful degrade).
#[tauri::command]
#[specta::specta]
pub async fn scan_external_skills() -> Result<Vec<ExternalSkill>, AppError> {
    scan_external_skills_core().map_err(|e| AppError::terminal("skills.scan_failed", e))
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

/// 경로가 ~/.claude/skills 안에 있고 SKILL.md인지 검증(디렉터리 탈출/임의 파일 접근 방지).
fn ensure_within_skills_dir(path: &str) -> Result<(), String> {
    let root = claude_skills_dir().ok_or("HOME을 찾을 수 없습니다.")?;
    let p = std::path::Path::new(path);
    // 디렉터리 탈출 방지: `..` 컴포넌트 거부. starts_with는 `..`를 해소하지 않아
    // `.../skills/../../tmp/SKILL.md`처럼 root 접두를 공유하면서 탈출하는 경로가 통과하므로 별도 차단.
    if p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("경로에 '..'를 쓸 수 없습니다.".into());
    }
    if !p.starts_with(&root) {
        return Err("~/.claude/skills 밖의 경로는 접근할 수 없습니다.".into());
    }
    if p.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return Err("SKILL.md 파일만 읽고 쓸 수 있습니다.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    /// 디렉터리 탈출 방지: root 접두를 공유하지만 `..`로 탈출하는 경로는 거부, 정상 경로는 허용.
    #[test]
    fn ensure_within_skills_dir_rejects_prefix_sharing_traversal() {
        let Some(root) = claude_skills_dir() else {
            return; // HOME 없으면 skip
        };
        let escape = root.join("..").join("..").join("tmp").join("SKILL.md");
        assert!(
            ensure_within_skills_dir(escape.to_str().unwrap()).is_err(),
            "prefix 공유 traversal은 거부되어야 함: {escape:?}"
        );
        let ok = root.join("my-skill").join("SKILL.md");
        assert!(
            ensure_within_skills_dir(ok.to_str().unwrap()).is_ok(),
            "정상 skills 경로는 허용되어야 함"
        );
        // 밖 경로·잘못된 파일명도 여전히 거부.
        assert!(ensure_within_skills_dir("/etc/passwd").is_err());
        assert!(
            ensure_within_skills_dir(root.join("x").join("notes.md").to_str().unwrap()).is_err()
        );
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

    /// 경로 가드: ~/.claude/skills 밖 또는 SKILL.md 아닌 파일은 거부(디렉터리 탈출 방지).
    #[test]
    fn skills_dir_guard() {
        // HOME이 있어야 가드가 의미. CI/로컬 모두 HOME 존재 가정(없으면 Err로 안전).
        if let Some(root) = claude_skills_dir() {
            let ok = root.join("foo").join("SKILL.md");
            assert!(ensure_within_skills_dir(ok.to_str().unwrap()).is_ok());
            // 밖의 경로 거부.
            assert!(ensure_within_skills_dir("/etc/passwd").is_err());
            // SKILL.md 아님 거부.
            let bad = root.join("foo").join("secret.txt");
            assert!(ensure_within_skills_dir(bad.to_str().unwrap()).is_err());
        }
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
