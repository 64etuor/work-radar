//! P1.5 #4 레포-로컬 루트 + P1.5 #3 사용자 설정 루트 테스트 (원본 tests.rs 748–939번 라인 이동).
use super::*;

/// 테스트용 Repo 빌더(필드 전부 채움 — dummy 메타).
pub(super) fn make_repo(provider: Provider, local_path: Option<&str>, enabled: bool) -> Repo {
    Repo {
        id: "repo-id".into(),
        project_id: "proj-id".into(),
        provider,
        remote_url: None,
        local_path: local_path.map(str::to_string),
        default_branch: "main".into(),
        enabled,
        created_at: "2026-05-30T00:00:00Z".into(),
    }
}

/// 레포-로컬 합성: enabled Local 레포만 3루트(provider 매핑+recursive), Github/비활성/빈경로 제외.
#[test]
fn repo_skill_roots_synthesizes_local_excludes_github_disabled_empty() {
    let base = "/tmp/my-repo";
    let repos = vec![
        // (a) enabled Local → 3 roots.
        make_repo(Provider::Local, Some(base), true),
        // (b) Github → 0 roots(remote-only).
        make_repo(Provider::Github, Some("/tmp/gh-repo"), true),
        // (c) disabled Local → 0 roots.
        make_repo(Provider::Local, Some("/tmp/disabled"), false),
        // (d) 빈/공백/None local_path → 0 roots.
        make_repo(Provider::Local, Some("  "), true),
        make_repo(Provider::Local, None, true),
    ];
    let roots = repo_skill_roots(&repos);
    assert_eq!(roots.len(), 3, "enabled Local 레포 하나만 3루트 합성");

    let basep = PathBuf::from(base);
    let by_path = |sub: &str| {
        roots
            .iter()
            .find(|r| r.path == basep.join(sub))
            .unwrap_or_else(|| panic!("루트 {sub} 없음"))
    };
    let claude = by_path(".claude/skills");
    assert_eq!(claude.provider, SkillProvider::Claude);
    let codex = by_path(".codex/skills");
    assert_eq!(codex.provider, SkillProvider::Codex);
    let agents = by_path(".agents/skills");
    assert_eq!(
        agents.provider,
        SkillProvider::Codex,
        ".agents는 Codex 태깅"
    );

    for r in &roots {
        assert!(r.recursive, "레포 루트는 재귀");
        assert_eq!(
            r.max_depth, RECURSIVE_MAX_DEPTH,
            "depth cap = 글로벌과 동일"
        );
    }
}

/// 레포 루트 재귀 스캔: 중첩 스킬 발견 + node_modules 무시(거대 트리 방어).
#[test]
fn repo_root_recursive_finds_nested_and_ignores_node_modules() {
    let base = TempDir::new().unwrap();
    // 중첩 스킬: <base>/.claude/skills/<cat>/<skill>/SKILL.md
    let nested = base.path().join(".claude/skills/cat/my-skill");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("SKILL.md"), "---\nname: nested-repo\n---\n").unwrap();
    // 디코이: node_modules 하위(무시 대상).
    let decoy = base.path().join(".claude/skills/node_modules/x");
    std::fs::create_dir_all(&decoy).unwrap();
    std::fs::write(decoy.join("SKILL.md"), "---\nname: decoy\n---\n").unwrap();

    let local = make_repo(Provider::Local, base.path().to_str(), true);
    let out = scan_external_skills_core(&repo_skill_roots(&[local]));
    let names: Vec<_> = out.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"nested-repo"), "중첩 레포 스킬 발견");
    assert!(!names.contains(&"decoy"), "node_modules는 무시");
}

/// path-guard(C1)가 레포-로컬 스킬 경로를 수용(env 루트와 동일 가드).
#[test]
fn path_guard_accepts_repo_local_skill() {
    let base = TempDir::new().unwrap();
    let local = make_repo(Provider::Local, base.path().to_str(), true);
    let roots = repo_skill_roots(&[local]);

    let ok = base
        .path()
        .join(".claude/skills/foo/SKILL.md")
        .to_string_lossy()
        .into_owned();
    assert!(
        ensure_within_skills_dir_roots(&ok, &roots).is_ok(),
        "레포-로컬 스킬 경로 수용"
    );
    // 레포 루트 밖은 거부.
    assert!(
        ensure_within_skills_dir_roots("/etc/passwd", &roots).is_err(),
        "루트 밖 경로 거부"
    );
}

// ── P1.5 #3: 사용자 설정 임의 루트 테스트 ──

/// get은 미설정 시 빈 vec, set 후 round-trip(dedup 포함).
#[tokio::test]
async fn user_roots_get_empty_then_roundtrips() {
    let db = fresh_db().await;
    // 미설정 → 빈 vec.
    assert!(
        read_user_skill_roots(&db).await.unwrap().is_empty(),
        "미설정이면 빈 vec"
    );

    // set(중복 포함) → dedup된 round-trip.
    set_user_roots_core(
        &db,
        vec![root("/abs/one"), root("/abs/two"), root("/abs/one")],
    )
    .await
    .unwrap();
    let got = read_user_skill_roots(&db).await.unwrap();
    let paths: Vec<_> = got.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths, vec!["/abs/one", "/abs/two"], "dedup된 round-trip");
}

/// set은 상대 경로를 거부한다(path-guard가 의미 있으려면 절대 필요).
#[tokio::test]
async fn user_roots_set_rejects_relative_path() {
    let db = fresh_db().await;
    let err = set_user_roots_core(&db, vec![root("relative/skills")]).await;
    assert!(err.is_err(), "상대 경로는 거부");
    // 거부 시 아무것도 영속되지 않았다(여전히 빈 vec).
    assert!(read_user_skill_roots(&db).await.unwrap().is_empty());
}

/// 사용자 루트가 `skill_roots_db` 집계에 provider=Other로 포함되고, 스캔이 그 안의 중첩 스킬을
/// 재귀로 발견한다(env 루트와 동일 메커니즘). path-guard(C1)도 그 루트를 자동 수용한다.
#[tokio::test]
async fn user_root_aggregated_as_other_and_scanned() {
    let db = fresh_db().await;
    let dir = TempDir::new().unwrap();
    // <root>/<cat>/<skill>/SKILL.md (중첩 — 재귀 발견 대상).
    let nested = dir.path().join("cat/my-user-skill");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("SKILL.md"), "---\nname: user-skill\n---\n").unwrap();

    let abs = dir.path().to_string_lossy().into_owned();
    set_user_roots_core(&db, vec![root(&abs)]).await.unwrap();

    // 집계 ROOTS에 provider=Other인 사용자 루트가 포함된다.
    let roots = skill_roots_db(&db).await;
    let user = roots
        .iter()
        .find(|r| r.path == dir.path())
        .expect("사용자 루트가 집계에 포함");
    assert_eq!(user.provider, SkillProvider::Other, "provider=Other 합성");
    assert!(user.recursive, "사용자 루트는 재귀");

    // 스캔이 중첩 사용자 스킬을 발견한다(provider=Other 태깅).
    let scanned = scan_external_skills_core(&roots);
    let found = scanned
        .iter()
        .find(|s| s.name == "user-skill")
        .expect("중첩 사용자 스킬 발견");
    assert_eq!(found.provider, SkillProvider::Other);

    // path-guard(C1)가 그 루트 하위 SKILL.md를 자동 수용한다(별도 주입 없이 슬라이스로).
    let skill_md = nested.join("SKILL.md").to_string_lossy().into_owned();
    assert!(
        ensure_within_skills_dir_roots(&skill_md, &roots).is_ok(),
        "사용자 루트 하위 경로 수용"
    );
}
