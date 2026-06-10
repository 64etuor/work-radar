//! Phase 3 #12 태그 테스트 (원본 tests.rs 940–1121번 라인 이동).
use super::*;

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
