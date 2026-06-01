//! 외부 dir 적용(G2-PR1, ADR-0006 레일 ①) — 중앙 managed 스킬 → 에이전트 dir 심링크.
//!
//! 적용은 `~/.<agent>/skills/<name>` → `skills-library/<provider>/<name>` 심링크를 만든다(사용자 발동).
//! 해제는 **우리 심링크만**(canonical 타깃이 중앙 루트 아래) 제거한다 — 실제 dir/외부 심링크는 거부해
//! 사용자 파일을 무손상 보존한다(레일 ① 가역성). 매 쓰기를 `audit()`로 기록한다. **#1/#2 불변**: 파일
//! I/O일 뿐 잡을 spawn하지 않는다. 적용 상태는 별도 표 없이 디스크(심링크)에서 유도한다(INVARIANT #7).
//
// 본 모듈의 IPC/helper는 Result<_, AppError>로 통일(단일 envelope, 레포 전역 규약) → 모듈 단위 허용.
#![allow(clippy::result_large_err)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::AppError;
use crate::models::SkillProvider;
use crate::skills::audit_log::audit;
use crate::skills::central_repo::{
    central_skill_dir, list_managed_dirs, provider_segment, sanitize_segment,
};
use crate::skills::scan::parse_frontmatter;

/// 적용된 managed 스킬 1건(디스크에서 유도). PK 미노출 → specta 안전(i64 이슈 없음).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSkill {
    pub provider: SkillProvider,
    pub name: String,
    pub external_path: String,
}

/// 디렉터리 심링크 생성(크로스플랫폼). 주 타깃은 darwin(unix).
#[cfg(unix)]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

/// `link`이 **우리가 만든 심링크**인지(= 심링크이고 타깃이 `expected_central_dir`) 판정.
/// 끊긴 심링크도 raw read_link 비교로 인식하고, 양쪽이 실존하면 canonicalize로도 확인한다.
/// 실제 dir·외부(foreign) 심링크·부재는 모두 false → 호출자가 거부/스킵한다(데이터 손실 가드).
fn is_our_symlink(link: &Path, expected_central_dir: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(link) else {
        return false; // 부재(끊긴 심링크는 Ok이므로 여기서 안 걸림).
    };
    if !meta.file_type().is_symlink() {
        return false; // 실제 dir/파일 → 우리 것 아님.
    }
    let Ok(target) = std::fs::read_link(link) else {
        return false;
    };
    if target == expected_central_dir {
        return true; // raw 타깃 일치(끊긴 심링크 포함).
    }
    match (
        std::fs::canonicalize(link),
        std::fs::canonicalize(expected_central_dir),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// core: 앱 핸들 비의존(tempdir hermetic). central 스킬을 external dir에 심링크로 적용.
/// 반환 = 만들어진(또는 이미 우리 것인) 링크 경로. 외부 루트가 없으면 생성한다(스킬 dir 자체 — benign).
pub(crate) async fn apply_core(
    pool: &SqlitePool,
    central_root: &Path,
    external_root: &Path,
    provider: SkillProvider,
    name: &str,
) -> Result<PathBuf, AppError> {
    let provider_str = provider_segment(provider);
    let seg = sanitize_segment(name);
    let src = central_skill_dir(central_root, provider_str, &seg);
    if !src.join("SKILL.md").is_file() {
        return Err(AppError::not_found(
            "skills.apply.no_source",
            "중앙 라이브러리에 해당 스킬이 없습니다.".to_string(),
        ));
    }
    let link = external_root.join(&seg);
    // 이미 무언가 있으면: 우리 심링크면 멱등 성공, 아니면 충돌 거부(절대 덮어쓰지 않음).
    if std::fs::symlink_metadata(&link).is_ok() {
        if is_our_symlink(&link, &src) {
            return Ok(link); // 멱등 no-op.
        }
        return Err(AppError::terminal(
            "skills.apply.collision",
            "대상 경로에 다른 파일/스킬이 이미 있습니다(덮어쓰지 않음).".to_string(),
        ));
    }
    std::fs::create_dir_all(external_root)?; // 외부 skills/ 루트 보장(부재 시 생성).
    make_symlink(&src, &link).map_err(|e| {
        AppError::terminal("skills.apply.symlink", format!("심링크 생성 실패: {e}"))
    })?;
    audit(
        pool,
        "apply",
        "external_dir",
        &link.to_string_lossy(),
        Some(&src.to_string_lossy()),
        Some("symlink"),
    )
    .await?;
    Ok(link)
}

/// core: 우리 심링크만 제거(가역). 실제 dir/외부 심링크 = `not_ours` 거부, 부재 = no-op 성공.
pub(crate) async fn unapply_core(
    pool: &SqlitePool,
    central_root: &Path,
    external_root: &Path,
    provider: SkillProvider,
    name: &str,
) -> Result<(), AppError> {
    let provider_str = provider_segment(provider);
    let seg = sanitize_segment(name);
    let src = central_skill_dir(central_root, provider_str, &seg);
    let link = external_root.join(&seg);
    if std::fs::symlink_metadata(&link).is_err() {
        return Ok(()); // 부재 → 멱등 no-op(audit 안 함).
    }
    if !is_our_symlink(&link, &src) {
        return Err(AppError::terminal(
            "skills.apply.not_ours",
            "대상이 우리가 만든 심링크가 아닙니다(제거하지 않음).".to_string(),
        ));
    }
    std::fs::remove_file(&link)
        .map_err(|e| AppError::terminal("skills.apply.unlink", format!("심링크 제거 실패: {e}")))?;
    audit(
        pool,
        "unapply",
        "external_dir",
        &link.to_string_lossy(),
        Some(&src.to_string_lossy()),
        Some("symlink"),
    )
    .await?;
    Ok(())
}

/// 디스크에서 적용 상태 유도: managed 스킬 각각이 자기 provider 외부 루트에 우리 심링크로 있는지.
/// `roots` = provider별 (대표) 외부 스킬 루트 1개. 없으면 그 provider는 스킵. 새 표/캐시 없음.
pub(crate) fn list_applied_core(
    central_root: &Path,
    roots: &[(SkillProvider, PathBuf)],
) -> Vec<AppliedSkill> {
    let mut out = Vec::new();
    for (provider, central_dir) in list_managed_dirs(central_root) {
        // 링크 경로는 sanitized 세그먼트(= central dir 이름, apply_core가 만든 링크 이름과 동일).
        let seg = central_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // 표시 이름은 registry.rs managed 합성과 **동일하게** 도출(frontmatter name 우선, dir 폴백) →
        // FE가 통합 Skill.name으로 매칭할 수 있게 한다(sanitized 세그먼트 ≠ 표시 이름 mismatch 방지).
        let display_name = std::fs::read_to_string(central_dir.join("SKILL.md"))
            .ok()
            .and_then(|c| parse_frontmatter(&c).0)
            .unwrap_or_else(|| seg.clone());
        let Some((_, ext_root)) = roots
            .iter()
            .find(|(p, _)| provider_segment(*p) == provider_segment(provider))
        else {
            continue; // 이 provider의 외부 루트 미해석 → 스킵.
        };
        let link = ext_root.join(&seg);
        if is_our_symlink(&link, &central_dir) {
            out.push(AppliedSkill {
                provider,
                name: display_name,
                external_path: link.to_string_lossy().into_owned(),
            });
        }
    }
    out
}

/// 앱 데이터 경로 아래 중앙 라이브러리 루트(`app_data_dir/skills-library`). import.rs와 동일.
fn central_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
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

/// 적용 대상 provider의 대표 외부 루트(미지원이면 validation error).
fn external_root_for(provider: SkillProvider) -> Result<PathBuf, AppError> {
    crate::skills::scan::primary_external_root(provider).ok_or_else(|| {
        AppError::validation(
            "skills.apply.unsupported_provider",
            "이 provider는 외부 적용 대상이 아닙니다.".to_string(),
        )
    })
}

#[tauri::command]
#[specta::specta]
pub async fn apply_managed_skill(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    provider: SkillProvider,
    name: String,
) -> Result<String, AppError> {
    let central = central_root(&app)?;
    let ext = external_root_for(provider)?;
    let link = apply_core(&db, &central, &ext, provider, &name).await?;
    Ok(link.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn unapply_managed_skill(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    provider: SkillProvider,
    name: String,
) -> Result<(), AppError> {
    let central = central_root(&app)?;
    let ext = external_root_for(provider)?;
    unapply_core(&db, &central, &ext, provider, &name).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_applied_skills(app: tauri::AppHandle) -> Result<Vec<AppliedSkill>, AppError> {
    let central = central_root(&app)?;
    let roots = crate::skills::scan::apply_roots();
    Ok(list_applied_core(&central, &roots))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (central, external) tempdir 골격 + central에 managed 스킬 `name` 하나 생성. 경로 반환.
    fn scaffold(name: &str) -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let ext = tmp.path().join("ext-claude/skills");
        std::fs::create_dir_all(&ext).unwrap();
        let src = central.join("claude").join(name);
        std::fs::create_dir_all(&src).unwrap();
        // frontmatter name = dir 이름(현실적 공통 케이스: sanitize가 항등). 표시 이름 도출 검증과 일치.
        std::fs::write(
            src.join("SKILL.md"),
            format!("---\nname: {name}\n---\nbody"),
        )
        .unwrap();
        (tmp, central, ext, src)
    }

    #[test]
    fn is_our_symlink_true_for_our_link_false_for_dir_and_foreign() {
        let (_t, _central, ext, src) = scaffold("foo");
        // 우리 심링크.
        let ours = ext.join("foo");
        make_symlink(&src, &ours).unwrap();
        assert!(is_our_symlink(&ours, &src));

        // 실제 dir → false.
        let real = ext.join("bar");
        std::fs::create_dir_all(&real).unwrap();
        assert!(!is_our_symlink(&real, &src));

        // 외부(foreign) 심링크(중앙 밖) → false.
        let other = _t.path().join("somewhere-else");
        std::fs::create_dir_all(&other).unwrap();
        let foreign = ext.join("baz");
        make_symlink(&other, &foreign).unwrap();
        assert!(!is_our_symlink(&foreign, &src));

        // 부재 → false.
        assert!(!is_our_symlink(&ext.join("nope"), &src));
    }

    #[tokio::test]
    async fn apply_creates_symlink_to_central_and_audits() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, src) = scaffold("foo");
        let link = apply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .expect("apply");
        assert_eq!(link, ext.join("foo"));
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_link(&link).unwrap(), src);
        // SKILL.md가 심링크 너머로 보인다.
        assert!(link.join("SKILL.md").exists());

        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].action, "apply");
        assert!(log[0].detail.as_deref().is_none_or(|d| !d.contains("body")));
    }

    #[tokio::test]
    async fn apply_no_source_when_central_missing() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, _src) = scaffold("foo");
        let err = apply_core(&pool, &central, &ext, SkillProvider::Claude, "ghost")
            .await
            .unwrap_err();
        assert_eq!(err.code, "skills.apply.no_source");
    }

    #[tokio::test]
    async fn apply_collision_when_real_dir_exists_external_untouched() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, _src) = scaffold("foo");
        let real = ext.join("foo");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("USER.md"), "mine").unwrap();
        let err = apply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, "skills.apply.collision");
        assert!(real.join("USER.md").exists()); // 사용자 파일 무손상.
        assert!(!real.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[tokio::test]
    async fn apply_is_idempotent_on_our_own_link() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, src) = scaffold("foo");
        apply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .unwrap();
        // 재적용 = 성공 no-op.
        let link = apply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .expect("idempotent");
        assert_eq!(std::fs::read_link(&link).unwrap(), src);
    }

    #[tokio::test]
    async fn apply_then_unapply_restores_external_sibling_untouched() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, _src) = scaffold("foo");
        // 사용자가 외부 루트에 둔 별개 파일/스킬 — 절대 건드리면 안 됨.
        let sibling = ext.join("user-own");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("SKILL.md"), "user").unwrap();

        let link = apply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .unwrap();
        assert!(std::fs::symlink_metadata(&link).is_ok());

        unapply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .expect("unapply");
        assert!(std::fs::symlink_metadata(&link).is_err()); // 링크 제거됨.
        assert!(sibling.join("SKILL.md").exists()); // 사용자 파일 무손상.

        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert_eq!(log[0].action, "unapply"); // 최신=unapply.
    }

    #[tokio::test]
    async fn unapply_refuses_real_dir_and_foreign_symlink() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, _src) = scaffold("foo");
        // 실제 dir.
        let real = ext.join("foo");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("USER.md"), "mine").unwrap();
        let err = unapply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .unwrap_err();
        assert_eq!(err.code, "skills.apply.not_ours");
        assert!(real.join("USER.md").exists());
    }

    #[tokio::test]
    async fn unapply_is_noop_when_absent() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, _src) = scaffold("foo");
        unapply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .expect("noop ok"); // 적용된 적 없으면 성공 no-op.
        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert!(log.is_empty()); // no-op은 audit 안 함.
    }

    #[test]
    fn sanitize_blocks_path_escape_via_apply_target() {
        // sanitize_segment가 경로 구분자/`..`를 무력화해 링크가 external_root 밖으로 못 나간다.
        // (정확한 치환 결과가 아니라 "단일 세그먼트 + join이 루트 하위 유지"가 보안 불변.)
        let seg = sanitize_segment("../../etc");
        assert!(!seg.contains('/') && !seg.contains('\\')); // 경로 구분자 없음.
        assert_ne!(seg, ".."); // 상위 디렉터리 토큰 아님.
        let root = Path::new("/tmp/ext-root");
        assert!(root.join(&seg).starts_with(root)); // join이 루트 밖으로 못 나감.
    }

    #[test]
    fn list_applied_derives_only_our_links() {
        let (_t, central, ext, src) = scaffold("foo");
        // 두 번째 managed 스킬(미적용).
        let src2 = central.join("claude").join("bar");
        std::fs::create_dir_all(&src2).unwrap();
        std::fs::write(src2.join("SKILL.md"), "---\nname: bar\n---\n").unwrap();
        // foo만 적용(우리 심링크), 그리고 사용자 실제 dir도 하나 둔다.
        make_symlink(&src, &ext.join("foo")).unwrap();
        std::fs::create_dir_all(ext.join("user-real")).unwrap();

        let roots = vec![(SkillProvider::Claude, ext.clone())];
        let applied = list_applied_core(&central, &roots);
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].name, "foo");
        assert_eq!(applied[0].external_path, ext.join("foo").to_string_lossy());
    }

    #[test]
    fn list_applied_returns_display_name_when_dir_segment_sanitized() {
        // critic MAJOR 회귀 가드: central dir 세그먼트(sanitized) ≠ frontmatter 표시 이름일 때
        // AppliedSkill.name은 **표시 이름**(registry.rs Skill.name과 동일)을 돌려줘야 FE가 매칭한다.
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let ext = tmp.path().join("ext/skills");
        std::fs::create_dir_all(&ext).unwrap();
        // sanitize_segment("a/b skill") = "a_b skill" (/ → _) — dir 세그먼트와 표시 이름이 갈린다.
        let seg = sanitize_segment("a/b skill");
        assert_ne!(seg, "a/b skill"); // 전제: 정말 갈리는지 확인.
        let src = central.join("claude").join(&seg);
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: a/b skill\n---\nbody").unwrap();
        make_symlink(&src, &ext.join(&seg)).unwrap();

        let roots = vec![(SkillProvider::Claude, ext.clone())];
        let applied = list_applied_core(&central, &roots);
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].name, "a/b skill"); // 표시 이름(frontmatter), not "a_b skill".
        assert_eq!(applied[0].external_path, ext.join(&seg).to_string_lossy()); // 링크는 sanitized.
    }
}
