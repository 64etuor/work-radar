//! 스킬 레지스트리 목록/CRUD(G1-PR1 분할, 무행동변경). 인앱(DB SSOT) + 외부(디스크 스캔) 병합 목록과
//! 인앱 프롬프트 create/update/delete. 외부 스킬은 레지스트리에서 수정/삭제 불가(파일 사용자 소유).
//! 로직 불변 — `commands/skills.rs`에서 그대로 이동.

use std::path::Path;

use tauri::{Manager, State};

use crate::db::Db;
use crate::error::AppError;
use crate::models::{CreateSkillInput, Skill, SkillProvider};

use crate::skills::central_repo::list_managed_dirs;
use crate::skills::scan::{
    parse_frontmatter, scan_external_skills_core, skill_roots_db, SkillRoot,
};
use crate::skills::seed::fallback_prompt;

/// 레지스트리 목록: 인앱 프롬프트 + (디스크 스캔한) 외부 스킬을 합쳐 돌려준다. 인앱은 DB에서, 외부는
/// ROOTS(claude/codex/agents/openclaw)를 스캔해 ExternalSkill→Skill(kind="external", provider 태깅)으로
/// 합성한다(영속 안 함 — 디스크 SSOT).
#[tauri::command]
#[specta::specta]
pub async fn list_skills(db: State<'_, Db>, app: tauri::AppHandle) -> Result<Vec<Skill>, AppError> {
    // 중앙 라이브러리(managed SSOT) 루트. State/AppHandle은 tauri-specta가 TS 시그니처에서 제거하므로
    // `listSkills`의 바인딩은 인자 없이 그대로(드리프트 0).
    let central = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            AppError::terminal(
                "skills.app_data_dir",
                format!("앱 데이터 경로 해석 실패: {e}"),
            )
        })?
        .join("skills-library");
    list_skills_core_with(
        db.inner(),
        &skill_roots_db(db.inner()).await,
        Some(central.as_path()),
    )
    .await
}

/// `list_skills`의 코어(roots 주입 → hermetic 테스트). 중앙 라이브러리 없이(=None) 인앱+외부만 병합한다.
/// PR1부터의 호출부(테스트) 호환을 위해 시그니처 유지 — `list_skills_core_with`에 위임한다. 프로덕션
/// 경로(`list_skills` 커맨드)는 `_with`를 직접 부르므로 비테스트 빌드에선 미사용(scan/seed 관례).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn list_skills_core(db: &Db, roots: &[SkillRoot]) -> Result<Vec<Skill>, AppError> {
    list_skills_core_with(db, roots, None).await
}

/// 코어 + 중앙 라이브러리(managed) 병합. `central_root=Some`이면 managed 스킬을 포함하고, 같은
/// `(name, provider)`의 **발견 외부 스킬을 억제**한다(레일 ② — import한 중앙 복사본이 발견본을 대체).
pub(crate) async fn list_skills_core_with(
    db: &Db,
    roots: &[SkillRoot],
    central_root: Option<&Path>,
) -> Result<Vec<Skill>, AppError> {
    // 인앱(편집 가능 잡 템플릿) — DB SSOT. provider 컬럼은 없어 FromRow가 None을 채운다(#[sqlx(skip)]).
    let mut skills: Vec<Skill> = sqlx::query_as::<_, Skill>(
        "SELECT id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at \
         FROM skills WHERE kind = 'in_app_prompt' ORDER BY binding, name",
    )
    .fetch_all(db)
    .await
    .map_err(AppError::from)?;

    // 시드된 binding의 코드 상수 프롬프트를 in_app 행에 합성한다(#18 diff/복원 출처 — 외부 push 전이라
    // in_app만 순회). 미시드 binding/바인딩 없는 행은 None(diff 비대상). 도출이라 DB 컬럼 없음.
    for s in &mut skills {
        s.fallback_prompt = s
            .binding
            .as_deref()
            .and_then(fallback_prompt)
            .map(str::to_string);
    }

    // managed(중앙 라이브러리 = SSOT). central_root/<provider>/<name>/SKILL.md마다 frontmatter를 읽어
    // kind="managed" Skill을 합성하고, 억제용 (name, provider) 키를 모은다. 읽기불가 SKILL.md는 skip
    // (graceful). central_root=None이면 managed 0개(no-op) — 기존 코어 동작 보존.
    let mut managed_keys: std::collections::HashSet<(String, SkillProvider)> =
        std::collections::HashSet::new();
    if let Some(central) = central_root {
        for (provider, dir) in list_managed_dirs(central) {
            let md = dir.join("SKILL.md");
            let Ok(content) = std::fs::read_to_string(&md) else {
                continue;
            };
            let (fm_name, fm_desc) = parse_frontmatter(&content);
            let name = fm_name.unwrap_or_else(|| {
                dir.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            managed_keys.insert((name.trim().to_lowercase(), provider));
            skills.push(Skill {
                id: format!("managed:{}", md.to_string_lossy()),
                name,
                kind: "managed".into(),
                prompt: Some(fm_desc.unwrap_or_default()),
                binding: None,
                rail: None,
                enabled: true,
                model: None,
                reasoning_effort: None,
                fast_mode: false,
                source_path: Some(md.to_string_lossy().into_owned()),
                provider: Some(provider),
                tags: Vec::new(),
                fallback_prompt: None,
                created_at: String::new(),
                updated_at: String::new(),
            });
        }
    }

    // 외부(디스크 스킬) — 멀티루트 스캔해서 합성 행으로 덧붙인다(영속 안 함). 부재/읽기불가 루트는
    // per-root skip(무에러). 같은 (name, provider)의 managed가 있으면 **억제**(중앙 복사본이 대체본).
    for ex in scan_external_skills_core(roots) {
        if managed_keys.contains(&(ex.name.trim().to_lowercase(), ex.provider)) {
            continue;
        }
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
            tags: Vec::new(),
            fallback_prompt: None,
            created_at: String::new(),
            updated_at: String::new(),
        });
    }

    // 태그 일괄 로드(통합 Skill.id별 — 인앱/외부/managed 공통). 태그가 없는 DB(마이그레이션 직후)나 빈
    // 표여도 빈 맵이라 무영향. 태그 조회 실패는 치명적이지 않으므로 빈 태그로 graceful degrade(목록 보존).
    let tags_by_key = load_tags_by_key(db).await;
    for s in &mut skills {
        if let Some(ts) = tags_by_key.get(&s.id) {
            s.tags = ts.clone();
        }
    }
    Ok(skills)
}

/// `skill_tags`를 통합 Skill.id별로 묶어 돌려준다(태그 이름 오름차순). 조회 실패는 빈 맵으로 degrade
/// — 태그는 표시/필터 메타라 목록 자체를 막지 않는다(C6 graceful).
pub(crate) async fn load_tags_by_key(db: &Db) -> std::collections::HashMap<String, Vec<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT skill_key, tag FROM skill_tags ORDER BY tag",
    )
    .fetch_all(db)
    .await
    .unwrap_or_else(|e| {
        // 태그는 비핵심 메타라 목록을 막지 않는다 — degrade하되 원인은 남긴다(skill_roots_db 대칭).
        tracing::debug!(target: "skills.tags", error = %e, "tag load failed; degrading to empty");
        Vec::new()
    });
    let mut by_key: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (key, tag) in rows {
        by_key.entry(key).or_default().push(tag);
    }
    by_key
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
    // 행 삭제 후 그 키의 태그도 정리(orphan 방지). 외부 키는 무관(인앱 id만 매칭). 별도 statement라
    // 비원자적이지만 orphan 태그는 매칭 스킬이 없어 무해하므로 best-effort로 둔다(삭제 자체는 성공 처리).
    let _ = sqlx::query("DELETE FROM skill_tags WHERE skill_key = ?1")
        .bind(&id)
        .execute(db.inner())
        .await;
    Ok(())
}
