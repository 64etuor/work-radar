//! P1.5 바운디드 재귀(깊이) 테스트 (원본 tests.rs 527–670번 라인 이동).
use super::*;

/// 재귀(P1.5 깊이): 중첩 카테고리 스킬을 발견하고, 리프 규칙으로 스킬 dir 하위는 하강하지 않는다.
#[test]
fn scan_recursive_finds_nested_and_leaf_rule_stops_descent() {
    let root = TempDir::new().unwrap();
    // 평면 스킬(depth1).
    make_skill(root.path(), "flat-skill", "---\nname: flat\n---\n");
    // 카테고리 중첩 스킬(depth2): <root>/cat/nested/SKILL.md.
    make_skill(
        &root.path().join("cat"),
        "nested",
        "---\nname: nested\n---\n",
    );
    // 리프 규칙: 스킬 dir 안에 또 SKILL.md가 있어도 그 하위는 안 본다(이중 카운트 방지).
    make_skill(
        &root.path().join("flat-skill"),
        "inner",
        "---\nname: inner\n---\n",
    );

    let roots = vec![SkillRoot::recursive(
        SkillProvider::Claude,
        root.path().to_path_buf(),
        4,
    )];
    let out = scan_external_skills_core(&roots);
    let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"flat"), "평면 스킬 발견");
    assert!(names.contains(&"nested"), "중첩 스킬 재귀 발견");
    assert!(
        !names.contains(&"inner"),
        "리프 규칙: 스킬 dir 하위는 미하강"
    );
    assert_eq!(out.len(), 2);
}

/// 재귀 안전: ignore 디렉터리(node_modules/숨김)는 스킵하고 `max_depth`를 초과하면 하강하지 않는다.
#[test]
fn scan_recursive_skips_ignored_dirs_and_respects_depth_cap() {
    let root = TempDir::new().unwrap();
    // ignore 대상: node_modules / 숨김 dir 안의 스킬은 무시.
    make_skill(
        &root.path().join("node_modules"),
        "junk",
        "---\nname: junk\n---\n",
    );
    make_skill(&root.path().join(".hidden"), "hid", "---\nname: hid\n---\n");
    // depth cap: max_depth=2면 depth3 스킬(<root>/a/b/deep)은 미발견.
    make_skill(
        &root.path().join("a").join("b"),
        "deep",
        "---\nname: deep\n---\n",
    );
    // depth2 스킬은 발견.
    make_skill(&root.path().join("c"), "ok2", "---\nname: ok2\n---\n");

    let roots = vec![SkillRoot::recursive(
        SkillProvider::Claude,
        root.path().to_path_buf(),
        2,
    )];
    let out = scan_external_skills_core(&roots);
    let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"ok2"), "depth2(=max) 스킬 발견");
    assert!(!names.contains(&"deep"), "depth3 > max_depth 미발견");
    assert!(!names.contains(&"junk"), "node_modules 무시");
    assert!(!names.contains(&"hid"), "숨김 dir 무시");
    assert_eq!(out.len(), 1);
}

/// 비재귀 루트는 중첩을 발견하지 않는다(P0 동작 회귀 보호).
#[test]
fn scan_non_recursive_ignores_nested() {
    let root = TempDir::new().unwrap();
    make_skill(root.path(), "top", "---\nname: top\n---\n");
    make_skill(
        &root.path().join("cat"),
        "nested",
        "---\nname: nested\n---\n",
    );

    let roots = vec![SkillRoot::flat(
        SkillProvider::Claude,
        root.path().to_path_buf(),
    )];
    let out = scan_external_skills_core(&roots);
    let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"top"));
    assert!(
        !names.contains(&"nested"),
        "비재귀 루트는 중첩 미발견(P0 동작)"
    );
}

/// 심링크 사이클(조상으로 되돌아가는 심링크)이 있어도 무한 루프 없이 종료하고 실제 스킬은 발견한다.
#[cfg(unix)]
#[test]
fn scan_recursive_symlink_cycle_does_not_loop() {
    let root = TempDir::new().unwrap();
    make_skill(&root.path().join("cat"), "real", "---\nname: real\n---\n");
    // 사이클: <root>/cat/loop -> <root>(조상).
    std::os::unix::fs::symlink(root.path(), root.path().join("cat").join("loop")).unwrap();

    let roots = vec![SkillRoot::recursive(
        SkillProvider::Claude,
        root.path().to_path_buf(),
        4,
    )];
    let out = scan_external_skills_core(&roots);
    assert!(
        out.iter().any(|s| s.name == "real"),
        "실제 스킬 발견(무한 루프 없음)"
    );
}

/// 루트 resolution(P1.5): Hermes 재귀 루트가 포함되고, 도구 루트도 재귀이며, skm 자체 스토어는 제외.
#[test]
fn resolve_includes_hermes_recursive_and_excludes_skills_manager() {
    let home = TempDir::new().unwrap();
    let env = SkillRootEnv {
        home: Some(home.path().to_path_buf()),
        claude_config_dir: None,
        codex_home: None,
        xdg_config_home: None,
    };
    let roots = resolve_skill_roots(&env);

    let hermes = roots
        .iter()
        .find(|r| r.provider == SkillProvider::Hermes)
        .expect("Hermes 루트 존재");
    assert_eq!(hermes.path, home.path().join(".hermes").join("skills"));
    assert!(hermes.recursive, "Hermes는 재귀");
    // 도구 루트도 P1.5에서 전부 재귀.
    assert!(roots.iter().all(|r| r.recursive), "모든 루트 재귀");
    // skm 자체 스토어는 ROOTS에서 제외(대량 중복 방지 — Phase 1.5 #6).
    assert!(
        roots
            .iter()
            .all(|r| !r.path.to_string_lossy().contains(".skills-manager")),
        "skm 스토어 제외"
    );
}
