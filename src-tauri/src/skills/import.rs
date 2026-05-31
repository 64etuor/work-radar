//! 스킬 import(G1, ADR-0006 레일 ①②) — 발견 외부 스킬 → 중앙 라이브러리 복사(가역, 감사).
//!
//! 레일 ②(가역): 외부(src) SKILL.md는 **읽기만** 하고 중앙으로 복사한다. remove는 중앙 복사본만
//! 지운다(외부 파일 무손상 — central_repo가 보장). 레일 ①(감사): import/remove 매 쓰기를 `audit()`로
//! append-only 기록(detail=파일 수만, 본문·토큰 금지). **#1/#2 불변**: import는 잡을 spawn하지 않는다 —
//! 파일 복사일 뿐 자동 분류/실행 경로가 생기지 않는다(스킬은 결코 자동 실행되지 않음).
//
// 본 모듈의 IPC/helper는 Result<_, AppError>로 통일(단일 envelope, 레포 전역 규약) → 모듈 단위 허용.
#![allow(clippy::result_large_err)]

use crate::db::Db;
use crate::error::AppError;
use crate::models::{Skill, SkillProvider};
use crate::skills::audit_log::audit;
use crate::skills::central_repo::{
    central_skill_dir, import_to_central, provider_segment, remove_from_central, sanitize_segment,
};
use crate::skills::scan::parse_frontmatter;
use sqlx::SqlitePool;
use std::path::Path;
use tauri::{Manager, State};

/// `p.file_name()` 폴백 이름(lossy). 없으면 `"skill"`.
fn dir_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "skill".to_string())
}

/// dest dir의 **얕은** 파일 개수(서브디렉터리/내용은 세지 않음 — audit detail용 메타). 내용 미열람.
fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|ft| ft.is_file()).unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

/// core: 테스트 가능(앱 핸들 비의존). central_root + 외부 SKILL.md 경로 + provider.
/// 반환 Skill은 `list_skills_core`의 external 분기 리터럴을 `kind="managed"`로 복제한 형태.
pub(crate) async fn import_external_skill_core(
    pool: &SqlitePool,
    central_root: &Path,
    ext_skill_md: &Path,
    provider: SkillProvider,
) -> Result<Skill, AppError> {
    let src_dir = ext_skill_md
        .parent()
        .ok_or_else(|| AppError::validation("skills.import", "잘못된 스킬 경로입니다."))?;
    let content = std::fs::read_to_string(ext_skill_md).map_err(|e| {
        AppError::terminal("skills.import_read", format!("SKILL.md 읽기 실패: {e}"))
    })?;
    let (fm_name, fm_desc) = parse_frontmatter(&content);
    // 표시 이름 = frontmatter name 또는 src dir 이름 폴백. 저장 dir 세그먼트는 이를 path-safe하게 정제.
    let name = fm_name.unwrap_or_else(|| dir_name(src_dir));
    let seg = sanitize_segment(&name);
    let provider_str = provider_segment(provider);
    let dest = import_to_central(central_root, provider_str, &seg, src_dir)?;
    // detail은 비밀-free: 파일 수만(본문·frontmatter·토큰 금지). 레일 ① 감사 기록.
    let detail = format!("files={}", count_files(&dest));
    audit(
        pool,
        "import",
        "managed_skill",
        &dest.to_string_lossy(),
        Some(&ext_skill_md.to_string_lossy()),
        Some(&detail),
    )
    .await?;
    let md_path = dest.join("SKILL.md");
    Ok(Skill {
        id: format!("managed:{}", md_path.to_string_lossy()),
        name,
        kind: "managed".into(),
        prompt: Some(fm_desc.unwrap_or_default()),
        binding: None,
        rail: None,
        enabled: true,
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        source_path: Some(md_path.to_string_lossy().into_owned()),
        provider: Some(provider),
        tags: Vec::new(),
        fallback_prompt: None,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

/// 앱 데이터 경로 아래 중앙 라이브러리 루트(`app_data_dir/skills-library`).
fn central_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| {
            AppError::terminal(
                "skills.app_data_dir",
                format!("앱 데이터 경로 해석 실패: {e}"),
            )
        })?
        .join("skills-library"))
}

#[tauri::command]
#[specta::specta]
pub async fn import_external_skill(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    path: String,
    provider: SkillProvider,
) -> Result<Skill, AppError> {
    let central = central_root(&app)?;
    import_external_skill_core(&db, &central, Path::new(&path), provider).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_managed_skill(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    provider: SkillProvider,
    name: String,
) -> Result<(), AppError> {
    let central = central_root(&app)?;
    let provider_str = provider_segment(provider);
    let seg = sanitize_segment(&name);
    let dest = central_skill_dir(&central, provider_str, &seg);
    remove_from_central(&central, provider_str, &seg)?;
    audit(
        &db,
        "remove",
        "managed_skill",
        &dest.to_string_lossy(),
        None,
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn import_core_copies_and_audits() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let ext = tmp.path().join(".claude/skills/foo");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("SKILL.md"), "---\nname: foo\n---\nbody").unwrap();

        let skill = import_external_skill_core(
            &pool,
            &central,
            &ext.join("SKILL.md"),
            SkillProvider::Claude,
        )
        .await
        .expect("import");
        assert_eq!(skill.kind, "managed");
        assert_eq!(skill.name, "foo");
        // 중앙 복사본 존재, 외부 파일 무손상.
        assert!(central.join("claude/foo/SKILL.md").exists());
        assert!(ext.join("SKILL.md").exists());

        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].action, "import");
        // audit detail엔 본문("body")이 절대 들어가지 않는다(비밀-free 계약).
        assert!(log[0].detail.as_deref().is_none_or(|d| !d.contains("body")));
    }
}
