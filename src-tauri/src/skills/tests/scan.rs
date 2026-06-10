//! 스캔·경로가드·list·seed·CRUD 테스트 (원본 tests.rs 1–526번 라인 이동).
use super::*;

/// 멀티루트 스캔: 루트별 provider 분류 + frontmatter(name/description) 파싱 + 부재 루트 graceful +
/// 이름 정렬. (`.agents`는 Codex 태깅과 동일한 provider 매핑을 ROOTS가 책임지므로 여기선 직접 주입.)
#[test]
fn scan_tags_provider_parses_frontmatter_and_skips_absent_root() {
    let claude = TempDir::new().unwrap();
    let codex = TempDir::new().unwrap();
    make_skill(
        claude.path(),
        "alpha",
        "---\nname: alpha\ndescription: \"클로드 스킬 A\"\n---\n# 본문\n",
    );
    make_skill(
        claude.path(),
        "beta",
        "---\nname: beta\ndescription: B\n---\n",
    );
    make_skill(
        codex.path(),
        "gamma",
        "---\nname: gamma\ndescription: G\n---\n",
    );
    // 존재하지 않는 openclaw 루트 — per-root skip(무에러).
    let absent = codex.path().join("nope");

    let roots = vec![
        SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Openclaw, absent),
    ];
    let out = scan_external_skills_core(&roots);

    // 부재 루트 스킵 → 3건, 이름 오름차순 정렬.
    assert_eq!(
        out.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["alpha", "beta", "gamma"],
    );
    let by = |n: &str| out.iter().find(|s| s.name == n).unwrap();
    assert_eq!(by("alpha").provider, SkillProvider::Claude);
    assert_eq!(by("alpha").description, "클로드 스킬 A");
    assert_eq!(by("beta").provider, SkillProvider::Claude);
    assert_eq!(by("gamma").provider, SkillProvider::Codex);
    assert_eq!(by("gamma").description, "G");
}

/// 부분실패(C6): 읽기 가능 루트 + 읽기 불가 루트(파일=read_dir 실패) → 가능분만 반환·무에러.
#[test]
fn scan_skips_unreadable_root_returns_rest() {
    let good = TempDir::new().unwrap();
    make_skill(good.path(), "alpha", "---\nname: alpha\n---\n");
    // 루트 경로가 디렉터리가 아니라 파일이면 read_dir 실패 → 스킵.
    let file_root = good.path().join("not-a-dir");
    std::fs::write(&file_root, "x").unwrap();

    let roots = vec![
        SkillRoot::flat(SkillProvider::Claude, good.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Codex, file_root),
    ];
    let out = scan_external_skills_core(&roots);
    assert_eq!(out.len(), 1, "읽기 불가 루트는 스킵하고 가능분만 반환");
    assert_eq!(out[0].name, "alpha");
    assert_eq!(out[0].provider, SkillProvider::Claude);
}

/// 심링크로 설치된 스킬 dir도 발견한다(`is_dir() || is_symlink()`).
#[cfg(unix)]
#[test]
fn scan_discovers_symlinked_skill_dir() {
    let target = TempDir::new().unwrap();
    let real = target.path().join("real-skill");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(
        real.join("SKILL.md"),
        "---\nname: linked\ndescription: L\n---\n",
    )
    .unwrap();

    let root = TempDir::new().unwrap();
    std::os::unix::fs::symlink(&real, root.path().join("linked-skill")).unwrap();

    let roots = vec![SkillRoot::flat(
        SkillProvider::Claude,
        root.path().to_path_buf(),
    )];
    let out = scan_external_skills_core(&roots);
    assert_eq!(out.len(), 1, "심링크된 스킬 dir을 발견해야 함");
    assert_eq!(out[0].name, "linked");
    assert_eq!(out[0].provider, SkillProvider::Claude);
}

/// 빈 ROOTS는 빈 결과(HOME 없음 graceful).
#[test]
fn scan_empty_roots_is_empty() {
    assert!(scan_external_skills_core(&[]).is_empty());
}

/// path-guard 루트별(C1): in-root 허용(각 루트) / `<root>/../../tmp/SKILL.md` 거부 / 전 루트 밖 거부 /
/// 非SKILL.md 거부 / 빈 roots는 모든 경로 거부.
#[test]
fn path_guard_per_root() {
    let claude = TempDir::new().unwrap();
    let codex = TempDir::new().unwrap();
    let roots = vec![
        SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
    ];
    let g = |p: &str| ensure_within_skills_dir_roots(p, &roots);

    // in-root 허용(두 루트 각각).
    let ok_claude = claude.path().join("s").join("SKILL.md");
    assert!(g(ok_claude.to_str().unwrap()).is_ok());
    let ok_codex = codex.path().join("s").join("SKILL.md");
    assert!(g(ok_codex.to_str().unwrap()).is_ok());

    // `<root>/../../tmp/SKILL.md` 거부(.. 탈출).
    let escape = claude
        .path()
        .join("..")
        .join("..")
        .join("tmp")
        .join("SKILL.md");
    assert!(
        g(escape.to_str().unwrap()).is_err(),
        "prefix 공유 traversal 거부"
    );

    // 전 루트 밖 거부 + 非SKILL.md 거부.
    assert!(g("/etc/passwd").is_err());
    let not_skill = claude.path().join("s").join("notes.md");
    assert!(g(not_skill.to_str().unwrap()).is_err());

    // roots 비면 모든 경로 거부(HOME 없음 안전).
    assert!(ensure_within_skills_dir_roots(ok_claude.to_str().unwrap(), &[]).is_err());
}

/// #19 회귀 잠금: 외부 편집 경로 가드가 **사용자 설정 루트**(P1.5 위치-축 안전망)로 확장돼도 탈출을
/// 막는다. `write/read_external_skill`은 `skill_roots_db`(env+repo+user 합성)를 소비하고, 사용자 루트는
/// `user_skill_roots`로 `SkillRoot`가 된다 — 그 변환 결과로 가드를 잠가 다중 루트 추가가 탈출을 열지
/// 않음을 증명한다(repo-local 가드 테스트와 동일 방식 — env 비의존 hermetic).
#[test]
fn path_guard_locks_user_configured_root() {
    let user_dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let roots = user_skill_roots(&[UserSkillRoot {
        path: user_dir.path().to_string_lossy().into_owned(),
    }]);
    assert_eq!(roots.len(), 1, "사용자 루트 1개가 SkillRoot로 변환");
    let g = |p: &str| ensure_within_skills_dir_roots(p, &roots);

    // 사용자 루트 안의 SKILL.md는 허용(자기 파일 편집).
    let ok = user_dir.path().join("my-skill").join("SKILL.md");
    assert!(
        g(ok.to_str().unwrap()).is_ok(),
        "사용자 루트 안 SKILL.md 허용"
    );
    // 사용자 루트 **밖**은 거부(다중 루트여도 탈출 차단 — done-criteria #2).
    let bad = outside.path().join("evil").join("SKILL.md");
    assert!(g(bad.to_str().unwrap()).is_err(), "사용자 루트 밖 거부");
    // `..` traversal은 사용자 루트 접두를 공유해도 거부.
    let escape = user_dir.path().join("..").join("evil").join("SKILL.md");
    assert!(g(escape.to_str().unwrap()).is_err(), ".. 탈출 거부");
    // 非 SKILL.md 거부(임의 파일 쓰기 차단).
    let not_skill = user_dir.path().join("x").join("notes.md");
    assert!(g(not_skill.to_str().unwrap()).is_err(), "SKILL.md만 허용");
}

/// 통합: `list_skills_core` = 인앱(DB) + 멀티루트 외부 병합, 외부 행에 provider, 인앱 행은 provider=None.
#[tokio::test]
async fn list_skills_core_merges_in_app_and_external_with_provider() {
    let db = fresh_db().await;
    seed_in_app_skills(&db).await.unwrap();

    let claude = TempDir::new().unwrap();
    let codex = TempDir::new().unwrap();
    make_skill(
        claude.path(),
        "alpha",
        "---\nname: alpha\ndescription: A\n---\n",
    );
    make_skill(
        codex.path(),
        "gamma",
        "---\nname: gamma\ndescription: G\n---\n",
    );
    let roots = vec![
        SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
    ];

    let all = list_skills_core(&db, &roots).await.unwrap();
    let in_app: Vec<_> = all.iter().filter(|s| s.kind == "in_app_prompt").collect();
    let external: Vec<_> = all.iter().filter(|s| s.kind == "external").collect();

    assert_eq!(in_app.len(), seed_defs().len(), "인앱 시드 전부 병합");
    assert!(
        in_app.iter().all(|s| s.provider.is_none()),
        "인앱 행은 provider=None"
    );

    assert_eq!(external.len(), 2, "외부 두 루트 병합");
    let ext = |n: &str| external.iter().find(|s| s.name == n).unwrap();
    assert_eq!(ext("alpha").provider, Some(SkillProvider::Claude));
    assert_eq!(ext("gamma").provider, Some(SkillProvider::Codex));
    assert!(ext("alpha").id.starts_with("ext:"));
}

/// #18: 시드된 binding의 in_app 행은 코드 상수(fallback_prompt)를 합성하고, 외부 행은 None.
/// 사용자가 prompt를 편집해도 fallback_prompt는 코드 상수를 유지(diff/복원의 기준).
#[tokio::test]
async fn list_skills_core_populates_fallback_prompt_for_seeded_in_app() {
    let db = fresh_db().await;
    seed_in_app_skills(&db).await.unwrap();
    // 한 시드 행의 prompt를 편집 — fallback_prompt는 그대로 코드 상수여야 한다.
    sqlx::query("UPDATE skills SET prompt='편집된 내용' WHERE binding=?1")
        .bind(BINDING_BATCH_ENRICH)
        .execute(&db)
        .await
        .unwrap();

    let claude = TempDir::new().unwrap();
    make_skill(
        claude.path(),
        "alpha",
        "---\nname: alpha\ndescription: A\n---\n",
    );
    let roots = vec![SkillRoot::flat(
        SkillProvider::Claude,
        claude.path().to_path_buf(),
    )];

    let all = list_skills_core(&db, &roots).await.unwrap();
    let edited = all
        .iter()
        .find(|s| s.binding.as_deref() == Some(BINDING_BATCH_ENRICH))
        .unwrap();
    assert_eq!(edited.prompt.as_deref(), Some("편집된 내용"), "편집 반영");
    assert_eq!(
        edited.fallback_prompt.as_deref(),
        fallback_prompt(BINDING_BATCH_ENRICH),
        "fallback_prompt = 코드 상수(편집과 무관)"
    );
    // 모든 시드 in_app 행이 fallback_prompt를 가진다.
    assert!(
        all.iter()
            .filter(|s| s.kind == "in_app_prompt")
            .all(|s| s.fallback_prompt.is_some()),
        "시드 in_app 행 전부 fallback_prompt 보유"
    );
    // 외부 행은 fallback_prompt 없음(diff 비대상).
    assert!(
        all.iter()
            .filter(|s| s.kind == "external")
            .all(|s| s.fallback_prompt.is_none()),
        "외부 행은 fallback_prompt=None"
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
    let (p,): (String,) = sqlx::query_as("SELECT prompt FROM skills WHERE binding='batch_enrich'")
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
    let (n2,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM skills WHERE kind='in_app_prompt'")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(n2, seed_defs().len() as i64, "재시드 멱등 — 행 수 불변");
    let (p2,): (String,) = sqlx::query_as("SELECT prompt FROM skills WHERE binding='batch_enrich'")
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

/// 루트 resolution(C6 단일 출처, P1): 명시 override env가 최우선(존재 무관). override 없는 도구는
/// dotfile 폴백. HOME 미설정이면 빈 목록.
#[test]
fn resolve_explicit_override_wins_else_dotfile() {
    let codex = TempDir::new().unwrap();
    let home = TempDir::new().unwrap();
    let env = SkillRootEnv {
        home: Some(home.path().to_path_buf()),
        claude_config_dir: None,
        codex_home: Some(codex.path().to_path_buf()),
        xdg_config_home: None,
    };
    let roots = resolve_skill_roots(&env);
    // CODEX_HOME set → `<CODEX_HOME>/skills`(존재 무관, 첫 Codex 루트).
    let codex_root = roots
        .iter()
        .find(|r| r.provider == SkillProvider::Codex)
        .unwrap();
    assert_eq!(codex_root.path, codex.path().join("skills"));
    // claude override 없음 → dotfile 폴백.
    let claude_root = roots
        .iter()
        .find(|r| r.provider == SkillProvider::Claude)
        .unwrap();
    assert_eq!(claude_root.path, home.path().join(".claude").join("skills"));
}

/// XDG 후보는 **존재할 때만** 채택(미존재 XDG는 dotfile 폴백 — Linux XDG 상존이 dotfile을 가로채지
/// 않도록 존재 게이트).
#[test]
fn resolve_uses_existing_xdg_then_dotfile_fallback() {
    let xdg = TempDir::new().unwrap();
    let home = TempDir::new().unwrap();
    // XDG codex/skills 존재 → 채택. claude는 XDG 후보 미존재 → dotfile.
    std::fs::create_dir_all(xdg.path().join("codex").join("skills")).unwrap();
    let env = SkillRootEnv {
        home: Some(home.path().to_path_buf()),
        claude_config_dir: None,
        codex_home: None,
        xdg_config_home: Some(xdg.path().to_path_buf()),
    };
    let roots = resolve_skill_roots(&env);
    let codex_root = roots
        .iter()
        .find(|r| r.provider == SkillProvider::Codex)
        .unwrap();
    assert_eq!(codex_root.path, xdg.path().join("codex").join("skills"));
    let claude_root = roots
        .iter()
        .find(|r| r.provider == SkillProvider::Claude)
        .unwrap();
    assert_eq!(claude_root.path, home.path().join(".claude").join("skills"));
}

/// HOME 미설정 → 빈 목록(graceful: 스캔 0건, 가드 전부 거부).
#[test]
fn resolve_no_home_is_empty() {
    let env = SkillRootEnv {
        home: None,
        claude_config_dir: None,
        codex_home: None,
        xdg_config_home: None,
    };
    assert!(resolve_skill_roots(&env).is_empty());
}

/// detect: provider별 집계(Codex=`.codex`+`.agents` 합산) + present(부재 루트 false) + 주 루트 root_path
/// + provider 출현 순서 보존.
#[test]
fn detect_aggregates_per_provider_present_and_counts() {
    let claude = TempDir::new().unwrap();
    let codex = TempDir::new().unwrap();
    let agents = TempDir::new().unwrap();
    make_skill(claude.path(), "a", "---\nname: a\n---\n");
    make_skill(codex.path(), "b", "---\nname: b\n---\n");
    make_skill(agents.path(), "c", "---\nname: c\n---\n");
    let absent = codex.path().join("nope-openclaw");

    let roots = vec![
        SkillRoot::flat(SkillProvider::Claude, claude.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Codex, codex.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Codex, agents.path().to_path_buf()),
        SkillRoot::flat(SkillProvider::Openclaw, absent),
    ];
    let envs = detect_skill_environments_core(&roots);

    // provider 출현 순서 보존 + Codex 한 줄로 집계.
    assert_eq!(
        envs.iter().map(|e| e.provider).collect::<Vec<_>>(),
        vec![
            SkillProvider::Claude,
            SkillProvider::Codex,
            SkillProvider::Openclaw
        ],
    );
    let by = |p: SkillProvider| envs.iter().find(|e| e.provider == p).unwrap();
    assert_eq!(by(SkillProvider::Claude).skill_count, 1);
    assert_eq!(
        by(SkillProvider::Codex).skill_count,
        2,
        ".codex + .agents 합산"
    );
    assert!(by(SkillProvider::Claude).present);
    assert!(by(SkillProvider::Codex).present);
    assert!(
        !by(SkillProvider::Openclaw).present,
        "부재 루트 → present=false"
    );
    // root_path = 주 루트(첫 Codex = `.codex` 대응).
    assert_eq!(
        by(SkillProvider::Codex).root_path,
        codex.path().to_string_lossy().into_owned(),
    );
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
