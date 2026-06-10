//! G3-PR1 프로젝트 워크스페이스 집계 테스트 (원본 tests.rs 1434–1527번 라인 이동).
use super::roots::make_repo;
use super::*;

/// tempdir 레포에 `<base>/.claude/skills/<name>/SKILL.md`를 만든다(hermetic).
fn seed_repo_skill(base: &std::path::Path, sub: &str, name: &str) {
    let d = base.join(sub).join(name);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
}

/// 집계 정확: 2개 레포의 스킬을 워크스페이스로 묶고 member_paths/skill_count가 맞다.
#[test]
fn workspaces_aggregate_per_repo() {
    let a = TempDir::new().unwrap();
    seed_repo_skill(a.path(), ".claude/skills", "ax");
    seed_repo_skill(a.path(), ".codex/skills", "ay");
    let b = TempDir::new().unwrap();
    seed_repo_skill(b.path(), ".claude/skills", "bz");

    let repos = vec![
        make_repo(Provider::Local, a.path().to_str(), true),
        make_repo(Provider::Local, b.path().to_str(), true),
    ];
    let out = list_skill_workspaces_core(&repos);
    assert_eq!(out.len(), 2, "스킬 있는 enabled Local 레포 2개");

    let wa = out
        .iter()
        .find(|w| w.root_path == a.path().to_string_lossy())
        .unwrap();
    assert_eq!(wa.skill_count, 2, "레포A는 claude+codex 2개");
    assert_eq!(wa.member_paths.len(), 2);
    assert!(
        wa.member_paths
            .iter()
            .all(|p| p.starts_with(a.path().to_str().unwrap())),
        "member_paths는 레포A 하위 절대경로"
    );

    let wb = out
        .iter()
        .find(|w| w.root_path == b.path().to_string_lossy())
        .unwrap();
    assert_eq!(wb.skill_count, 1);
}

/// 필터 술어: Github·비활성·빈 경로 레포는 워크스페이스 대상 아님.
#[test]
fn workspaces_exclude_github_disabled_empty() {
    let a = TempDir::new().unwrap();
    seed_repo_skill(a.path(), ".claude/skills", "live");
    let repos = vec![
        make_repo(Provider::Local, a.path().to_str(), true), // 포함
        make_repo(Provider::Github, a.path().to_str(), true), // remote-only 제외
        make_repo(Provider::Local, a.path().to_str(), false), // 비활성 제외
        make_repo(Provider::Local, Some("  "), true),        // 빈 경로 제외
        make_repo(Provider::Local, None, true),              // None 제외
    ];
    let out = list_skill_workspaces_core(&repos);
    assert_eq!(out.len(), 1, "enabled Local + 스킬 있는 레포만");
}

/// 0-스킬 enabled Local 레포(스킬 dir 없음/부재 경로 포함)도 vendor 타깃으로 워크스페이스에 포함된다
/// (G3 fast-follow: 등록만 하고 스킬이 아직 없는 프로젝트로 첫 스킬을 vendor 할 수 있게). skill_count=0·
/// member_paths 빈 채 노출 — 패닉 없이 graceful.
#[test]
fn workspaces_include_zero_skill_repos_as_vendor_targets() {
    let empty = TempDir::new().unwrap(); // 스킬 dir 없음
    let repos = vec![
        make_repo(Provider::Local, empty.path().to_str(), true),
        make_repo(Provider::Local, Some("/no/such/path/xyz"), true), // 부재 경로 → 스캔 빈 결과
    ];
    let out = list_skill_workspaces_core(&repos);
    assert_eq!(
        out.len(),
        2,
        "0-스킬 enabled Local 레포도 포함(vendor 타깃)"
    );
    assert!(
        out.iter()
            .all(|w| w.skill_count == 0 && w.member_paths.is_empty()),
        "스킬 0개 → skill_count=0·member_paths 빈 채 노출"
    );
}

/// label = local_path basename. basename 추출 불가 시 전체 경로로 폴백.
#[test]
fn workspace_label_is_basename() {
    let base = TempDir::new().unwrap();
    seed_repo_skill(base.path(), ".claude/skills", "s");
    let repos = vec![make_repo(Provider::Local, base.path().to_str(), true)];
    let out = list_skill_workspaces_core(&repos);
    let expected = base.path().file_name().unwrap().to_str().unwrap();
    assert_eq!(out[0].label, expected, "label은 경로 마지막 세그먼트");
}
