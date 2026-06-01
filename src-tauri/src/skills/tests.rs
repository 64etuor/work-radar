//! 스킬 모듈 테스트(G1-PR1 분할). 분할 전 `commands/skills.rs`의 `#[cfg(test)] mod tests`를 그대로
//! 옮겼다(테스트 0건 손실·무행동변경 증명). `use super::*` 대신 분할된 형제 모듈에서 명시 import 한다.
#![cfg(test)]

use crate::commands::agents::BATCH_ENRICH_PROMPT;
use crate::commands::nav::set_config;
use crate::commands::shared::test_support::fresh_db;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{Provider, Repo, Skill, SkillProvider, UserSkillRoot};
use crate::skills::registry::*;
use crate::skills::scan::*;
use crate::skills::seed::*;
use crate::skills::tags::*;
use std::path::PathBuf;
use tempfile::TempDir;

/// tempdir 루트에 `<root>/<dir>/SKILL.md`를 frontmatter와 함께 만든다(hermetic 헬퍼).
fn make_skill(root: &std::path::Path, dir: &str, frontmatter: &str) {
    let d = root.join(dir);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("SKILL.md"), frontmatter).unwrap();
}

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

// ── P1.5: 바운디드 재귀(깊이) ──────────────────────────────────────────────────────

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

// ── 테스트 코어(State 래퍼 없이 직접 호출) ──
async fn create_skill_core(
    db: &Db,
    name: &str,
    prompt: &str,
    binding: Option<&str>,
) -> Result<Skill, String> {
    if let Some(b) = binding {
        if fallback_prompt(b).is_none() {
            return Err(format!("알 수 없는 binding '{b}'"));
        }
    }
    let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query_as::<_, Skill>(
        "INSERT INTO skills (id, name, kind, prompt, binding, rail, enabled) \
         VALUES (?1, ?2, 'in_app_prompt', ?3, ?4, 'suggestion', 1) \
         RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
    )
    .bind(&id.0)
    .bind(name)
    .bind(prompt)
    .bind(binding)
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())
}

async fn update_skill_core(
    db: &Db,
    id: &str,
    prompt: Option<&str>,
    name: Option<&str>,
    enabled: Option<bool>,
) -> Result<Skill, String> {
    if id.starts_with("ext:") {
        return Err("외부 스킬은 수정 불가".into());
    }
    sqlx::query_as::<_, Skill>(
        "UPDATE skills SET prompt = COALESCE(?2, prompt), name = COALESCE(?3, name), \
            enabled = COALESCE(?4, enabled), updated_at = datetime('now') \
         WHERE id = ?1 AND kind = 'in_app_prompt' \
         RETURNING id, name, kind, prompt, binding, rail, enabled, model, reasoning_effort, fast_mode, source_path, created_at, updated_at",
    )
    .bind(id)
    .bind(prompt)
    .bind(name)
    .bind(enabled)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "없음".to_string())
}

async fn delete_skill_core(db: &Db, id: &str) -> Result<(), String> {
    if id.starts_with("ext:") {
        return Err("외부 스킬은 삭제 불가".into());
    }
    let res = sqlx::query("DELETE FROM skills WHERE id = ?1 AND kind = 'in_app_prompt'")
        .bind(id)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    if res.rows_affected() == 0 {
        return Err("없음".into());
    }
    // 명령 경로와 동일하게 태그도 정리(orphan 방지).
    let _ = sqlx::query("DELETE FROM skill_tags WHERE skill_key = ?1")
        .bind(id)
        .execute(db)
        .await;
    Ok(())
}

// ── P1.5 #4: 레포-로컬 루트(DB-aware) 테스트 ──

/// 테스트용 Repo 빌더(필드 전부 채움 — dummy 메타).
fn make_repo(provider: Provider, local_path: Option<&str>, enabled: bool) -> Repo {
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

/// 커맨드 본문과 동일 경로(normalize → serialize → set_config)로 영속하는 테스트 헬퍼(State 없이).
async fn set_user_roots_core(db: &Db, roots: Vec<UserSkillRoot>) -> Result<(), AppError> {
    let cleaned = normalize_user_skill_roots(roots)?;
    let json = serde_json::to_string(&cleaned).unwrap();
    set_config(db, KEY_USER_SKILL_ROOTS, &json)
        .await
        .map_err(AppError::from)
}

fn root(path: &str) -> UserSkillRoot {
    UserSkillRoot {
        path: path.to_string(),
    }
}

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

// ── Phase 3 #12: 태그 ──────────────────────────────────────────────────────────────

/// set_skill_tags_core: 정규화(trim/빈값 제거/dedup) + replace 의미 + 빈 목록은 전체 제거.
#[tokio::test]
async fn set_skill_tags_normalizes_and_replaces() {
    let db = fresh_db().await;
    let key = "skill_batch_enrich";

    // trim + 빈값 제거 + dedup, 입력 순서 보존.
    set_skill_tags_core(
        &db,
        key,
        vec![" a ".into(), "b".into(), "".into(), "a".into()],
    )
    .await
    .unwrap();
    let got = load_tags_by_key(&db).await;
    assert_eq!(got.get(key).cloned().unwrap_or_default(), vec!["a", "b"]);

    // replace 의미: 다시 set하면 기존을 대체(누적 아님).
    set_skill_tags_core(&db, key, vec!["c".into()])
        .await
        .unwrap();
    let got = load_tags_by_key(&db).await;
    assert_eq!(got.get(key).cloned().unwrap_or_default(), vec!["c"]);

    // 빈 목록 → 전체 제거.
    set_skill_tags_core(&db, key, vec![]).await.unwrap();
    let got = load_tags_by_key(&db).await;
    assert!(!got.contains_key(key), "빈 목록은 키의 태그를 모두 제거");
}

/// set_skill_tags_core: 빈 키 거부, 과도 길이 태그 거부(검증 가드).
#[tokio::test]
async fn set_skill_tags_rejects_bad_input() {
    let db = fresh_db().await;
    assert!(
        set_skill_tags_core(&db, "  ", vec!["x".into()])
            .await
            .is_err(),
        "빈 키 거부"
    );
    let long = "z".repeat(MAX_TAG_LEN + 1);
    assert!(
        set_skill_tags_core(&db, "skill_x", vec![long])
            .await
            .is_err(),
        "과도 길이 태그 거부"
    );
}

/// list_skills_core가 인앱(행 id)·외부(`ext:`+경로) 태그를 둘 다 채운다.
#[tokio::test]
async fn list_skills_core_populates_tags_for_both_kinds() {
    let db = fresh_db().await;
    seed_in_app_skills(&db).await.unwrap();

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

    // 인앱 키 태깅.
    set_skill_tags_core(&db, "skill_batch_enrich", vec!["fav".into()])
        .await
        .unwrap();
    // 외부 키 태깅(= list_skills 합성 id와 동일 규칙).
    let ext_path = claude.path().join("alpha").join("SKILL.md");
    let ext_key = format!("ext:{}", ext_path.to_string_lossy());
    set_skill_tags_core(&db, &ext_key, vec!["util".into()])
        .await
        .unwrap();

    let raw: Vec<(String, String)> = sqlx::query_as("SELECT skill_key, tag FROM skill_tags")
        .fetch_all(&db)
        .await
        .unwrap();
    eprintln!("DBG ext_key={ext_key}");
    eprintln!("DBG raw_rows={raw:?}");
    let all = list_skills_core(&db, &roots).await.unwrap();
    for s in &all {
        eprintln!("DBG skill id={} kind={} tags={:?}", s.id, s.kind, s.tags);
    }
    let in_app = all
        .iter()
        .find(|s| s.binding.as_deref() == Some("batch_enrich"))
        .unwrap();
    assert_eq!(in_app.tags, vec!["fav"], "인앱 태그 채움");
    let external = all.iter().find(|s| s.kind == "external").unwrap();
    assert_eq!(external.tags, vec!["util"], "외부 태그 채움");
}

/// 외부 스킬 태깅은 **로컬 SQLite만** 바꾼다 — 디스크 SKILL.md 파일은 무변경(외부 읽기 전용 #7).
#[tokio::test]
async fn tagging_external_does_not_touch_file() {
    let db = fresh_db().await;
    let claude = TempDir::new().unwrap();
    let content = "---\nname: alpha\ndescription: A\n---\n# 본문\n";
    make_skill(claude.path(), "alpha", content);
    let ext_path = claude.path().join("alpha").join("SKILL.md");
    let ext_key = format!("ext:{}", ext_path.to_string_lossy());

    let before = std::fs::read_to_string(&ext_path).unwrap();
    set_skill_tags_core(&db, &ext_key, vec!["tagged".into()])
        .await
        .unwrap();
    let after = std::fs::read_to_string(&ext_path).unwrap();
    assert_eq!(before, after, "외부 태깅은 디스크 파일을 변경하지 않는다");
    assert_eq!(before, content);
}

/// 인앱 스킬 삭제 시 그 키의 태그도 정리된다(orphan 방지).
#[tokio::test]
async fn delete_in_app_skill_cleans_its_tags() {
    let db = fresh_db().await;
    let s = create_skill_core(&db, "내 템플릿", "지침", None)
        .await
        .unwrap();
    set_skill_tags_core(&db, &s.id, vec!["t1".into()])
        .await
        .unwrap();
    delete_skill_core(&db, &s.id).await.unwrap();
    let got = load_tags_by_key(&db).await;
    assert!(!got.contains_key(&s.id), "삭제된 인앱 스킬의 태그 정리");
}

/// G1-PR3: 외부 스킬을 중앙 라이브러리로 import하면 `list_skills`가 managed 한 건만 노출하고 같은
/// (name, provider)의 발견 외부본은 억제한다(레일 ② — 중앙 복사본이 발견본을 대체).
#[tokio::test]
async fn managed_supersedes_discovered_in_list_skills() {
    let db = fresh_db().await;
    let ext_root = TempDir::new().unwrap();
    let central = TempDir::new().unwrap();
    // 발견 외부 스킬: <ext_root>/foo/SKILL.md (claude 루트로 스캔).
    make_skill(
        ext_root.path(),
        "foo",
        "---\nname: foo\ndescription: 외부 foo\n---\n# body\n",
    );

    // 중앙으로 import(외부는 읽기만 — 무손상).
    let imported = crate::skills::import::import_external_skill_core(
        &db,
        central.path(),
        &ext_root.path().join("foo/SKILL.md"),
        SkillProvider::Claude,
    )
    .await
    .expect("import");
    assert_eq!(imported.kind, "managed");

    let roots = vec![SkillRoot::flat(
        SkillProvider::Claude,
        ext_root.path().to_path_buf(),
    )];
    let listed = list_skills_core_with(&db, &roots, Some(central.path()))
        .await
        .expect("list");

    // foo는 정확히 한 건, managed로만(발견본 억제). 외부 파일은 그대로.
    let foos: Vec<&Skill> = listed.iter().filter(|s| s.name == "foo").collect();
    assert_eq!(foos.len(), 1, "managed가 발견본을 억제해 한 건이어야 한다");
    assert_eq!(foos[0].kind, "managed");
    assert_eq!(foos[0].provider, Some(SkillProvider::Claude));
    assert!(
        ext_root.path().join("foo/SKILL.md").exists(),
        "외부 파일 무손상(레일 ②)"
    );

    // central_root=None이면 managed 미포함 → 발견 외부본이 그대로 보인다(기존 코어 동작 보존).
    let without_central = list_skills_core(&db, &roots).await.expect("list none");
    let foos_disc: Vec<&Skill> = without_central.iter().filter(|s| s.name == "foo").collect();
    assert_eq!(foos_disc.len(), 1);
    assert_eq!(foos_disc[0].kind, "external");
}

// ======================================================================
// G1.5-PR1: 네트워크 설치 (remote / source / installer)
// ======================================================================

#[test]
fn parse_source_accepts_common_forms() {
    use crate::skills::remote::parse_source;
    let s = parse_source("owner/repo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");
    assert_eq!(s.git_ref, None);
    assert_eq!(s.subpath, None);

    let s = parse_source("https://github.com/owner/repo").unwrap();
    assert_eq!(s.owner, "owner");
    assert_eq!(s.repo, "repo");

    let s = parse_source("github.com/owner/repo@main#skills/foo").unwrap();
    assert_eq!(s.git_ref.as_deref(), Some("main"));
    assert_eq!(s.subpath.as_deref(), Some("skills/foo"));

    let s = parse_source("https://github.com/owner/repo.git").unwrap();
    assert_eq!(s.repo, "repo");
}

#[test]
fn parse_source_rejects_garbage() {
    use crate::skills::remote::parse_source;
    assert!(parse_source("").is_none());
    assert!(parse_source("not-a-repo").is_none());
    assert!(parse_source("https://gitlab.com/owner/repo").is_none()); // GitHub 전용(이번 라운드)
}

#[test]
fn safe_relative_rejects_traversal_and_absolute() {
    use crate::skills::remote::safe_relative;
    use std::path::Path;
    assert!(safe_relative(Path::new("../escape.txt")).is_none());
    assert!(safe_relative(Path::new("a/../../escape")).is_none());
    assert!(safe_relative(Path::new("/abs/path")).is_none());
    assert!(safe_relative(Path::new("")).is_none());
    let ok = safe_relative(Path::new("owner-repo-abc/SKILL.md")).unwrap();
    assert_eq!(ok, Path::new("owner-repo-abc/SKILL.md"));
}

/// (path, contents) 엔트리로 gzip tarball을 메모리에 만든다(테스트 헬퍼).
fn make_targz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut tar_buf = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        for (path, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *contents).unwrap();
        }
        builder.finish().unwrap();
    }
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&tar_buf).unwrap();
    gz.finish().unwrap()
}

#[test]
fn extract_tarball_returns_top_level_dir() {
    use crate::skills::remote::extract_tarball;
    let gz = make_targz(&[
        ("owner-repo-abc123/SKILL.md", b"---\nname: x\n---\nbody"),
        ("owner-repo-abc123/extra.txt", b"hi"),
    ]);
    let (tmp, top) = extract_tarball(&gz).unwrap();
    assert_eq!(top, "owner-repo-abc123");
    assert!(tmp.path().join("owner-repo-abc123/SKILL.md").is_file());
    assert!(tmp.path().join("owner-repo-abc123/extra.txt").is_file());
}

/// 단일 엔트리 raw ustar tar.gz를 만든다. `tar::Builder`는 `..` 경로를 빌드타임에 거부하므로
/// 악성 경로(tar-slip)를 주입하려면 헤더를 직접 작성해야 한다(체크섬 포함).
fn make_raw_tar_gz(name: &str, data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut header = [0u8; 512];
    let name_bytes = name.as_bytes();
    header[..name_bytes.len()].copy_from_slice(name_bytes);
    header[100..108].copy_from_slice(b"0000644\0"); // mode
    header[108..116].copy_from_slice(b"0000000\0"); // uid
    header[116..124].copy_from_slice(b"0000000\0"); // gid
    let size = format!("{:011o}\0", data.len()); // size(12B)
    header[124..136].copy_from_slice(size.as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0"); // mtime
    header[156] = b'0'; // typeflag = regular file
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    // 체크섬: chksum 필드를 8칸 공백으로 둔 채 전체 바이트 합산.
    for b in &mut header[148..156] {
        *b = b' ';
    }
    let sum: u32 = header.iter().map(|&b| b as u32).sum();
    let chksum = format!("{sum:06o}\0 "); // 6 octal + nul + space = 8B
    header[148..156].copy_from_slice(chksum.as_bytes());

    let mut tar = Vec::new();
    tar.extend_from_slice(&header);
    tar.extend_from_slice(data);
    let pad = (512 - (data.len() % 512)) % 512;
    tar.resize(tar.len() + pad, 0); // 데이터 블록 패딩
    tar.resize(tar.len() + 1024, 0); // 종료 = 두 개의 zero 블록

    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&tar).unwrap();
    gz.finish().unwrap()
}

#[test]
fn extract_tarball_rejects_tar_slip() {
    use crate::skills::remote::extract_tarball;
    // 악성 ".." 엔트리는 추출 거부(경로 탈출 방어, ADR-0006). raw tar로 빌드타임 검증을 우회해 주입.
    let gz = make_raw_tar_gz("../escape.txt", b"evil");
    let res = extract_tarball(&gz);
    assert!(res.is_err(), "tar-slip(.. 경로) 엔트리는 거부해야 한다");
    // 탈출 파일이 임시 루트 밖에 생기지 않았는지(거부가 쓰기보다 먼저 일어남) 보강 확인.
    assert!(!std::path::Path::new("/tmp/escape.txt").exists());
}

#[test]
fn remote_fetch_error_classification() {
    use crate::error::{AppError, ErrorKind};
    use crate::retry::Retryable;
    use crate::skills::remote::RemoteFetchError;

    assert!(RemoteFetchError::Transient("x".into()).is_retryable());
    assert!(!RemoteFetchError::Terminal("x".into()).is_retryable());
    assert!(!RemoteFetchError::NotFound("x".into()).is_retryable());
    assert!(!RemoteFetchError::Forbidden("x".into()).is_retryable());

    let ae: AppError = RemoteFetchError::NotFound("nope".into()).into();
    assert_eq!(ae.kind, ErrorKind::NotFound);
    let ae: AppError = RemoteFetchError::Transient("blip".into()).into();
    assert_eq!(ae.kind, ErrorKind::Transient);
    assert!(ae.retryable);
}

#[test]
fn fetch_budget_is_bounded() {
    // 무한 retry 금지 가드(ADR-0006 레일 ③/④ bounded). 상수라 컴파일타임 assert로 잠근다.
    const { assert!(crate::skills::remote::FETCH_MAX_ATTEMPTS <= 5) };
}

#[tokio::test]
async fn upsert_and_get_skill_source() {
    use crate::skills::source::{get_skill_source, upsert_skill_source, NewSkillSource};
    let pool = fresh_db().await;

    upsert_skill_source(
        &pool,
        NewSkillSource {
            provider: "claude",
            name: "demo",
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "abc123",
        },
    )
    .await
    .unwrap();

    let got = get_skill_source(&pool, "claude", "demo")
        .await
        .unwrap()
        .expect("row present");
    assert_eq!(got.source_url, "github.com/owner/repo");
    assert_eq!(got.installed_commit, "abc123");
    assert!(!got.auto_update);

    // 재upsert는 같은 (provider,name) 행을 갱신(중복 없음).
    upsert_skill_source(
        &pool,
        NewSkillSource {
            provider: "claude",
            name: "demo",
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "def456",
        },
    )
    .await
    .unwrap();
    let got = get_skill_source(&pool, "claude", "demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.installed_commit, "def456");
}

#[tokio::test]
async fn install_from_dir_copies_records_and_audits() {
    use crate::skills::installer::{install_from_dir, InstallMeta};
    let pool = fresh_db().await;
    let tmp = TempDir::new().unwrap();
    make_skill(tmp.path(), "demo", "---\nname: demo\n---\nhello");
    let source_dir = tmp.path().join("demo");
    let central_root = tmp.path().join("lib");

    let skill = install_from_dir(
        &pool,
        &central_root,
        &source_dir,
        SkillProvider::Claude,
        InstallMeta {
            source_url: "github.com/owner/repo",
            source_ref: Some("main"),
            subpath: None,
            installed_commit: "abc123",
        },
    )
    .await
    .unwrap();

    assert_eq!(skill.kind, "managed");
    assert!(central_root.join("claude/demo/SKILL.md").is_file());

    let prov = crate::skills::source::get_skill_source(&pool, "claude", "demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prov.installed_commit, "abc123");

    let entries = crate::skills::audit_log::list_skill_audit_core(&pool)
        .await
        .unwrap();
    assert!(entries.iter().any(|e| e.action == "install"));
}

#[tokio::test]
async fn install_from_dir_rejects_non_skill() {
    use crate::skills::installer::{install_from_dir, InstallMeta};
    let pool = fresh_db().await;
    let tmp = TempDir::new().unwrap();
    let not_skill = tmp.path().join("blob");
    std::fs::create_dir_all(&not_skill).unwrap();
    std::fs::write(not_skill.join("random.txt"), b"nope").unwrap();
    let central_root = tmp.path().join("lib");

    let res = install_from_dir(
        &pool,
        &central_root,
        &not_skill,
        SkillProvider::Claude,
        InstallMeta {
            source_url: "github.com/owner/repo",
            source_ref: None,
            subpath: None,
            installed_commit: "x",
        },
    )
    .await;
    assert!(res.is_err(), "비스킬 dir은 거부");
    assert!(!central_root.exists(), "거부 시 중앙 오염 없음");
}

// ── G3-PR1: 프로젝트 워크스페이스 집계(읽기 전용·디스크 유도) ──

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

/// 빈 워크스페이스 제외: 스킬 0개 레포(스킬 dir 없음/존재하지 않는 경로 포함)는 결과에서 빠진다.
#[test]
fn workspaces_exclude_empty_repos() {
    let empty = TempDir::new().unwrap(); // 스킬 dir 없음
    let repos = vec![
        make_repo(Provider::Local, empty.path().to_str(), true),
        make_repo(Provider::Local, Some("/no/such/path/xyz"), true), // 부재 경로 → 스캔 빈 결과
    ];
    let out = list_skill_workspaces_core(&repos);
    assert!(
        out.is_empty(),
        "스킬 0개 레포는 워크스페이스 미생성(패닉 없이 graceful)"
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
