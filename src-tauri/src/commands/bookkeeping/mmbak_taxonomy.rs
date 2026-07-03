//! MoneyManager(.mmbak) 카테고리 → 로컬 taxonomy 동기화 + 기존 행 category_code 백필.
//!
//! 원칙: **사용자의 MoneyManager 분류 체계가 mmbak 행의 정확한(1:1) 가시 분류다.**
//! 활성(C_IS_DEL=0) MM 카테고리 전부를 `mm-<uid>` 코드로 taxonomy에 **멱등 upsert**하고
//! (과거의 "시드 alias로 해석되면 노드 생성 스킵" 규칙은 폐기 — 생활용품→shopping,
//! 식비→food 같은 붕괴의 원인이었다), 거래가 갖게 되는 raw_category 문자열(단일 NAME
//! 또는 "부모 > 자식")에 대한 raw_label alias를 mm- 코드로 보강한다. 이 alias는 다른
//! 소스(gmail/ocr)의 같은 라벨도 사용자 분류로 안착시키는 부수 효과가 있으며, 같은
//! 패턴의 **비-user(시드) alias는 mm- 코드로 재타깃된다**(사용자 자신의 라벨에 대해선
//! 사용자 분류가 배포 시드를 이긴다 — `WHERE source != 'user'` 가드가 user alias만 보호).
//! 시드 22코드 taxonomy 노드는 절대 건드리지 않는다(mm- prefix 가드).
//!
//! mmbak 행 자체는 alias 추측이 아니라 **직접 배정**이다: 임포터가 ctgUid → mm- 코드 쌍을
//! `direct_mm_codes`로 계산해 ingest에 명시 코드로 넘긴다(신규 INSERT에서 명시 코드 우선,
//! conflict 시 기존 판단 보존 — 교정은 아래 백필이 담당).
//!
//! 코드 안정성: MM uid는 같은 백업 계보 안에서 안정적이다. MoneyManager를 새로 설치해
//! 재구성하면 uid가 재발급되어 새 mm-<uid> 노드가 생기지만, 정본은 사용자의 라이브 앱
//! 백업 계보이므로 수용한다(라벨 rename은 ON CONFLICT UPDATE로 전파).

use std::collections::HashMap;

use crate::db::Db;
use crate::error::AppError;
use crate::moneymanager::{nonempty_ref, MmCategory, MmInoutcomeRow};

use super::*;

/// mm- 노드 sort_order 고정값 — 시드 대분류(10..80)와 'uncategorized'(999) 사이.
/// 상수라 재임포트에도 안정(멱등). 동순위 정렬은 code ASC가 결정한다.
const MM_NODE_SORT_ORDER: i32 = 500;
/// mmbak 유래 raw_label alias 신뢰도 — 시드 alias(0.9)와 같은 tier.
const MM_ALIAS_CONFIDENCE: f64 = 0.9;

/// 이번 동기화에서 upsert를 시도한 노드/alias 수(감사 로그용 — 신규/갱신 구분 없음).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct MmTaxonomySyncCounts {
    pub(crate) nodes: u32,
    pub(crate) aliases: u32,
}

fn mm_code(uid: &str) -> String {
    format!("mm-{}", uid.trim())
}

/// 동기화/직접 배정 대상 카테고리 판정(활성 + uid/NAME 비어있지 않음).
fn is_syncable(cat: &MmCategory) -> bool {
    cat.is_del == 0 && !cat.uid.trim().is_empty() && !cat.name.trim().is_empty()
}

/// 자식을 그 아래로 배치할 수 있는 부모: 존재 + syncable + **최상위**(MM은 2단계 —
/// 부모가 또 자식이면 taxonomy FK/구조가 어긋나므로 배치하지 않는다). 부모가 삭제/미지면
/// 자식은 최상위 mm- 노드가 된다.
fn placement_parent<'a>(
    cat: &MmCategory,
    categories: &'a HashMap<String, MmCategory>,
) -> Option<&'a MmCategory> {
    nonempty_ref(&cat.parent_uid)
        .and_then(|uid| categories.get(uid))
        .filter(|p| is_syncable(p) && nonempty_ref(&p.parent_uid).is_none())
}

/// ctgUid → 결정론적 mm- 코드 쌍. `sync_mm_taxonomy`가 만드는 노드 구조와 정확히 같은
/// 규칙: 자식(배치 가능한 부모 있음) → (부모 mm- 코드, 자식 mm- 코드), 그 외 syncable
/// 카테고리 → (자기 mm- 코드, NULL). 삭제/미지 카테고리는 None(→ alias 해석 폴백).
pub(crate) fn direct_mm_codes(
    ctg_uid: &str,
    categories: &HashMap<String, MmCategory>,
) -> Option<(String, Option<String>)> {
    let cat = nonempty_ref(ctg_uid).and_then(|uid| categories.get(uid))?;
    if !is_syncable(cat) {
        return None;
    }
    match placement_parent(cat, categories) {
        Some(parent) => Some((mm_code(&parent.uid), Some(mm_code(&cat.uid)))),
        None => Some((mm_code(&cat.uid), None)),
    }
}

/// taxonomy 노드 멱등 upsert. mm- prefix 강제 — 시드 코드 오염을 코드 레벨에서 차단.
async fn upsert_mm_node(
    db: &Db,
    code: &str,
    parent_code: Option<&str>,
    label: &str,
) -> Result<(), AppError> {
    if !code.starts_with("mm-") {
        return Err(AppError::validation(
            "bookkeeping.mmbak.taxonomy_code",
            "mm- prefix 코드만 동기화할 수 있습니다",
        ));
    }
    sqlx::query(
        "INSERT INTO bookkeeping_category_taxonomy (code, parent_code, label, sort_order, active) \
         VALUES (?1, ?2, ?3, ?4, 1) \
         ON CONFLICT(code) DO UPDATE SET \
           label = excluded.label, \
           parent_code = excluded.parent_code, \
           active = 1",
    )
    .bind(code)
    .bind(parent_code)
    .bind(label)
    .bind(MM_NODE_SORT_ORDER)
    .execute(db)
    .await?;
    Ok(())
}

/// raw_label alias 멱등 upsert. 기존 `source='user'` alias는 절대 덮지 않는다
/// (사람 결정 우선 — INVARIANT #1). source='seed': 사용자 라이브 앱 데이터에서
/// 결정론적으로 유도된 매핑이라 시드와 같은 신뢰 계층이며, 'agent'(LLM 제안)가 아니다.
///
/// 패턴은 사용자 alias 경로(`reinforce_category_alias_tx`)와 **같은 정규화**를 거쳐
/// 저장한다 — 동일 의미 패턴이 UNIQUE(match_kind, pattern)에서 실제로 충돌해야
/// `source != 'user'` 가드가 사용자 alias를 보호할 수 있다(해석은 어차피 정규화 비교).
async fn upsert_mm_alias(
    db: &Db,
    pattern: &str,
    category_code: &str,
    subcategory_code: Option<&str>,
) -> Result<(), AppError> {
    let pattern = normalize_label(pattern);
    if pattern.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO bookkeeping_category_alias \
         (id, pattern, match_kind, category_code, subcategory_code, confidence, source) \
         VALUES (lower(hex(randomblob(16))), ?1, 'raw_label', ?2, ?3, ?4, 'seed') \
         ON CONFLICT(match_kind, pattern) DO UPDATE SET \
           category_code = excluded.category_code, \
           subcategory_code = excluded.subcategory_code, \
           confidence = excluded.confidence \
         WHERE bookkeeping_category_alias.source != 'user'",
    )
    .bind(&pattern)
    .bind(category_code)
    .bind(subcategory_code)
    .bind(MM_ALIAS_CONFIDENCE)
    .execute(db)
    .await?;
    Ok(())
}

/// 활성 MM 카테고리 **전부**를 mm-<uid> taxonomy 노드로 동기화한다 — 사용자의 MM 분류
/// 체계가 그대로 가시 taxonomy가 된다(1:1). 시드 alias로 해석 가능한 라벨(식비/생활용품…)
/// 도 예외 없이 자기 mm- 노드를 갖는다. 거래 raw_category 문자열에 대한 raw_label alias도
/// mm- 코드로 upsert한다 — 같은 패턴의 비-user alias(배포 시드 포함)는 재타깃되고,
/// `source='user'` alias는 절대 덮지 않는다(`upsert_mm_alias`의 WHERE 가드).
pub(crate) async fn sync_mm_taxonomy(
    db: &Db,
    categories: &HashMap<String, MmCategory>,
) -> Result<MmTaxonomySyncCounts, AppError> {
    let mut counts = MmTaxonomySyncCounts::default();

    let mut active: Vec<&MmCategory> = categories.values().filter(|c| is_syncable(c)).collect();
    // uid 순 결정론적 처리 — 동명 카테고리가 있어도 매 임포트 같은 노드로 수렴.
    active.sort_by(|a, b| a.uid.cmp(&b.uid));

    // 1패스: 최상위 카테고리(pUid 없음/'0') — 자식의 parent_code FK 대상이라 먼저 넣는다.
    for cat in active
        .iter()
        .filter(|c| nonempty_ref(&c.parent_uid).is_none())
    {
        let name = cat.name.trim();
        let code = mm_code(&cat.uid);
        upsert_mm_node(db, &code, None, name).await?;
        counts.nodes += 1;
        upsert_mm_alias(db, name, &code, None).await?;
        counts.aliases += 1;
    }

    // 2패스: 자식 카테고리. 거래의 raw_category는 "부모 NAME > 자식 NAME"이다
    // (moneymanager::resolve_category_labels 계약 — 부모 NAME은 삭제 여부와 무관하게
    // 붙는다). 노드 배치는 `placement_parent`/`direct_mm_codes`와 동일 규칙.
    for cat in active
        .iter()
        .filter(|c| nonempty_ref(&c.parent_uid).is_some())
    {
        let name = cat.name.trim();
        let parent_name = nonempty_ref(&cat.parent_uid)
            .and_then(|uid| categories.get(uid))
            .map(|p| p.name.trim())
            .filter(|n| !n.is_empty());
        let raw = match parent_name {
            Some(parent_name) => format!("{parent_name} > {name}"),
            None => name.to_string(),
        };
        let parent_code = placement_parent(cat, categories).map(|p| mm_code(&p.uid));
        let code = mm_code(&cat.uid);
        upsert_mm_node(db, &code, parent_code.as_deref(), name).await?;
        counts.nodes += 1;
        let (alias_cat, alias_sub) = match parent_code.as_deref() {
            Some(parent) => (parent.to_string(), Some(code.clone())),
            None => (code.clone(), None),
        };
        upsert_mm_alias(db, &raw, &alias_cat, alias_sub.as_deref()).await?;
        counts.aliases += 1;
    }

    Ok(counts)
}

/// 사람 손이 닿은 적 없는(오버라이드 0건) moneymanager 행의 category_code를 교정한다.
/// 두 단계(각각 단일 패스, bounded):
///
/// 1. **직접 교정** — 백업에 존재하는 행은 ctgUid → `direct_mm_codes` 결과가 정본이다.
///    저장된 (category_code, subcategory_code)가 다르면(과거 시드 alias로 붕괴한
///    식비→food, 생활용품→shopping 등 포함) mm- 코드 쌍으로 재지정한다.
/// 2. **잔여 미분류 해석** — 이 백업에 없는 행(다른 백업 계보 유래 등) 중 여전히
///    NULL/'uncategorized'인 행을 raw 라벨 alias로 재해석해 채운다.
///
/// 힌트 갱신일 뿐 결정이 아니다 — review_status/사유는 건드리지 않는다(INVARIANT #1).
pub(crate) async fn backfill_mm_category_codes(
    db: &Db,
    backup_rows: &[MmInoutcomeRow],
    categories: &HashMap<String, MmCategory>,
) -> Result<u32, AppError> {
    let mut backfilled = backfill_direct_mm_codes(db, backup_rows, categories).await?;
    backfilled += backfill_unresolved_mm_codes(db).await?;
    Ok(backfilled)
}

/// 1단계: 백업 ctgUid 기준 직접 교정. 기대 코드는 결정론적이므로 SELECT 시점의 stale
/// 값 재확인은 불필요하다 — UPDATE WHERE에서 (a) soft-delete 아님 (b) 오버라이드 0건만
/// 다시 확인하면 충분하다(`apply_direct_backfill_update` 참조).
async fn backfill_direct_mm_codes(
    db: &Db,
    backup_rows: &[MmInoutcomeRow],
    categories: &HashMap<String, MmCategory>,
) -> Result<u32, AppError> {
    // source_ref(=INOUTCOME uid) → 기대 (category_code, subcategory_code).
    let mut expected: HashMap<&str, (String, Option<String>)> = HashMap::new();
    for row in backup_rows {
        if row.is_del != 0 {
            continue;
        }
        let uid = row.uid.trim();
        if uid.is_empty() {
            continue;
        }
        if let Some(codes) = direct_mm_codes(&row.ctg_uid, categories) {
            expected.insert(uid, codes);
        }
    }
    if expected.is_empty() {
        return Ok(0);
    }

    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT t.id, t.source_ref, t.category_code, t.subcategory_code \
         FROM bookkeeping_transactions t \
         WHERE t.source = 'moneymanager' \
           AND t.source_ref IS NOT NULL \
           AND t.deleted_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM bookkeeping_category_overrides o \
                           WHERE o.transaction_id = t.id)",
    )
    .fetch_all(db)
    .await?;

    let mut backfilled = 0u32;
    for (id, source_ref, category_code, subcategory_code) in rows {
        let Some((want_cat, want_sub)) = expected.get(source_ref.as_str()) else {
            continue;
        };
        if category_code.as_deref() == Some(want_cat.as_str())
            && subcategory_code.as_deref() == want_sub.as_deref()
        {
            continue;
        }
        if apply_direct_backfill_update(db, &id, want_cat, want_sub.as_deref()).await? {
            backfilled += 1;
        }
    }
    Ok(backfilled)
}

/// 2단계: 여전히 NULL/'uncategorized'인 행의 raw 라벨 alias 재해석(레거시 경로 유지).
async fn backfill_unresolved_mm_codes(db: &Db) -> Result<u32, AppError> {
    let rules = bookkeeping_category_rules_inner(db).await?;
    let rows: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT t.id, t.raw_category, t.category, t.merchant \
         FROM bookkeeping_transactions t \
         WHERE t.source = 'moneymanager' \
           AND t.deleted_at IS NULL \
           AND (t.category_code IS NULL OR t.category_code = 'uncategorized') \
           AND NOT EXISTS (SELECT 1 FROM bookkeeping_category_overrides o \
                           WHERE o.transaction_id = t.id)",
    )
    .fetch_all(db)
    .await?;

    let mut backfilled = 0u32;
    for (id, raw_category, category, merchant) in rows {
        let raw = raw_category.as_deref().unwrap_or(category.as_str());
        let resolved = resolve_category_with_rules(&rules, None, "", Some(raw), &merchant);
        let Some(code) = resolved.category_code.filter(|c| c != "uncategorized") else {
            continue;
        };
        if apply_backfill_update(db, &id, &code, resolved.subcategory_code.as_deref()).await? {
            backfilled += 1;
        }
    }
    Ok(backfilled)
}

/// 직접 교정 UPDATE 본체. 목표 코드가 결정론적이므로 stale-값 동등성 검사 대신
/// **사람 결정 가드만** WHERE에 반복한다: soft-delete 아님 + 오버라이드 0건.
/// category_code를 쓰는 모든 사람 경로(단건/벌크/거래 편집)는
/// `override_bookkeeping_category_inner`를 경유해 반드시 오버라이드 행을 남기므로,
/// SELECT와 UPDATE 사이에 사람이 끼어들어도(TOCTOU) NOT EXISTS가 막는다.
/// 값-변경 조건(IS NOT)을 함께 걸어 no-op 갱신은 카운트/updated_at에 잡히지 않게 한다.
async fn apply_direct_backfill_update(
    db: &Db,
    id: &str,
    category_code: &str,
    subcategory_code: Option<&str>,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE bookkeeping_transactions \
         SET category_code = ?2, subcategory_code = ?3, updated_at = datetime('now') \
         WHERE id = ?1 \
           AND deleted_at IS NULL \
           AND (category_code IS NOT ?2 OR subcategory_code IS NOT ?3) \
           AND NOT EXISTS (SELECT 1 FROM bookkeeping_category_overrides o \
                           WHERE o.transaction_id = bookkeeping_transactions.id)",
    )
    .bind(id)
    .bind(category_code)
    .bind(subcategory_code)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// 백필 UPDATE 본체. SELECT의 가드 전체(soft-delete 아님 · 여전히 미분류 ·
/// 오버라이드 0건)를 WHERE에 반복한다 — select와 update 사이에 사람 오버라이드가
/// 끼어들어도(TOCTOU) 절대 덮지 않는다. 0행이면 스킵으로 취급(false).
async fn apply_backfill_update(
    db: &Db,
    id: &str,
    category_code: &str,
    subcategory_code: Option<&str>,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE bookkeeping_transactions \
         SET category_code = ?2, subcategory_code = ?3, updated_at = datetime('now') \
         WHERE id = ?1 \
           AND deleted_at IS NULL \
           AND (category_code IS NULL OR category_code = 'uncategorized') \
           AND NOT EXISTS (SELECT 1 FROM bookkeeping_category_overrides o \
                           WHERE o.transaction_id = bookkeeping_transactions.id)",
    )
    .bind(id)
    .bind(category_code)
    .bind(subcategory_code)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        BookkeepingCategoryTrendInput, BookkeepingSource, ImportBookkeepingMmbakInput,
        OverrideBookkeepingCategoryInput,
    };
    use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};

    async fn pool() -> Db {
        let p = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("sqlite in-memory");
        sqlx::migrate!("./migrations")
            .run(&p)
            .await
            .expect("migrations");
        p
    }

    async fn exec_fixture(path: &std::path::Path, sql: &str) {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&opts).await.expect("open");
        sqlx::query(sql).execute(&mut conn).await.expect("exec");
        conn.close().await.expect("close");
    }

    /// .mmbak 픽스처 — 활성 카테고리 **전부**가 mm- 노드 대상이다(1:1 원칙).
    /// - '식비'(10)/'카페'(11)/'급여'(20): 시드 라벨과 겹쳐도 자기 mm- 노드를 갖는다
    /// - '낭비'(30) + 자식 '담배'(31): 시드 미표현 카테고리
    /// - '보험'(40): 삭제 표시(C_IS_DEL=1) → 동기화 비대상
    /// - '생활용품'(50): 배포 시드 alias(→shopping/shopping_daily)와 패턴 충돌 → 재타깃 대상
    async fn fixture_mmbak(dir: &tempfile::TempDir) -> std::path::PathBuf {
        let path = dir.path().join("backup.mmbak");
        for sql in [
            "CREATE TABLE INOUTCOME (uid TEXT, assetUid TEXT, ctgUid TEXT, ZCONTENT TEXT, \
             ZDATE INTEGER, WDATE TEXT, DO_TYPE TEXT, ZMONEY TEXT, toAssetUid TEXT, \
             txUidTrans TEXT, cardDivideUid TEXT, CARDDIVIDMONTH TEXT, IS_DEL INTEGER, \
             UTIME INTEGER, currencyUid TEXT, ZDATA TEXT)",
            "CREATE TABLE ZCATEGORY (uid TEXT, NAME TEXT, TYPE INTEGER, pUid TEXT, \
             C_IS_DEL INTEGER, STATUS INTEGER)",
            "CREATE TABLE ASSETS (uid TEXT, NIC_NAME TEXT, groupUid TEXT)",
            "CREATE TABLE CURRENCY (uid TEXT, ISO TEXT, DECIMAL_POINT INTEGER)",
            "INSERT INTO ZCATEGORY VALUES ('10','식비',1,'0',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('11','카페',1,'10',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('20','급여',0,'',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('30','낭비',1,'0',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('31','담배',1,'30',0,0)",
            "INSERT INTO ZCATEGORY VALUES ('40','보험',1,'0',1,0)",
            "INSERT INTO ZCATEGORY VALUES ('50','생활용품',1,'0',0,0)",
            "INSERT INTO ASSETS VALUES ('a1','하나카드','g1')",
            "INSERT INTO CURRENCY VALUES ('KRW_KRW','KRW',0)",
            "INSERT INTO INOUTCOME VALUES ('mm-cafe-1','a1','11','스타벅스',0,'2026-06-15','1','5500.0','','','','',0,100,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('mm-waste-1','a1','31','편의점담배',0,'2026-06-20','1','12000.0','','','','',0,200,'KRW_KRW','')",
        ] {
            exec_fixture(&path, sql).await;
        }
        path
    }

    fn mmbak_input(path: &std::path::Path) -> ImportBookkeepingMmbakInput {
        ImportBookkeepingMmbakInput {
            project_id: None,
            path: path.to_string_lossy().to_string(),
        }
    }

    async fn taxonomy_row(db: &Db, code: &str) -> Option<(Option<String>, String, i64)> {
        sqlx::query_as(
            "SELECT parent_code, label, active FROM bookkeeping_category_taxonomy WHERE code = ?1",
        )
        .bind(code)
        .fetch_optional(db)
        .await
        .expect("taxonomy row")
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(db).await.expect("count")
    }

    async fn tx_codes(db: &Db, source_ref: &str) -> (Option<String>, Option<String>, String) {
        sqlx::query_as(
            "SELECT category_code, subcategory_code, review_status \
             FROM bookkeeping_transactions WHERE source='moneymanager' AND source_ref=?1",
        )
        .bind(source_ref)
        .fetch_one(db)
        .await
        .expect("tx row")
    }

    #[tokio::test]
    async fn sync_creates_mm_nodes_for_all_active_categories_and_assigns_direct_codes() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");

        // 활성 카테고리 전부 mm- 노드(1:1) — 시드 라벨과 겹치는 식비/카페/급여도 포함.
        assert_eq!(
            taxonomy_row(&db, "mm-10").await.expect("mm-10"),
            (None, "식비".to_string(), 1)
        );
        assert_eq!(
            taxonomy_row(&db, "mm-11").await.expect("mm-11"),
            (Some("mm-10".to_string()), "카페".to_string(), 1)
        );
        assert_eq!(
            taxonomy_row(&db, "mm-20").await.expect("mm-20"),
            (None, "급여".to_string(), 1)
        );
        assert_eq!(
            taxonomy_row(&db, "mm-30").await.expect("mm-30"),
            (None, "낭비".to_string(), 1)
        );
        assert_eq!(
            taxonomy_row(&db, "mm-31").await.expect("mm-31"),
            (Some("mm-30".to_string()), "담배".to_string(), 1)
        );
        assert_eq!(
            taxonomy_row(&db, "mm-50").await.expect("mm-50"),
            (None, "생활용품".to_string(), 1)
        );
        // 삭제된 보험만 비대상.
        assert!(taxonomy_row(&db, "mm-40").await.is_none());

        // 신규 임포트 행은 ctgUid 직접 배정으로 mm- 코드 쌍을 갖는다(alias 추측 아님).
        let (code, sub, _) = tx_codes(&db, "mm-waste-1").await;
        assert_eq!(code.as_deref(), Some("mm-30"));
        assert_eq!(sub.as_deref(), Some("mm-31"));
        // 시드 라벨('식비 > 카페')도 사용자 분류의 mm- 쌍으로 — food/food_cafe 붕괴 없음.
        let (code, sub, _) = tx_codes(&db, "mm-cafe-1").await;
        assert_eq!(code.as_deref(), Some("mm-10"));
        assert_eq!(sub.as_deref(), Some("mm-11"));
    }

    #[tokio::test]
    async fn sync_retargets_non_user_seed_alias_to_mm_code() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 배포 시드 alias: '생활용품' → shopping/shopping_daily (source='seed').
        let before: (String, Option<String>, String) = sqlx::query_as(
            "SELECT category_code, subcategory_code, source FROM bookkeeping_category_alias \
             WHERE match_kind='raw_label' AND pattern='생활용품'",
        )
        .fetch_one(&db)
        .await
        .expect("seed alias present");
        assert_eq!(before.0, "shopping");
        assert_eq!(before.2, "seed");

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");

        // 사용자 자신의 라벨에 대해선 사용자 분류가 배포 시드를 이긴다 — in-place 재타깃,
        // 중복행 없음. (user alias만 보호 대상 — sync_never_clobbers_user_alias 참조.)
        let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
            "SELECT category_code, subcategory_code, source FROM bookkeeping_category_alias \
             WHERE match_kind='raw_label' AND pattern='생활용품'",
        )
        .fetch_all(&db)
        .await
        .expect("alias rows");
        assert_eq!(rows.len(), 1, "retarget in place, no duplicate");
        assert_eq!(rows[0].0, "mm-50");
        assert_eq!(rows[0].1, None);
    }

    #[tokio::test]
    async fn sync_is_idempotent_and_propagates_label_rename_without_touching_seeds() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        let seeds_before: Vec<(String, String)> =
            sqlx::query_as("SELECT code, label FROM bookkeeping_category_taxonomy ORDER BY code")
                .fetch_all(&db)
                .await
                .expect("seed snapshot");
        assert_eq!(seeds_before.len(), 22);

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("second import");

        // 멱등: mm- 노드는 활성 카테고리(10/11/20/30/31/50)당 정확히 1개, alias도 패턴당 1개.
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM bookkeeping_category_taxonomy WHERE code LIKE 'mm-%'"
            )
            .await,
            6
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM bookkeeping_category_alias WHERE pattern = '낭비'"
            )
            .await,
            1
        );
        // 자식 패턴은 사용자 alias 경로와 같은 정규화 형태('낭비 담배')로 저장된다.
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM bookkeeping_category_alias WHERE pattern = '낭비 담배'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM bookkeeping_category_alias WHERE pattern = '낭비 > 담배'"
            )
            .await,
            0,
            "raw display pattern must not be stored — normalized form only"
        );

        // 시드 22코드는 코드·라벨 모두 그대로.
        let seeds_after: Vec<(String, String)> = sqlx::query_as(
            "SELECT code, label FROM bookkeeping_category_taxonomy \
             WHERE code NOT LIKE 'mm-%' ORDER BY code",
        )
        .fetch_all(&db)
        .await
        .expect("seed snapshot after");
        assert_eq!(seeds_after, seeds_before);

        // MM에서 라벨 rename → 재임포트 시 mm- 노드 라벨 전파.
        exec_fixture(&path, "UPDATE ZCATEGORY SET NAME='과소비' WHERE uid='30'").await;
        exec_fixture(
            &path,
            "UPDATE INOUTCOME SET UTIME=300 WHERE uid='mm-waste-1'",
        )
        .await;
        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("rename import");
        let parent = taxonomy_row(&db, "mm-30").await.expect("mm-30 node");
        assert_eq!(parent.1, "과소비");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM bookkeeping_category_taxonomy WHERE code LIKE 'mm-%'"
            )
            .await,
            6,
            "rename must not duplicate nodes"
        );
    }

    #[tokio::test]
    async fn sync_never_clobbers_user_alias() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 사용자가 '낭비'를 의도적으로 uncategorized로 고정해 둔 alias.
        sqlx::query(
            "INSERT INTO bookkeeping_category_alias \
             (id, pattern, match_kind, category_code, subcategory_code, confidence, source) \
             VALUES ('user-alias-1', '낭비', 'raw_label', 'uncategorized', NULL, 0.96, 'user')",
        )
        .execute(&db)
        .await
        .expect("seed user alias");

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");

        // 노드는 만들되(라벨 미해석), 사용자 alias는 그대로.
        assert!(taxonomy_row(&db, "mm-30").await.is_some());
        let alias: (String, String, Option<String>) = sqlx::query_as(
            "SELECT category_code, source, subcategory_code FROM bookkeeping_category_alias \
             WHERE match_kind='raw_label' AND pattern='낭비'",
        )
        .fetch_one(&db)
        .await
        .expect("user alias survives");
        assert_eq!(alias.0, "uncategorized");
        assert_eq!(alias.1, "user");
    }

    #[tokio::test]
    async fn sync_alias_upsert_collides_with_normalized_user_alias_without_clobber() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 사용자가 자식 라벨 alias를 의도적으로 고정(정규화 패턴 — reinforce 경로와 동일).
        // sync의 alias upsert는 UNIQUE(match_kind, pattern) 충돌에서 source='user' 가드에
        // 막혀야 한다.
        sqlx::query(
            "INSERT INTO bookkeeping_category_alias \
             (id, pattern, match_kind, category_code, subcategory_code, confidence, source) \
             VALUES ('user-alias-child', '낭비 담배', 'raw_label', 'work', NULL, 0.96, 'user')",
        )
        .execute(&db)
        .await
        .expect("seed normalized user alias");

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");

        // 정규화 덕에 같은 unique 키에서 충돌 → 사용자 alias 무손상, 중복행 없음.
        let aliases: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT category_code, source, subcategory_code FROM bookkeeping_category_alias \
             WHERE match_kind='raw_label' AND pattern IN ('낭비 담배', '낭비 > 담배')",
        )
        .fetch_all(&db)
        .await
        .expect("alias rows");
        assert_eq!(aliases.len(), 1, "mm upsert must collide, not coexist");
        assert_eq!(aliases[0].0, "work");
        assert_eq!(aliases[0].1, "user");

        // 노드는 그래도 만들어진다(1:1 원칙 — alias 보호와 taxonomy는 별개).
        assert!(taxonomy_row(&db, "mm-31").await.is_some());
        // mmbak 행은 ctgUid **직접 배정**이라 라벨 alias의 영향을 받지 않는다 — 사용자
        // alias는 다른 소스(gmail/ocr)의 해석에만 작용하고, mmbak 행의 사람 결정은
        // per-transaction 오버라이드가 담당한다(백필 가드로 보호).
        let (code, sub, _) = tx_codes(&db, "mm-waste-1").await;
        assert_eq!(code.as_deref(), Some("mm-30"));
        assert_eq!(sub.as_deref(), Some("mm-31"));

        // 비-mmbak 소스(gmail/ocr) 해석은 여전히 사용자 alias를 따른다 — sync가 만든
        // mm- alias가 사용자 alias를 그림자(shadow)로 가리지 않는다.
        let rules = bookkeeping_category_rules_inner(&db).await.expect("rules");
        let resolved = resolve_category_with_rules(&rules, None, "", Some("낭비 > 담배"), "");
        assert_eq!(
            resolved.category_code.as_deref(),
            Some("work"),
            "user alias still wins resolution for other sources"
        );
        assert_eq!(resolved.subcategory_code, None);
    }

    #[tokio::test]
    async fn backfill_update_guard_skips_row_overridden_between_select_and_update() {
        let db = pool().await;

        // uncategorized moneymanager 행 하나 + 그 행에 대한 오버라이드(레이스 시뮬레이션:
        // SELECT가 이 행을 집었다고 가정하고 UPDATE 헬퍼를 직접 호출).
        sqlx::query(
            "INSERT INTO bookkeeping_transactions \
             (id, source, source_ref, merchant, amount_minor, currency, spent_at, category, \
              review_status, direction, category_code) \
             VALUES ('race-tx-1', 'moneymanager', 'race-1', '상호', 1000, 'KRW', '2026-06-20', \
              '낭비', 'needs_review', 'expense', 'uncategorized')",
        )
        .execute(&db)
        .await
        .expect("seed tx");
        sqlx::query(
            "INSERT INTO bookkeeping_category_overrides (id, transaction_id, to_code, actor) \
             VALUES ('race-ov-1', 'race-tx-1', 'work', 'user')",
        )
        .execute(&db)
        .await
        .expect("seed override");

        let applied = apply_backfill_update(&db, "race-tx-1", "mm-30", Some("mm-31"))
            .await
            .expect("guarded update");
        assert!(!applied, "override landed after select → must skip");
        // 직접 교정 UPDATE도 같은 오버라이드 가드를 반복한다(TOCTOU-safe).
        let applied = apply_direct_backfill_update(&db, "race-tx-1", "mm-30", Some("mm-31"))
            .await
            .expect("guarded direct update");
        assert!(
            !applied,
            "override landed after select → must skip (direct)"
        );
        let (code, sub, _) = tx_codes(&db, "race-1").await;
        assert_eq!(code.as_deref(), Some("uncategorized"), "row untouched");
        assert_eq!(sub, None);
    }

    /// 라이브 DB 시나리오: 과거 skip-rule 때문에 시드 코드(food/food_cafe 등)로 붕괴한
    /// 행이 mm- 코드로 재지정되고, 사람이 오버라이드한 행은 절대 건드리지 않는다.
    #[tokio::test]
    async fn backfill_repoints_seed_coded_rows_but_skips_overridden() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 과거 임포트 시뮬레이션: 백업의 두 행이 시드 코드로 저장돼 있다.
        for (source_ref, raw, cat, sub) in [
            ("mm-cafe-1", "식비 > 카페", "food", Some("food_cafe")),
            ("mm-waste-1", "낭비 > 담배", "shopping", None),
        ] {
            sqlx::query(
                "INSERT INTO bookkeeping_transactions \
                 (id, source, source_ref, merchant, amount_minor, currency, spent_at, category, \
                  review_status, direction, category_code, subcategory_code, raw_category) \
                 VALUES (lower(hex(randomblob(16))), 'moneymanager', ?1, '상호', 1000, 'KRW', \
                  '2026-06-20', '카테고리', 'needs_review', 'expense', ?2, ?3, ?4)",
            )
            .bind(source_ref)
            .bind(cat)
            .bind(sub)
            .bind(raw)
            .execute(&db)
            .await
            .expect("seed stale-coded row");
        }
        // mm-waste-1은 사람이 shopping으로 **직접 오버라이드**한 상태 — 백필 비대상.
        let waste_id: (String,) =
            sqlx::query_as("SELECT id FROM bookkeeping_transactions WHERE source_ref='mm-waste-1'")
                .fetch_one(&db)
                .await
                .expect("waste id");
        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: waste_id.0,
                category_code: Some("shopping".to_string()),
                subcategory_code: None,
                reason: None,
            },
        )
        .await
        .expect("manual override");

        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");
        // mm-cafe-1 하나만 교정(mm-waste-1은 오버라이드 보호).
        assert_eq!(summary.backfilled_category_count, 1);

        let (code, sub, review) = tx_codes(&db, "mm-cafe-1").await;
        assert_eq!(code.as_deref(), Some("mm-10"), "seed code repointed");
        assert_eq!(sub.as_deref(), Some("mm-11"));
        assert_eq!(
            review, "needs_review",
            "backfill is a hint — review untouched"
        );

        let (code, sub, _) = tx_codes(&db, "mm-waste-1").await;
        assert_eq!(code.as_deref(), Some("shopping"), "human override wins");
        assert_eq!(sub, None);

        // 멱등: 재임포트 시 교정 대상 없음.
        let summary2 = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        assert_eq!(summary2.backfilled_category_count, 0);
    }

    #[tokio::test]
    async fn backfill_fills_untouched_rows_and_skips_overridden_ones() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 레거시 시뮬레이션: taxonomy 동기화 이전에 유입돼 uncategorized로 붕괴한 행 2개.
        // legacy-2는 별도 raw 라벨('보험')을 쓴다 — 오버라이드가 만드는 user alias가
        // mm-waste-1의 raw('낭비 > 담배') 해석에 영향을 주지 않게 분리(alias 강화는 정상 동작).
        for (source_ref, merchant, raw) in [
            ("mm-waste-1", "편의점담배", "낭비 > 담배"),
            ("legacy-2", "보험사", "보험"),
        ] {
            upsert_bookkeeping_transaction_from_ingest_inner(
                &db,
                crate::models::CreateBookkeepingTransactionInput {
                    project_id: None,
                    source: BookkeepingSource::MoneyManager,
                    source_ref: Some(source_ref.to_string()),
                    merchant: merchant.to_string(),
                    description: None,
                    amount_minor: 12000,
                    currency: "KRW".to_string(),
                    spent_at: "2026-06-20".to_string(),
                    category: raw.split(" > ").next().unwrap_or(raw).to_string(),
                    note: None,
                    payment_method_kind: crate::models::BookkeepingPaymentMethodKind::Unknown,
                    payment_method_label: None,
                    payment_method_last4: None,
                    expense_kind: crate::models::BookkeepingExpenseKind::Variable,
                    recurring_expense_id: None,
                    recurring_occurrence_id: None,
                    direction: crate::models::BookkeepingDirection::Expense,
                    account: None,
                    subcategory: None,
                    category_code: None,
                    subcategory_code: None,
                    raw_category: Some(raw.to_string()),
                    spent_at_time: None,
                    confidence: None,
                    field_confidence_json: None,
                    review_reasons_json: None,
                    order_no: None,
                    payment_no: None,
                },
                "transaction.mmbak_ingested",
                "test legacy seed",
            )
            .await
            .expect("legacy seed");
        }
        let (code, _, _) = tx_codes(&db, "mm-waste-1").await;
        assert_eq!(
            code.as_deref(),
            Some("uncategorized"),
            "legacy rows collapse"
        );

        // legacy-2는 사람이 수동 오버라이드(work로) — 백필이 절대 건드리면 안 된다.
        let legacy2_id: (String,) =
            sqlx::query_as("SELECT id FROM bookkeeping_transactions WHERE source_ref='legacy-2'")
                .fetch_one(&db)
                .await
                .expect("legacy-2 id");
        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: legacy2_id.0.clone(),
                category_code: Some("work".to_string()),
                subcategory_code: None,
                reason: None,
            },
        )
        .await
        .expect("manual override");

        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");
        // mm-waste-1 하나만 백필(다른 fixture 행 mm-cafe-1은 ingest에서 이미 해석돼
        // uncategorized가 아니고, legacy-2는 오버라이드 존재로 제외).
        assert_eq!(summary.backfilled_category_count, 1);

        let (code, sub, review) = tx_codes(&db, "mm-waste-1").await;
        assert_eq!(code.as_deref(), Some("mm-30"));
        assert_eq!(sub.as_deref(), Some("mm-31"));
        assert_eq!(
            review, "needs_review",
            "backfill is a hint — review untouched"
        );

        let (code, _, _) = tx_codes(&db, "legacy-2").await;
        assert_eq!(code.as_deref(), Some("work"), "human override wins");

        // 멱등: 재임포트 시 백필 대상 없음.
        let summary2 = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        assert_eq!(summary2.backfilled_category_count, 0);
    }

    #[tokio::test]
    async fn trend_reports_mm_buckets_with_labels_after_import() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");

        let rows = bookkeeping_category_trend_inner(
            &db,
            BookkeepingCategoryTrendInput {
                project_id: None,
                from_month: "2026-06".to_string(),
                to_month: "2026-06".to_string(),
                category_code: None,
            },
        )
        .await
        .expect("trend");
        let waste = rows
            .iter()
            .find(|r| r.category_code == "mm-30")
            .expect("mm bucket in trend");
        assert_eq!(waste.label, "낭비", "label resolves from synced taxonomy");
        assert_eq!(waste.expense_minor, 12000);
        // 시드 라벨 카테고리(식비)도 사용자의 mm- 버킷으로 — food로 붕괴하지 않는다.
        let food = rows
            .iter()
            .find(|r| r.category_code == "mm-10")
            .expect("mm-10 bucket in trend");
        assert_eq!(food.label, "식비");
        assert_eq!(food.expense_minor, 5500);
        assert!(rows.iter().all(|r| r.category_code != "food"));
        // 더는 전부 미분류 버킷으로 붕괴하지 않는다.
        assert!(rows.iter().all(|r| r.category_code != "uncategorized"));
    }
}
