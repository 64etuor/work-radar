//! 프로젝트 vendored 카피 드리프트 감지(G3-PR2, ADR-0006 #22 부분 — 감지 전용).
//!
//! 프로젝트 스킬 dir(`<repo>/.claude/skills/<name>` 등)이 중앙 managed 카피와 바이트 동일한지
//! 디스크에서 비교한다. **읽기 전용**: 어떤 dir에도 쓰지 않고, 마이그레이션/네트워크/잡 spawn 없음
//! (#1/#2/#7). 적용/해소(복사·pull/push)는 후속 PR. 심링크 멤버는 드리프트 불가라 후보 제외.
//! 경로는 표시·매칭 전용 — 로그 금지(C7).
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::projects::fetch_all_repos;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{DivergenceStatus, Repo, SkillDivergence, SkillProvider};
use crate::skills::central_repo::{central_skill_dir, provider_segment, sanitize_segment};
use crate::skills::scan::{repo_skill_roots, scan_external_skills_core};

/// 트리 비교용 항목 표현(파일 내용 / 심링크 타깃 / 디렉터리 마커). G3-PR2c diff가 두 트리 맵을
/// 비교해 added/removed/changed를 도출 → pub(crate).
#[derive(PartialEq, Eq)]
pub(crate) enum TreeEntry {
    File(Vec<u8>),
    Symlink(PathBuf),
    Dir,
}

/// `root` 아래를 재귀 수집해 (상대경로 → 항목) 맵을 만든다. 심링크는 따라가지 않는다(트리 밖 비교
/// 차단). IO 오류는 None(호출자가 Diverged로 매핑 — 보수적). G3-PR2c diff_core가 재사용 → pub(crate).
pub(crate) fn collect_tree(root: &Path) -> Option<BTreeMap<PathBuf, TreeEntry>> {
    let mut map = BTreeMap::new();
    walk_tree(root, root, &mut map)?;
    Some(map)
}

fn walk_tree(root: &Path, dir: &Path, map: &mut BTreeMap<PathBuf, TreeEntry>) -> Option<()> {
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        let rel = path.strip_prefix(root).ok()?.to_path_buf();
        let ft = entry.file_type().ok()?;
        if ft.is_symlink() {
            map.insert(rel, TreeEntry::Symlink(std::fs::read_link(&path).ok()?));
        } else if ft.is_dir() {
            map.insert(rel, TreeEntry::Dir);
            walk_tree(root, &path, map)?;
        } else if ft.is_file() {
            map.insert(rel, TreeEntry::File(std::fs::read(&path).ok()?));
        }
        // 기타 타입(fifo 등)은 스킬에 없음 — 무시.
    }
    Some(())
}

/// 두 스킬 디렉터리 트리가 동일한지(상대경로 집합 + 파일별 바이트 + 심링크 타깃). 한쪽이라도 읽기
/// 실패면 false(보수적). G3-PR2b vendor의 InSync 안전 게이트가 재사용 → pub(crate).
pub(crate) fn trees_equal(a: &Path, b: &Path) -> bool {
    match (collect_tree(a), collect_tree(b)) {
        (Some(ta), Some(tb)) => ta == tb,
        _ => false,
    }
}

/// 감지 코어 입력 1건 — 명령 레이어가 PR1 스캔 결과에서 도출(IPC 미경계 → Type 불필요).
pub(crate) struct ProjectMember {
    pub repo_id: String,
    pub provider: SkillProvider,
    pub name: String,
    pub member_path: String, // 스킬 SKILL.md 경로(PR1 member_paths 엔트리).
    pub dir_path: PathBuf,   // 비교 대상 스킬 디렉터리(member_path의 부모).
}

/// 코어: 각 프로젝트 멤버가 중앙 managed 카피와 드리프트했는지 판정(앱 핸들 비의존 → hermetic).
/// 심링크 멤버(드리프트 불가) / 중앙 미매칭(managed 아님)은 결과에서 제외한다. infallible.
pub(crate) fn detect_divergence_core(
    central_root: &Path,
    members: &[ProjectMember],
) -> Vec<SkillDivergence> {
    let mut out = Vec::new();
    for m in members {
        // 1. 멤버 dir이 심링크면 vendored 카피 아님 → 제외(부재/접근불가도 제외).
        let Ok(meta) = std::fs::symlink_metadata(&m.dir_path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        // 2. 중앙 managed 매칭? (provider, name) → central dir에 SKILL.md 존재해야 후보.
        let central_dir = central_skill_dir(
            central_root,
            provider_segment(m.provider),
            &sanitize_segment(&m.name),
        );
        if !central_dir.join("SKILL.md").is_file() {
            continue;
        }
        // 3. 트리 비교(읽기 오류 → Diverged, 보수적).
        let status = if trees_equal(&m.dir_path, &central_dir) {
            DivergenceStatus::InSync
        } else {
            DivergenceStatus::Diverged
        };
        out.push(SkillDivergence {
            repo_id: m.repo_id.clone(),
            provider: m.provider,
            name: m.name.clone(),
            member_path: m.member_path.clone(),
            status,
        });
    }
    out
}

/// PR1과 동일한 repo→roots→scan 프리미티브로 프로젝트 멤버를 수집(경로 의미 단일 출처 C6).
/// `repo_skill_roots`가 이미 `Provider::Local && enabled && non-empty local_path` 필터다.
pub(crate) fn collect_project_members(repos: &[Repo]) -> Vec<ProjectMember> {
    let mut out = Vec::new();
    for repo in repos {
        let roots = repo_skill_roots(std::slice::from_ref(repo));
        if roots.is_empty() {
            continue;
        }
        for skill in scan_external_skills_core(&roots) {
            // scan_external_skills_core는 `path = <skill_dir>/SKILL.md` 를 보장(scan.rs) → parent는 항상
            // 존재. 도달 불가한 None은 빈 경로로 방어적 degrade(비교 시 read_dir 실패 → Diverged).
            let dir_path = Path::new(&skill.path)
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
            out.push(ProjectMember {
                repo_id: repo.id.clone(),
                provider: skill.provider,
                name: skill.name,
                member_path: skill.path,
                dir_path,
            });
        }
    }
    out
}

/// 프로젝트 스킬 드리프트 목록(G3-PR2, #22 부분 — 감지 전용). 읽기 전용: 외부 dir 쓰기/네트워크/잡
/// spawn 없음(#1/#2/#7). 레포 DB read 실패는 노출(PR1 list_skill_workspaces와 동일 — 조용한 degrade
/// 금지). 코어는 infallible(건별 보수적).
#[tauri::command]
#[specta::specta]
pub async fn list_skill_divergences(
    db: State<'_, Db>,
    app: tauri::AppHandle,
) -> Result<Vec<SkillDivergence>, AppError> {
    let repos = fetch_all_repos(db.inner()).await.map_err(AppError::from)?;
    let central = crate::skills::apply::central_root(&app)?;
    let members = collect_project_members(&repos);
    Ok(detect_divergence_core(&central, &members))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn trees_equal_true_for_identical_with_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        for root in [&a, &b] {
            write(&root.join("SKILL.md"), "---\nname: x\n---\nbody");
            write(&root.join("sub/extra.txt"), "hello");
        }
        assert!(trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_edited_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "one");
        write(&b.join("SKILL.md"), "two");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_extra_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "same");
        write(&b.join("SKILL.md"), "same");
        write(&b.join("extra.txt"), "x");
        assert!(!trees_equal(&a, &b));
    }

    #[test]
    fn trees_equal_false_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        write(&a.join("SKILL.md"), "same");
        write(&a.join("gone.txt"), "y");
        write(&b.join("SKILL.md"), "same");
        assert!(!trees_equal(&a, &b));
    }

    /// 중앙 managed 스킬 dir 생성(`<central>/<provider>/<name>/SKILL.md` + 본문).
    fn make_central(central: &Path, provider: &str, name: &str, body: &str) -> PathBuf {
        let dir = central.join(provider).join(name);
        write(&dir.join("SKILL.md"), body);
        dir
    }

    fn member(repo: &str, name: &str, dir: &Path) -> ProjectMember {
        ProjectMember {
            repo_id: repo.to_string(),
            provider: SkillProvider::Claude,
            name: name.to_string(),
            member_path: dir.join("SKILL.md").to_string_lossy().into_owned(),
            dir_path: dir.to_path_buf(),
        }
    }

    #[test]
    fn detect_reports_in_sync_for_identical_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "BODY");
        let proj = tmp.path().join("proj/.claude/skills/foo");
        write(&proj.join("SKILL.md"), "BODY");

        let out = detect_divergence_core(&central, &[member("r1", "foo", &proj)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, DivergenceStatus::InSync);
        assert_eq!(out[0].member_path, proj.join("SKILL.md").to_string_lossy());
    }

    #[test]
    fn detect_reports_diverged_for_edited_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        make_central(&central, "claude", "foo", "CENTRAL");
        let proj = tmp.path().join("proj/.claude/skills/foo");
        write(&proj.join("SKILL.md"), "EDITED");

        let out = detect_divergence_core(&central, &[member("r1", "foo", &proj)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, DivergenceStatus::Diverged);
    }

    #[test]
    fn detect_omits_symlinked_member() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let central_dir = make_central(&central, "claude", "foo", "BODY");
        // 프로젝트 멤버가 중앙으로 가는 심링크 → 카피 아님 → 제외.
        let proj_parent = tmp.path().join("proj/.claude/skills");
        std::fs::create_dir_all(&proj_parent).unwrap();
        let link = proj_parent.join("foo");
        std::os::unix::fs::symlink(&central_dir, &link).unwrap();

        let out = detect_divergence_core(&central, &[member("r1", "foo", &link)]);
        assert!(out.is_empty());
    }

    #[test]
    fn detect_omits_member_with_no_central_match() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library"); // 비어 있음
        let proj = tmp.path().join("proj/.claude/skills/orphan");
        write(&proj.join("SKILL.md"), "BODY");

        let out = detect_divergence_core(&central, &[member("r1", "orphan", &proj)]);
        assert!(out.is_empty());
    }

    #[test]
    fn trees_equal_false_when_one_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        write(&a.join("SKILL.md"), "same");
        assert!(!trees_equal(&a, &tmp.path().join("nonexistent")));
    }
}
