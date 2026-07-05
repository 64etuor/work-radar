//! 스킬 시드/폴백/프롬프트 해석(G1-PR1 분할, 무행동변경). 인앱 프롬프트 binding 상수, 시드 정의,
//! 잡 트리거가 쓰는 프롬프트/런타임 해석. 로직 불변 — `commands/skills.rs`에서 그대로 이동.

use crate::commands::agents::{
    BATCH_ENRICH_PROMPT, CI_TRIAGE_PROMPT, OKR_IMPORT_PROMPT, PR_SELFCHECK_PROMPT,
};
use crate::db::Db;

/// 인앱 프롬프트 binding 키(잡 트리거가 lookup에 쓰는 식별자). 하드코딩 프롬프트와 1:1.
pub(crate) const BINDING_BATCH_ENRICH: &str = "batch_enrich";
pub(crate) const BINDING_CI_TRIAGE: &str = "ci_triage";
pub(crate) const BINDING_PR_SELFCHECK: &str = "pr_selfcheck";
pub(crate) const BINDING_OKR_IMPORT: &str = "okr_import";
pub(crate) const BINDING_WORKTREE_REVIEW: &str = "worktree_review";
pub(crate) const BINDING_WORKTREE_CLEANUP: &str = "worktree_cleanup";
pub(crate) const FAST_CODEX_MODEL: &str = "gpt-5.3-codex-spark";

const WORKTREE_REVIEW_PROMPT: &str = "You are reviewing a worktree in read-only mode. Focus on architectural issues, risky changes, dead code, dependency impact, missing tests, and merge conflict risk. Do not edit files. Return a concise Korean review with findings ordered by severity and concrete file references when available.";
const WORKTREE_CLEANUP_PROMPT: &str = "Review the listed local worktree cleanup candidates. Identify which items are safe to delete and explain the evidence for each recommendation. Use a conservative rule: stale means 2+ days with no activity, merged branches are safer than unmerged stale branches, protected/current/base branches must stay, and destructive cleanup needs human confirmation. Return concise bullets with keep/delete/review labels.";

/// (binding, 표시 이름, 코드 상수 프롬프트) 시드 정의. 시드/폴백 둘 다 이 표에서 도출한다(단일 출처).
pub(crate) fn seed_defs() -> [(&'static str, &'static str, &'static str); 6] {
    [
        (
            BINDING_BATCH_ENRICH,
            "브레인덤프 enrich (배치)",
            BATCH_ENRICH_PROMPT,
        ),
        (BINDING_OKR_IMPORT, "OKR 받아쓰기", OKR_IMPORT_PROMPT),
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
pub(crate) fn fallback_prompt(binding: &str) -> Option<&'static str> {
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
