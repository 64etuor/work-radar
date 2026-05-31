//! 스킬 auto-updater(G1.5-PR3, ADR-0006 레일 ④) — opt-in·bounded·**fetch-only** 업스트림 업데이트.
//!
//! 네트워크 확인은 PR1 `remote::{parse_source,fetch_tarball_bytes,extract_tarball}`를 재사용해 업스트림
//! resolved commit를 다시 구하고, `installed_commit`보다 새로우면 staging(`app_data_dir/skills-staging/`)에
//! 받아둔다(아직 적용 아님). apply는 **사전 전체 백업**(PR2 `backup_library_core`) 후 central을 staging으로
//! 교체하고 commit를 승격한다. **스킬을 실행/적용 자동화하지 않는다 — 잡 spawn 0(#1/#2)**. on-launch는
//! opt-in 글로벌 setting이 켜졌을 때 **딱 한 패스**(폴 루프 아님). 토큰은 Rust에만(이번 라운드 공개 우선 None).
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::models::{Skill, SkillProvider};
use crate::skills::audit_log::audit;
use crate::skills::central_repo::import_to_central;
use crate::skills::scan::parse_frontmatter;
use crate::skills::source::{get_skill_source, promote_staged_commit, SkillSource};

/// 한 managed 스킬의 업데이트 상태(provenance 파생 — 네트워크 비취급). 뱃지/토글/적용 UI가 쓴다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub provider: String,
    pub name: String,
    pub installed_commit: String,
    pub staged_commit: Option<String>,
    pub auto_update: bool,
    pub last_checked_at: Option<String>,
    /// staging에 installed와 다른 commit가 받아져 있으면 true(적용 가능).
    pub update_available: bool,
}

/// provenance 1행 → UpdateStatus. update_available = staged가 있고 installed와 다름.
pub(crate) fn status_from_source(s: &SkillSource) -> UpdateStatus {
    let update_available = s
        .staged_commit
        .as_deref()
        .is_some_and(|c| c != s.installed_commit);
    UpdateStatus {
        provider: s.provider.clone(),
        name: s.name.clone(),
        installed_commit: s.installed_commit.clone(),
        staged_commit: s.staged_commit.clone(),
        auto_update: s.auto_update,
        last_checked_at: s.last_checked_at.clone(),
        update_available,
    }
}

/// staging 스킬 dir(`<staging_root>/<provider>/<name>`).
pub(crate) fn staging_skill_dir(staging_root: &Path, provider: &str, name: &str) -> PathBuf {
    staging_root.join(provider).join(name)
}

/// content_dir(검증된 SKILL.md 포함)를 staging/<provider>/<name>/로 복사. 재호출 멱등(기존 제거 후 복사).
/// 심링크는 따르지 않는다(central_repo::import_to_central 계약 재사용). 테스트 가능(앱 핸들 비의존).
pub(crate) fn stage_from_dir(
    staging_root: &Path,
    provider: &str,
    name: &str,
    content_dir: &Path,
) -> Result<PathBuf, AppError> {
    // import_to_central은 "src dir → dest dir 복사(기존 제거 후, 심링크 skip)"라 staging에도 그대로 맞다.
    import_to_central(staging_root, provider, name, content_dir)
}

/// dest dir의 얕은 파일 수(audit detail용 — 내용 미열람).
fn count_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|ft| ft.is_file()).unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

/// core: 가역 apply(hermetic). 순서 = ① staged_commit 존재 검증(없으면 NotFound) → ② **사전 전체 백업**
/// (PR2 backup_library_core — 적용을 가역으로) → ③ central<-staging 교체(import_to_central 재사용) →
/// ④ installed_commit 승격 + staged 비움 → ⑤ staging 정리 → ⑥ audit("update_apply"). 잡 spawn 0(#1/#2).
pub(crate) async fn apply_update_core(
    pool: &SqlitePool,
    central_root: &Path,
    staging_root: &Path,
    backups_root: &Path,
    provider: &str,
    name: &str,
    backup_id: &str,
) -> Result<Skill, AppError> {
    let source = get_skill_source(pool, provider, name).await?.ok_or_else(|| {
        AppError::not_found(
            "skills.update.no_source",
            "업데이트 출처 정보가 없습니다.".to_string(),
        )
    })?;
    let staged = source.staged_commit.clone().ok_or_else(|| {
        AppError::not_found(
            "skills.update.nothing_staged",
            "적용할 업데이트가 없습니다.".to_string(),
        )
    })?;
    let staged_dir = staging_skill_dir(staging_root, provider, name);
    if !staged_dir.join("SKILL.md").is_file() {
        return Err(AppError::not_found(
            "skills.update.staged_missing",
            "staging에 받아둔 업데이트를 찾을 수 없습니다.".to_string(),
        ));
    }

    // ② 사전 전체 백업(적용 직전 상태 보존 → restore UI로 되돌릴 수 있음).
    crate::skills::backup::backup_library_core(pool, central_root, backups_root, backup_id).await?;

    // ③ central 교체(기존 제거 후 staging 내용 복사).
    let dest = import_to_central(central_root, provider, name, &staged_dir)?;

    // ④ commit 승격 + staged 비움.
    promote_staged_commit(pool, provider, name, &staged).await?;

    // ⑤ staging 정리.
    if staged_dir.exists() {
        std::fs::remove_dir_all(&staged_dir)?;
    }

    // ⑥ audit(비밀-free: 파일 수 + commit).
    let detail = format!("files={},commit={}", count_files(&dest), staged);
    audit(
        pool,
        "update_apply",
        "managed_skill",
        &dest.to_string_lossy(),
        Some(&source.source_url),
        Some(&detail),
    )
    .await?;

    // 반환 Skill = install_from_dir와 동일 형태.
    let md = dest.join("SKILL.md");
    let content = std::fs::read_to_string(&md).unwrap_or_default();
    let (fm_name, fm_desc) = parse_frontmatter(&content);
    let prov = match provider {
        "claude" => SkillProvider::Claude,
        "codex" => SkillProvider::Codex,
        "openclaw" => SkillProvider::Openclaw,
        "hermes" => SkillProvider::Hermes,
        _ => SkillProvider::Other,
    };
    Ok(Skill {
        id: format!("managed:{}", md.to_string_lossy()),
        name: fm_name.unwrap_or_else(|| name.to_string()),
        kind: "managed".into(),
        prompt: Some(fm_desc.unwrap_or_default()),
        binding: None,
        rail: None,
        enabled: true,
        model: None,
        reasoning_effort: None,
        fast_mode: false,
        source_path: Some(md.to_string_lossy().into_owned()),
        provider: Some(prov),
        tags: Vec::new(),
        fallback_prompt: None,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;
    use crate::skills::source::{record_update_check, upsert_skill_source, NewSkillSource};

    fn src(installed: &str, staged: Option<&str>) -> SkillSource {
        SkillSource {
            id: 1,
            provider: "claude".into(),
            name: "foo".into(),
            source_url: "github.com/o/r".into(),
            source_ref: None,
            subpath: None,
            installed_commit: installed.into(),
            auto_update: false,
            staged_commit: staged.map(|s| s.into()),
            last_checked_at: None,
        }
    }

    #[test]
    fn update_available_only_when_staged_differs() {
        assert!(!status_from_source(&src("c1", None)).update_available);
        assert!(!status_from_source(&src("c1", Some("c1"))).update_available); // 같음 → 아님
        assert!(status_from_source(&src("c1", Some("c2"))).update_available); // 다름 → 적용 가능
    }

    #[test]
    fn stage_copies_content_into_staging() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("skills-staging");
        let content = tmp.path().join("content");
        std::fs::create_dir_all(&content).unwrap();
        std::fs::write(content.join("SKILL.md"), "---\nname: foo\n---\nNEW").unwrap();

        let dest = stage_from_dir(&staging, "claude", "foo", &content).unwrap();
        assert!(dest.join("SKILL.md").exists());
        assert_eq!(dest, staging_skill_dir(&staging, "claude", "foo"));
        // 멱등: 다시 stage하면 새 내용으로 교체.
        std::fs::write(content.join("SKILL.md"), "---\nname: foo\n---\nNEWER").unwrap();
        stage_from_dir(&staging, "claude", "foo", &content).unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            "---\nname: foo\n---\nNEWER"
        );
    }

    #[tokio::test]
    async fn apply_backs_up_replaces_central_and_promotes_commit() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let staging = tmp.path().join("skills-staging");
        let backups = tmp.path().join("skills-backups");

        // 설치된 foo(commit c1) + provenance 행.
        let cdir = central.join("claude/foo");
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(cdir.join("SKILL.md"), "---\nname: foo\n---\nOLD").unwrap();
        upsert_skill_source(
            &pool,
            NewSkillSource {
                provider: "claude",
                name: "foo",
                source_url: "github.com/o/r",
                source_ref: None,
                subpath: None,
                installed_commit: "c1",
            },
        )
        .await
        .unwrap();

        // staging에 새 버전(c2)이 받아져 있고 provenance에 staged 기록됨.
        let sdir = staging.join("claude/foo");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(sdir.join("SKILL.md"), "---\nname: foo\n---\nNEW").unwrap();
        record_update_check(&pool, "claude", "foo", Some("c2"), "2026-06-01T00:00:00Z")
            .await
            .unwrap();

        let skill = apply_update_core(
            &pool,
            &central,
            &staging,
            &backups,
            "claude",
            "foo",
            "20260601T000000Z",
        )
        .await
        .expect("apply");
        assert_eq!(skill.kind, "managed");
        // central이 새 내용으로 교체됨.
        assert_eq!(
            std::fs::read_to_string(central.join("claude/foo/SKILL.md")).unwrap(),
            "---\nname: foo\n---\nNEW"
        );
        // 사전 백업이 이전(OLD) 버전을 보존 → 적용이 가역.
        assert_eq!(
            std::fs::read_to_string(backups.join("20260601T000000Z/claude/foo/SKILL.md")).unwrap(),
            "---\nname: foo\n---\nOLD"
        );
        // commit 승격 + staged 비움.
        let s = get_skill_source(&pool, "claude", "foo")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(s.installed_commit, "c2");
        assert_eq!(s.staged_commit, None);
        // staging 정리됨.
        assert!(!staging.join("claude/foo").exists());
        // update_apply audit 기록.
        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert!(log.iter().any(|e| e.action == "update_apply"));
    }

    #[tokio::test]
    async fn apply_without_staged_errors() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let staging = tmp.path().join("skills-staging");
        let backups = tmp.path().join("skills-backups");
        std::fs::create_dir_all(central.join("claude/foo")).unwrap();
        std::fs::write(central.join("claude/foo/SKILL.md"), "x").unwrap();
        upsert_skill_source(
            &pool,
            NewSkillSource {
                provider: "claude",
                name: "foo",
                source_url: "github.com/o/r",
                source_ref: None,
                subpath: None,
                installed_commit: "c1",
            },
        )
        .await
        .unwrap();

        let err = apply_update_core(
            &pool,
            &central,
            &staging,
            &backups,
            "claude",
            "foo",
            "20260601T010000Z",
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::NotFound); // staged 없음
    }
}
