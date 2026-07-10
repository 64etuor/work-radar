//! MoneyManager(.mmbak) 임포터 커맨드 — 임시 사본 생성 → 읽기 전용 로드 → 순수 매핑 →
//! gmail ingest와 동일한 existing-wins upsert.
//!
//! 원본 .mmbak은 Google Drive 동기화 폴더에 있으므로 **절대 직접 열지 않는다**:
//! `std::env::temp_dir` 아래 임시 사본을 뜨고(가드 drop 시 자동 삭제) 그 사본을
//! read_only로 연다 — 원본에 lock/journal 부수효과 없음.

use std::collections::HashMap;
use std::path::Path;

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingDirection, BookkeepingExpenseKind, BookkeepingPaymentMethodKind, BookkeepingSource,
    CreateBookkeepingTransactionInput, FindBookkeepingDuplicateCandidatesInput,
    ImportBookkeepingMmbakInput, ImportBookkeepingMmbakSummary,
};
use crate::moneymanager::{
    map_backup, MmAsset, MmCategory, MmCurrency, MmDirection, MmInoutcomeRow, MmRepeatRow,
    MoneyManagerBackup,
};

use super::*;

/// 크로스-소스 중복 힌트 임계값. dedup.rs 점수 체계에서 0.8 = "금액+같은 날짜" 티어
/// (상호까지 겹치면 0.95). 힌트만 — 자동 ignore는 절대 하지 않는다(사람 결정 레일).
const MMBAK_CROSS_SOURCE_DUP_MIN_SCORE: f64 = 0.8;

/// 커서 scope. 모든 mmbak 임포트가 하나의 UTIME 커서를 공유한다 — 사용자는 같은
/// Drive 동기화 백업 파일을 반복 선택하는 흐름이라 path-hash 분리보다 단순한 쪽을
/// 택했다. (다른/오래된 백업 파일을 고르면 커서 이전 행은 스킵되지만, 삭제행
/// full-scan은 커서와 무관하므로 영향 없다.)
const MMBAK_CURSOR_SCOPE: &str = "default";

/// 임포트 1회당 크로스-소스 중복 프로브(후보 스캔 쿼리) 상한. 최초 임포트는 수천 행일
/// 수 있어 상한 없이는 집계 비용이 unbounded다. 상한 초과 신규 행은 프로브 없이 그대로
/// needs_review로 임포트되고, 스킵 수는 `dup_probe_skipped_count`로 보고한다.
const MAX_DUP_PROBES_PER_IMPORT: u32 = 500;

#[tauri::command]
#[specta::specta]
pub async fn import_bookkeeping_mmbak(
    db: State<'_, Db>,
    input: ImportBookkeepingMmbakInput,
) -> Result<ImportBookkeepingMmbakSummary, AppError> {
    import_bookkeeping_mmbak_inner(db.inner(), input).await
}

struct LoadedMmbak {
    rows: Vec<MmInoutcomeRow>,
    repeats: Vec<MmRepeatRow>,
    categories: HashMap<String, MmCategory>,
    assets: HashMap<String, MmAsset>,
    currencies: HashMap<String, MmCurrency>,
}

async fn load_mmbak_copy(path: &Path) -> Result<LoadedMmbak, sqlx::Error> {
    let mut backup = MoneyManagerBackup::open_read_only(path).await?;
    let rows = backup.load_inoutcome().await?;
    let repeats = backup.load_repeat_transactions().await?;
    let categories = backup.load_categories().await?;
    let assets = backup.load_assets().await?;
    let currencies = backup.load_currencies().await?;
    backup.close().await?;
    Ok(LoadedMmbak {
        rows,
        repeats,
        categories,
        assets,
        currencies,
    })
}

pub(crate) async fn import_bookkeeping_mmbak_inner(
    db: &Db,
    input: ImportBookkeepingMmbakInput,
) -> Result<ImportBookkeepingMmbakSummary, AppError> {
    import_bookkeeping_mmbak_with_probe_cap(db, input, MAX_DUP_PROBES_PER_IMPORT).await
}

/// 프로브 상한을 주입 가능하게 분리한 본체(테스트가 작은 cap으로 상한 동작을 검증한다).
async fn import_bookkeeping_mmbak_with_probe_cap(
    db: &Db,
    input: ImportBookkeepingMmbakInput,
    max_dup_probes: u32,
) -> Result<ImportBookkeepingMmbakSummary, AppError> {
    let path_raw = clean_required(&input.path, "bookkeeping.mmbak.path")?;
    let lowered = path_raw.to_ascii_lowercase();
    if !(lowered.ends_with(".mmbak") || lowered.ends_with(".sqlite")) {
        return Err(AppError::validation(
            "bookkeeping.mmbak.extension",
            ".mmbak 또는 .sqlite 파일만 지원합니다",
        ));
    }
    let src = std::path::PathBuf::from(&path_raw);
    let meta = std::fs::metadata(&src).map_err(|_| {
        AppError::not_found(
            "bookkeeping.mmbak.not_found",
            "백업 파일을 찾을 수 없습니다",
        )
    })?;
    if !meta.is_file() {
        return Err(AppError::validation(
            "bookkeeping.mmbak.not_a_file",
            "백업 경로가 파일이 아닙니다",
        ));
    }
    if let Some(project_id) = input.project_id.as_deref() {
        ensure_project_exists(db, project_id, "bookkeeping.mmbak.project_not_found").await?;
    }

    // 임시 사본(가드가 살아 있는 동안만 존재; 함수 종료 시 자동 삭제).
    // MoneyManager 백업은 plain SQLite 단일 파일이라 -wal/-shm 사본은 불필요하다.
    let temp = tempfile::Builder::new()
        .prefix("work-radar-mmbak-")
        .suffix(".sqlite")
        .tempfile()?;
    std::fs::copy(&src, temp.path())?;

    let loaded = match load_mmbak_copy(temp.path()).await {
        Ok(loaded) => loaded,
        Err(e) => {
            // 실패 job 기록(메시지는 record_* 가 새니타이즈). 커서는 건드리지 않는다.
            record_bookkeeping_sync_status_inner(
                db,
                BookkeepingSource::MoneyManager,
                "failed",
                Some("mmbak.open_failed"),
                Some(&e.to_string()),
            )
            .await?;
            return Err(AppError::from(e));
        }
    };
    drop(temp);

    // MM 카테고리 → 로컬 taxonomy 동기화(활성 카테고리만, mm-<uid> 코드 + raw_label alias).
    // 거래 upsert **전에** 돌려야 이번 임포트의 신규 행이 ingest 시점에 실코드로 해석된다.
    let taxonomy_counts = sync_mm_taxonomy(db, &loaded.categories).await?;

    // REPEATTRANSACTION → 고정비 미러(백업이 정본). 거래 임포트와 독립적이며 커서를
    // 공유하지 않는다 — 소유권 계약은 mmbak_recurring.rs 모듈 주석 참조.
    let recurring_counts = sync_mm_recurring(
        db,
        input.project_id.as_deref(),
        &loaded.repeats,
        &loaded.categories,
        &loaded.assets,
        &loaded.currencies,
        crate::commands::routines::timezone::user_timezone(),
    )
    .await?;

    // 증분 커서: cursor_value = 지난 임포트에서 본 최대 UTIME(epoch ms). 커서 이하 UTIME
    // 행은 매핑을 건너뛴다. 단 삭제행은 UTIME이 신뢰성 있게 갱신되지 않으므로 매 임포트
    // full-scan이다(map_backup 계약).
    let cursor =
        get_bookkeeping_sync_cursor_inner(db, BookkeepingSource::MoneyManager, MMBAK_CURSOR_SCOPE)
            .await?;
    let cursor_before = cursor.map(|c| c.cursor_value);
    let min_utime = cursor_before.as_deref().and_then(|v| v.parse::<i64>().ok());

    // tz는 user_timezone SSOT 주입 — 백업 wall-clock을 이 기기의 사용자 타임존으로 해석
    // (구 Asia/Seoul 고정은 비KST 사용자의 날짜 버킷을 어긋나게 했다).
    let mapped = map_backup(
        &loaded.rows,
        &loaded.categories,
        &loaded.assets,
        &loaded.currencies,
        min_utime,
        crate::commands::routines::timezone::user_timezone(),
    );

    let mut counts = SyncCounts {
        scanned: loaded.rows.len() as u32,
        ..SyncCounts::default()
    };
    let skipped_count = mapped.skipped.len() as u32;
    let mut max_seen_utime = min_utime;
    // 실패 행 재시도 정책: 실패한 행 중 최소 UTIME을 기억해 커서를 그 직전으로 잡는다
    // (아래 커서 계산 참조) — 실패 행이 커서 뒤로 사라져 영영 스킵되는 것을 막는다.
    let mut min_failed_utime: Option<i64> = None;
    let mut dup_probes_used = 0u32;
    let mut dup_probe_skipped = 0u32;

    for tx in &mapped.transactions {
        // 매핑에서 1..=i32::MAX 보장 — 방어적 재확인만.
        let Ok(amount_minor) = i32::try_from(tx.amount_minor) else {
            counts.failed += 1;
            min_failed_utime = Some(min_failed_utime.map_or(tx.utime_ms, |m| m.min(tx.utime_ms)));
            continue;
        };
        // 존재 여부 프리플라이트는 **프로브 예산 힌트로만** 쓴다 — 코드 배정/카운트는
        // 아래 insert-if-absent의 원자적 결과가 결정한다(레이스 시 프로브 1회 낭비가 최악).
        let existed =
            bookkeeping_source_ref_exists(db, BookkeepingSource::MoneyManager, &tx.source_ref)
                .await?;

        // 크로스-소스 중복 힌트: **새 행**에만, 다른 소스(gmail/ocr/manual/csv)의 후보가
        // 임계값 이상일 때 possible_duplicate 사유를 싣는다. 힌트일 뿐 — 자동 ignore 금지.
        // 프로브는 임포트당 `max_dup_probes`회로 제한(집계 비용 bound) — 초과분은 프로브
        // 없이 임포트만 진행하고 스킵 수를 보고한다.
        let mut review_reasons_json: Option<String> = None;
        if !existed && dup_probes_used >= max_dup_probes {
            dup_probe_skipped += 1;
        } else if !existed {
            dup_probes_used += 1;
            let candidates = find_bookkeeping_duplicate_candidates_inner(
                db,
                FindBookkeepingDuplicateCandidatesInput {
                    project_id: input.project_id.clone(),
                    spent_at: tx.spent_at.clone(),
                    amount_minor,
                    merchant: Some(tx.merchant.clone()),
                    order_no: None,
                    payment_no: None,
                    source: None,
                    source_ref: None,
                    exclude_transaction_id: None,
                },
            )
            .await?;
            let cross_source_hit = candidates.iter().any(|cand| {
                cand.score >= MMBAK_CROSS_SOURCE_DUP_MIN_SCORE
                    && cand.transaction.source != BookkeepingSource::MoneyManager
                    && cand.transaction.deleted_at.is_none()
            });
            if cross_source_hit {
                review_reasons_json = Some(
                    serde_json::json!([{
                        "code": "possible_duplicate",
                        "detail": "다른 소스에 같은 금액·날짜의 거래가 있습니다 — 중복 여부 확인"
                    }])
                    .to_string(),
                );
            }
        }

        let direction = match tx.direction {
            MmDirection::Income => BookkeepingDirection::Income,
            MmDirection::Expense => BookkeepingDirection::Expense,
        };
        // 분류 코드는 alias 추측이 아니라 **직접 배정**: ctgUid → mm- 코드 쌍(1:1). 삭제/
        // 미지 카테고리(None)만 alias resolver 폴백.
        //
        // 명시 코드는 **존재 여부와 원자적인 insert-if-absent**(ON CONFLICT DO NOTHING)로만
        // 싣는다: 프리플라이트 read 기반 분기는 동시 임포트(수동+최신 임포트는 in-flight
        // 가드 밖) 레이스에서 conflict 경로의 `subcategory_code=COALESCE(existing, excluded)`
        // 가 사람이 (대분류, sub 없음)으로 오버라이드한 행에 소스 sub 코드를 채우는 창을
        // 남긴다. 삽입 실패(=행 존재)면 공유 upsert를 **명시 코드 없이** 타서 미러 필드만
        // 갱신한다(gmail이 의존하는 공유 SQL 불변). 기존 행 코드 교정은 오버라이드-가드가
        // 있는 backfill이 전담한다.
        let direct_codes = direct_mm_codes(&tx.ctg_uid, &loaded.categories);
        let build_input = |codes: Option<&(String, Option<String>)>,
                           review_reasons_json: Option<String>| {
            CreateBookkeepingTransactionInput {
                project_id: input.project_id.clone(),
                source: BookkeepingSource::MoneyManager,
                source_ref: Some(tx.source_ref.clone()),
                merchant: tx.merchant.clone(),
                description: None,
                amount_minor,
                currency: tx.currency.clone(),
                spent_at: tx.spent_at.clone(),
                category: tx.category_label.clone(),
                // ZDATA 메모. 공유 upsert의 note는 app-note-wins(existing-first COALESCE) —
                // 신규 행에는 실리고, 기존 행은 note IS NULL일 때만 채워진다.
                note: tx.note.clone(),
                // 결제수단 kind는 ingest에서 확정하지 않는다(사람이 리뷰에서 보정).
                payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
                payment_method_label: None,
                payment_method_last4: None,
                expense_kind: BookkeepingExpenseKind::Variable,
                recurring_expense_id: None,
                recurring_occurrence_id: None,
                direction,
                account: tx.account.clone(),
                subcategory: tx.subcategory_label.clone(),
                category_code: codes.map(|(cat, _)| cat.clone()),
                subcategory_code: codes.and_then(|(_, sub)| sub.clone()),
                raw_category: tx.raw_category.clone(),
                spent_at_time: tx.spent_at_time.clone(),
                confidence: None,
                field_confidence_json: None,
                review_reasons_json,
                order_no: None,
                payment_no: None,
            }
        };
        // 1) 원자적 신규 삽입(명시 코드 포함). Some(row) = 이 호출이 삽입.
        let created = match insert_bookkeeping_transaction_from_ingest_if_absent_inner(
            db,
            build_input(direct_codes.as_ref(), review_reasons_json.clone()),
            "transaction.mmbak_ingested",
            "머니매니저 백업에서 거래 유입",
        )
        .await
        {
            Ok(Some(row)) => Ok((row, true)),
            // 2) 행이 이미 있음(프리플라이트와 무관하게) → 명시 코드 없이 existing-wins
            //    upsert: review_status/deleted_at/판단 필드는 절대 건드리지 않고 미러
            //    필드(amount/merchant/spent_at 등)만 갱신 — gmail ingest와 동일 시맨틱스.
            Ok(None) => upsert_bookkeeping_transaction_from_ingest_inner(
                db,
                build_input(None, review_reasons_json.clone()),
                "transaction.mmbak_ingested",
                "머니매니저 백업에서 거래 유입",
            )
            .await
            .map(|row| (row, false)),
            Err(e) => Err(e),
        };
        match created {
            Ok((row, inserted)) => {
                if inserted {
                    counts.imported += 1;
                    counts.review_needed += 1;
                } else {
                    counts.duplicate += 1;
                }
                if max_seen_utime.is_none_or(|m| tx.utime_ms > m) {
                    max_seen_utime = Some(tx.utime_ms);
                }
                // 방향 변경 힌트: 공유 upsert는 저장된 direction을 절대 갱신하지 않는다
                // (gmail이 이 시맨틱스에 의존 — 공유 SQL 불변). 소스의 방향이 저장값과
                // 다르면 사유만 append — 방향/리뷰 상태는 절대 안 바꾼다(INVARIANT #1).
                if row.direction != direction {
                    append_review_reason_guarded(
                        db,
                        &row.id,
                        "source_direction_changed",
                        "머니매니저 백업의 수입/지출 방향이 저장된 거래와 다릅니다 — 방향 확인",
                        "transaction.source_direction_changed_flagged",
                        "원본 백업에서 방향 변경 감지됨",
                    )
                    .await?;
                }
            }
            // 개별 행 실패는 배치를 멈추지 않는다. 카운트만 — 로그에 상호/금액 미기록(PII).
            Err(_) => {
                counts.failed += 1;
                min_failed_utime =
                    Some(min_failed_utime.map_or(tx.utime_ms, |m| m.min(tx.utime_ms)));
            }
        }
    }
    if dup_probe_skipped > 0 {
        tracing::info!(
            dup_probe_skipped,
            max_dup_probes,
            "mmbak import: duplicate probing capped"
        );
    }

    // 백업에서 삭제 표시된 uid: 기존 (moneymanager, uid) 행에 source_deleted 사유를 append.
    // review_status/deleted_at은 절대 건드리지 않는다(INVARIANT #1 — 사람이 결정).
    let mut flagged_deleted = 0u32;
    for uid in &mapped.deleted_uids {
        if flag_mmbak_source_deleted(db, uid).await? {
            flagged_deleted += 1;
        }
    }

    // 백필: (1) 백업 ctgUid 기준 직접 교정 — 과거 임포트에서 시드 코드(food/shopping…)로
    // 붕괴한 행을 mm- 코드로 재지정, (2) 백업에 없는 잔여 미분류 행의 alias 재해석.
    // 오버라이드된 행은 절대 건드리지 않는다(힌트 갱신 — INVARIANT #1).
    let backfilled_category =
        backfill_mm_category_codes(db, &loaded.rows, &loaded.categories).await?;

    // note 백필: ZDATA 메모가 유입되기 전에 임포트돼 note IS NULL로 남은 행을 채운다.
    // UTIME 커서가 변경 없는 행의 upsert 자체를 건너뛰므로 conflict 경로의 COALESCE만으로는
    // 커버되지 않는다 — 커서와 무관하게 백업 전체 행을 본다.
    let backfilled_note = backfill_mm_notes(db, &loaded.rows).await?;
    if backfilled_note > 0 {
        tracing::info!(
            backfilled_note,
            "mmbak import: filled NULL notes from ZDATA"
        );
    }

    // 커서 정책: 실패 행이 있으면 커서를 (실패 행 최소 UTIME - 1)로 잡아 다음 임포트에서
    // 재시도되게 한다(임포트 내부 재시도 루프 없음 — bounded). 실패 행은 커서 필터를
    // 통과한 행이므로(UTIME > cursor_before) 커서가 뒤로 물러나지는 않는다.
    // 실패가 없으면 처리한 최대 UTIME.
    let cursor_after = match (min_failed_utime, max_seen_utime) {
        (Some(failed), _) => Some((failed - 1).to_string()),
        (None, seen) => seen.map(|v| v.to_string()),
    };
    if let Some(after) = cursor_after.as_deref() {
        upsert_bookkeeping_sync_cursor_inner(
            db,
            BookkeepingSource::MoneyManager,
            MMBAK_CURSOR_SCOPE,
            "internal_date",
            after,
        )
        .await?;
    }
    let job = record_bookkeeping_sync_job_inner(
        db,
        BookkeepingSource::MoneyManager,
        "succeeded",
        None,
        None,
        counts,
        cursor_before.as_deref(),
        cursor_after.as_deref(),
    )
    .await?;

    // 임포트 단위 감사 로그 — 카운트만(상호/금액 등 내용 미기록).
    let mut audit_tx = db.begin().await?;
    insert_audit_log_tx(
        &mut audit_tx,
        "sync_job",
        &job.id,
        "sync.mmbak_completed",
        "머니매니저 백업 임포트 완료",
        serde_json::json!({
            "source": "moneymanager",
            "scanned": counts.scanned,
            "imported": counts.imported,
            "duplicate": counts.duplicate,
            "skipped": skipped_count,
            "failed": counts.failed,
            "flaggedDeleted": flagged_deleted,
            "dupProbeSkipped": dup_probe_skipped,
            "taxonomyNodesUpserted": taxonomy_counts.nodes,
            "taxonomyAliasesUpserted": taxonomy_counts.aliases,
            "backfilledCategory": backfilled_category,
            "backfilledNote": backfilled_note,
            "recurringUpserted": recurring_counts.upserted,
            "recurringArchived": recurring_counts.archived,
            "recurringSkipped": recurring_counts.skipped,
        }),
    )
    .await?;
    audit_tx.commit().await?;

    Ok(ImportBookkeepingMmbakSummary {
        scanned_count: counts.scanned,
        imported_count: counts.imported,
        duplicate_count: counts.duplicate,
        skipped_count,
        failed_count: counts.failed,
        flagged_deleted_count: flagged_deleted,
        dup_probe_skipped_count: dup_probe_skipped,
        backfilled_category_count: backfilled_category,
        recurring_upserted_count: recurring_counts.upserted,
        recurring_archived_count: recurring_counts.archived,
        recurring_skipped_count: recurring_counts.skipped,
        cursor_after,
    })
}

/// note 백필 본체: 백업의 (uid → ZDATA 메모) 중, 앱 쪽 note가 **아직 NULL인** moneymanager
/// 행에만 메모를 채운다. 가드(`note IS NULL`)를 UPDATE의 WHERE에 반복해 select와 update
/// 사이에 사용자가 note를 쓰더라도(TOCTOU) 절대 덮지 않는다 —
/// `mmbak_taxonomy.rs::apply_backfill_update`와 같은 패턴. 삭제 표시(IS_DEL) 행은 비대상.
async fn backfill_mm_notes(db: &Db, rows: &[MmInoutcomeRow]) -> Result<u32, AppError> {
    let mut notes: HashMap<&str, &str> = HashMap::new();
    for row in rows {
        if row.is_del != 0 {
            continue;
        }
        let uid = row.uid.trim();
        let note = row.zdata.trim();
        if uid.is_empty() || note.is_empty() {
            continue;
        }
        notes.insert(uid, note);
    }
    if notes.is_empty() {
        return Ok(0);
    }
    let candidates: Vec<(String,)> = sqlx::query_as(
        "SELECT source_ref FROM bookkeeping_transactions \
         WHERE source = 'moneymanager' AND source_ref IS NOT NULL \
           AND note IS NULL AND deleted_at IS NULL",
    )
    .fetch_all(db)
    .await?;
    let mut filled = 0u32;
    for (source_ref,) in candidates {
        let Some(note) = notes.get(source_ref.as_str()) else {
            continue;
        };
        let result = sqlx::query(
            "UPDATE bookkeeping_transactions \
             SET note = ?2, updated_at = datetime('now') \
             WHERE source = 'moneymanager' AND source_ref = ?1 \
               AND note IS NULL AND deleted_at IS NULL",
        )
        .bind(&source_ref)
        .bind(note)
        .execute(db)
        .await?;
        if result.rows_affected() > 0 {
            filled += 1;
        }
    }
    Ok(filled)
}

/// 백업에서 삭제된 uid에 대해 기존 non-deleted 행에 `source_deleted` 리뷰 사유를 1회 append.
/// review_status/deleted_at은 변경하지 않는다 — 사유는 힌트, 결정은 사람.
async fn flag_mmbak_source_deleted(db: &Db, uid: &str) -> Result<bool, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM bookkeeping_transactions \
         WHERE source = 'moneymanager' AND source_ref = ?1 AND deleted_at IS NULL LIMIT 1",
    )
    .bind(uid)
    .fetch_optional(db)
    .await?;
    let Some((id,)) = row else {
        return Ok(false);
    };
    append_review_reason_guarded(
        db,
        &id,
        "source_deleted",
        "머니매니저 백업에서 삭제된 거래 — 원장 유지 여부 확인",
        "transaction.source_deleted_flagged",
        "원본 백업에서 삭제 표시됨",
    )
    .await
}

/// `review_reasons_json`에 `code` 사유를 **1회** append(멱등). read-modify-write 전체가
/// 단일 트랜잭션 안에서 일어난다 — SQLite single-writer라 tx 밖 읽기처럼 동시 갱신을
/// 덮어쓰는 창이 없다. review_status/deleted_at/방향은 절대 건드리지 않는다.
async fn append_review_reason_guarded(
    db: &Db,
    transaction_id: &str,
    code: &str,
    detail: &str,
    audit_action: &str,
    audit_summary: &str,
) -> Result<bool, AppError> {
    let mut tx = db.begin().await?;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT review_reasons_json FROM bookkeeping_transactions \
         WHERE id = ?1 AND deleted_at IS NULL",
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((reasons_raw,)) = row else {
        return Ok(false);
    };
    let mut reasons: Vec<serde_json::Value> =
        serde_json::from_str(&reasons_raw).unwrap_or_default();
    if reasons
        .iter()
        .any(|r| r.get("code").and_then(|c| c.as_str()) == Some(code))
    {
        return Ok(false);
    }
    reasons.push(serde_json::json!({ "code": code, "detail": detail }));
    let updated_json = serde_json::Value::Array(reasons).to_string();
    sqlx::query(
        "UPDATE bookkeeping_transactions \
         SET review_reasons_json = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(transaction_id)
    .bind(&updated_json)
    .execute(&mut *tx)
    .await?;
    insert_audit_log_tx(
        &mut tx,
        "transaction",
        transaction_id,
        audit_action,
        audit_summary,
        serde_json::json!({ "source": "moneymanager", "reason": code }),
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BookkeepingReviewStatus, OverrideBookkeepingCategoryInput};
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

    /// income 1 + expense 1 + transfer 1 + deleted 1 짜리 .mmbak 픽스처.
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
            "INSERT INTO ASSETS VALUES ('a1','하나카드','g1')",
            "INSERT INTO CURRENCY VALUES ('KRW_KRW','KRW',0)",
            "INSERT INTO INOUTCOME VALUES ('mm-exp-1','a1','11','스타벅스',0,'2026-06-15','1','5500.0','','','','',0,100,'KRW_KRW','맥주, 아몬드')",
            "INSERT INTO INOUTCOME VALUES ('mm-inc-1','a1','20','회사',0,'2026-06-01','0','3000000.0','','','','',0,200,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('mm-xfer-1','a1','10','이체',0,'2026-06-10','1','10000.0','a2','','','',0,300,'KRW_KRW','')",
            "INSERT INTO INOUTCOME VALUES ('mm-del-1','a1','10','지워짐',0,'2026-06-09','1','9000.0','','','','',1,50,'KRW_KRW','')",
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

    async fn mm_rows(db: &Db) -> Vec<crate::models::BookkeepingTransaction> {
        sqlx::query_as::<_, crate::models::BookkeepingTransaction>(&format!(
            "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions \
             WHERE source = 'moneymanager' ORDER BY source_ref ASC"
        ))
        .fetch_all(db)
        .await
        .expect("mm rows")
    }

    #[tokio::test]
    async fn mmbak_import_lands_needs_review_rows_and_records_job_and_cursor() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");
        assert_eq!(summary.scanned_count, 4);
        assert_eq!(summary.imported_count, 2);
        assert_eq!(summary.duplicate_count, 0);
        assert_eq!(summary.skipped_count, 1); // transfer
        assert_eq!(summary.failed_count, 0);
        assert_eq!(summary.flagged_deleted_count, 0); // 삭제 uid에 대응하는 기존 행 없음
        assert_eq!(summary.cursor_after.as_deref(), Some("200"));

        let rows = mm_rows(&db).await;
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert_eq!(row.source, BookkeepingSource::MoneyManager);
            assert_eq!(row.review_status, BookkeepingReviewStatus::NeedsReview);
        }
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense row");
        assert_eq!(expense.merchant, "스타벅스");
        assert_eq!(expense.amount_minor, 5500);
        assert_eq!(expense.category, "식비");
        assert_eq!(expense.subcategory.as_deref(), Some("카페"));
        assert_eq!(expense.raw_category.as_deref(), Some("식비 > 카페"));
        assert_eq!(expense.account.as_deref(), Some("하나카드"));
        assert_eq!(expense.direction, BookkeepingDirection::Expense);
        // ZDATA 메모가 note로 유입.
        assert_eq!(expense.note.as_deref(), Some("맥주, 아몬드"));
        let income = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-inc-1"))
            .expect("income row");
        assert_eq!(income.note, None, "empty ZDATA maps to NULL note");

        // sync job + cursor 기록.
        let job: (String, u32, u32, Option<String>) = sqlx::query_as(
            "SELECT status, scanned_count, imported_count, cursor_after \
             FROM bookkeeping_sync_jobs WHERE source = 'moneymanager' \
             ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_one(&db)
        .await
        .expect("job row");
        assert_eq!(job.0, "succeeded");
        assert_eq!(job.1, 4);
        assert_eq!(job.2, 2);
        assert_eq!(job.3.as_deref(), Some("200"));

        let cursors = list_bookkeeping_sync_cursors_inner(&db)
            .await
            .expect("cursors");
        assert_eq!(cursors.len(), 1);
        assert_eq!(cursors[0].source, BookkeepingSource::MoneyManager);
        assert_eq!(cursors[0].scope_key, "default");
        assert_eq!(cursors[0].cursor_kind, "internal_date");
        assert_eq!(cursors[0].cursor_value, "200");
    }

    #[tokio::test]
    async fn mmbak_cursor_skips_unchanged_rows_on_reimport() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        let second = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("second import");
        // UTIME 커서 이하 행은 매핑 자체를 스킵(이체 1 + 커서 스킵 3 → 삭제행 제외 3? 아님:
        // 삭제행은 커서 무관 full-scan, 나머지 3행이 커서 이하 → 전부 skipped).
        assert_eq!(second.imported_count, 0);
        assert_eq!(second.duplicate_count, 0);
        assert_eq!(second.skipped_count, 3);
        assert_eq!(mm_rows(&db).await.len(), 2);
    }

    #[tokio::test]
    async fn mmbak_reimport_is_existing_wins_and_preserves_user_review() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        let rows = mm_rows(&db).await;
        let expense_id = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense")
            .id
            .clone();
        update_bookkeeping_review_status_inner(&db, &expense_id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve");

        // 원본 앱에서 같은 거래가 수정됨(UTIME 증가 + 상호 변경) → 재임포트는 미러 필드만
        // 갱신하고 review_status는 보존해야 한다.
        exec_fixture(
            &path,
            "UPDATE INOUTCOME SET ZCONTENT='스타벅스 강남점', UTIME=999 WHERE uid='mm-exp-1'",
        )
        .await;
        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        assert_eq!(summary.duplicate_count, 1);
        assert_eq!(summary.imported_count, 0);
        assert_eq!(summary.cursor_after.as_deref(), Some("999"));

        let rows = mm_rows(&db).await;
        assert_eq!(rows.len(), 2, "no duplicate row created");
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        assert_eq!(expense.id, expense_id);
        assert_eq!(expense.merchant, "스타벅스 강남점"); // 미러 필드는 갱신
        assert_eq!(
            expense.review_status,
            BookkeepingReviewStatus::Approved,
            "existing-wins: user review preserved"
        );
    }

    #[tokio::test]
    async fn mmbak_reimport_preserves_app_edited_note() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        // 사용자가 앱에서 note를 수정.
        sqlx::query(
            "UPDATE bookkeeping_transactions SET note='앱에서 쓴 메모' \
             WHERE source='moneymanager' AND source_ref='mm-exp-1'",
        )
        .execute(&db)
        .await
        .expect("app-side note edit");

        // 원본 앱에서 메모가 바뀜(UTIME 증가 → 재-upsert 대상) — app-note-wins라
        // 저장된 note를 덮지 않는다.
        exec_fixture(
            &path,
            "UPDATE INOUTCOME SET ZDATA='바뀐 원본 메모', UTIME=999 WHERE uid='mm-exp-1'",
        )
        .await;
        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        let rows = mm_rows(&db).await;
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        assert_eq!(
            expense.note.as_deref(),
            Some("앱에서 쓴 메모"),
            "app-note-wins: re-import must not clobber app-edited note"
        );
    }

    #[tokio::test]
    async fn mmbak_backfills_null_note_even_when_cursor_skips_row() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        let rows = mm_rows(&db).await;
        let income = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-inc-1"))
            .expect("income");
        assert_eq!(income.note, None);

        // ZDATA만 채워지고 UTIME은 그대로(200) → 커서가 upsert를 건너뛰는 케이스.
        // 과거(메모 미유입 시절) 임포트된 행 시뮬레이션 — 백필이 채워야 한다.
        exec_fixture(
            &path,
            "UPDATE INOUTCOME SET ZDATA=' 나중에 단 메모 ' WHERE uid='mm-inc-1'",
        )
        .await;
        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        assert_eq!(summary.imported_count, 0, "cursor skips unchanged rows");

        let rows = mm_rows(&db).await;
        let income = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-inc-1"))
            .expect("income");
        assert_eq!(
            income.note.as_deref(),
            Some("나중에 단 메모"),
            "NULL-note backfill fills from trimmed ZDATA"
        );
        // 이미 note가 있는 행(mm-exp-1)은 백필 비대상 — 원래 메모 유지.
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        assert_eq!(expense.note.as_deref(), Some("맥주, 아몬드"));
    }

    #[tokio::test]
    async fn mmbak_flags_cross_source_possible_duplicate() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 같은 날짜·금액·상호의 gmail 행 선주입 → mm 신규 행에 possible_duplicate 힌트.
        upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            CreateBookkeepingTransactionInput {
                project_id: None,
                source: BookkeepingSource::Gmail,
                source_ref: Some("gmail-msg-1".to_string()),
                merchant: "스타벅스".to_string(),
                description: None,
                amount_minor: 5500,
                currency: "KRW".to_string(),
                spent_at: "2026-06-15".to_string(),
                category: "식비".to_string(),
                note: None,
                payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
                payment_method_label: None,
                payment_method_last4: None,
                expense_kind: BookkeepingExpenseKind::Variable,
                recurring_expense_id: None,
                recurring_occurrence_id: None,
                direction: BookkeepingDirection::Expense,
                account: None,
                subcategory: None,
                category_code: None,
                subcategory_code: None,
                raw_category: None,
                spent_at_time: None,
                confidence: None,
                field_confidence_json: None,
                review_reasons_json: None,
                order_no: None,
                payment_no: None,
            },
            "transaction.gmail_ingested",
            "test seed",
        )
        .await
        .expect("seed gmail row");

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");
        let rows = mm_rows(&db).await;
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        let reasons: Vec<serde_json::Value> =
            serde_json::from_str(&expense.review_reasons_json).expect("reasons json");
        assert!(
            reasons
                .iter()
                .any(|r| r.get("code").and_then(|c| c.as_str()) == Some("possible_duplicate")),
            "cross-source duplicate hint expected, got {reasons:?}"
        );
        // 힌트만 — 자동 ignore 금지.
        assert_eq!(expense.review_status, BookkeepingReviewStatus::NeedsReview);
    }

    #[tokio::test]
    async fn mmbak_deleted_uid_flags_existing_row_without_touching_review_status() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        let rows = mm_rows(&db).await;
        let expense_id = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense")
            .id
            .clone();
        update_bookkeeping_review_status_inner(&db, &expense_id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve");

        // 원본 앱에서 삭제됨 → source_deleted 사유만 append, review_status 불변.
        exec_fixture(&path, "UPDATE INOUTCOME SET IS_DEL=1 WHERE uid='mm-exp-1'").await;
        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        assert_eq!(summary.flagged_deleted_count, 1);

        let rows = mm_rows(&db).await;
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        let reasons: Vec<serde_json::Value> =
            serde_json::from_str(&expense.review_reasons_json).expect("reasons json");
        assert!(reasons
            .iter()
            .any(|r| r.get("code").and_then(|c| c.as_str()) == Some("source_deleted")));
        assert_eq!(
            expense.review_status,
            BookkeepingReviewStatus::Approved,
            "flagging must not touch review_status"
        );

        // 같은 삭제를 다시 봐도 사유는 1회만 append(멱등).
        let summary2 = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("third import");
        assert_eq!(summary2.flagged_deleted_count, 0);
    }

    /// 백업에 REPEATTRANSACTION이 있으면 거래 임포트와 같은 패스에서 고정비가 미러된다.
    /// (다른 mmbak 픽스처엔 이 테이블이 없어 recurring 카운트가 0 — graceful degrade.)
    #[tokio::test]
    async fn mmbak_import_mirrors_recurring_rules_and_reports_counts() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;
        use crate::moneymanager::{REPEAT_TRANSACTION_COLUMNS, REPEAT_TRANSACTION_DDL};
        exec_fixture(&path, REPEAT_TRANSACTION_DDL).await;
        // 지출 월반복 1건 + 수입 반복 1건(스킵 대상). USETIME=2026-06-23, NEXT_DATE=2026-07-22 KST.
        for values in [
            "('rep-1',0,1782190161300,0,0,1784714037425,1,1,'a1','','11','KRW_KRW',100000.0,'주택청약','청약(49)')",
            "('rep-inc',0,1782190161300,0,0,1784714037425,0,1,'a1','','20','KRW_KRW',3000000.0,'월급','회사')",
        ] {
            exec_fixture(
                &path,
                &format!("INSERT INTO REPEATTRANSACTION {REPEAT_TRANSACTION_COLUMNS} VALUES {values}"),
            )
            .await;
        }

        let summary = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("import");
        assert_eq!(summary.recurring_upserted_count, 1);
        assert_eq!(summary.recurring_archived_count, 0);
        assert_eq!(
            summary.recurring_skipped_count, 1,
            "수입 반복은 고정비 아님"
        );
        // 거래 임포트는 영향받지 않는다.
        assert_eq!(summary.imported_count, 2);

        let (name, amount, day, month, kind): (String, i64, i64, String, String) = sqlx::query_as(
            "SELECT name, amount_minor, schedule_day, start_month, expense_kind \
             FROM bookkeeping_recurring_expenses WHERE source = 'moneymanager'",
        )
        .fetch_one(&db)
        .await
        .expect("mirrored rule");
        assert_eq!(name, "주택청약");
        assert_eq!(amount, 100_000);
        assert_eq!(day, 22);
        assert_eq!(month, "2026-06");
        assert_eq!(kind, "fixed");

        // 재임포트는 멱등 — 규칙이 늘지 않는다.
        let again = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");
        assert_eq!(again.recurring_upserted_count, 0);
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM bookkeeping_recurring_expenses")
            .fetch_one(&db)
            .await
            .expect("count");
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn mmbak_rejects_wrong_extension_and_missing_file() {
        let db = pool().await;
        let err = import_bookkeeping_mmbak_inner(
            &db,
            ImportBookkeepingMmbakInput {
                project_id: None,
                path: "/tmp/backup.txt".to_string(),
            },
        )
        .await
        .expect_err("extension rejected");
        assert!(err.to_string().contains(".mmbak"));

        let err = import_bookkeeping_mmbak_inner(
            &db,
            ImportBookkeepingMmbakInput {
                project_id: None,
                path: "/nonexistent/backup.mmbak".to_string(),
            },
        )
        .await
        .expect_err("missing file rejected");
        assert!(err.to_string().contains("찾을 수 없습니다"));
    }

    #[tokio::test]
    async fn mmbak_failed_row_holds_cursor_for_retry() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // 앱 DB 쪽 poison 트리거로 특정 source_ref의 upsert를 결정론적으로 실패시킨다
        // (실제 Err 경로 그대로 통과). exp(utime 100)는 실패, inc(utime 200)는 성공.
        sqlx::query(
            "CREATE TRIGGER poison_mm_exp BEFORE INSERT ON bookkeeping_transactions \
             WHEN NEW.source_ref = 'mm-exp-1' BEGIN SELECT RAISE(ABORT, 'poison'); END",
        )
        .execute(&db)
        .await
        .expect("create poison trigger");

        let first = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");
        assert_eq!(first.failed_count, 1);
        assert_eq!(first.imported_count, 1); // inc만 성공
                                             // 커서는 실패 행(min UTIME 100)의 직전으로 — 성공한 200을 넘겨선 안 된다.
        assert_eq!(first.cursor_after.as_deref(), Some("99"));

        // 원인 해소(트리거 제거) 후 재실행: 실패했던 행이 재시도되어 임포트된다.
        sqlx::query("DROP TRIGGER poison_mm_exp")
            .execute(&db)
            .await
            .expect("drop poison trigger");
        let second = import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("second import");
        assert_eq!(second.failed_count, 0);
        assert_eq!(second.imported_count, 1); // exp 신규 임포트
        assert_eq!(second.duplicate_count, 1); // inc는 재처리(커서 99 < 200) → 기존행
        assert_eq!(second.cursor_after.as_deref(), Some("200"));
        assert_eq!(mm_rows(&db).await.len(), 2);
    }

    #[tokio::test]
    async fn mmbak_direction_change_flags_hint_without_flipping_direction() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("first import");

        // 원본 앱에서 지출→수입으로 방향 변경(DO_TYPE 1→0) + UTIME 증가.
        exec_fixture(
            &path,
            "UPDATE INOUTCOME SET DO_TYPE='0', UTIME=999 WHERE uid='mm-exp-1'",
        )
        .await;
        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("re-import");

        let rows = mm_rows(&db).await;
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        // 방향은 절대 안 뒤집는다(공유 upsert가 저장값 유지) — 사유만 append.
        assert_eq!(expense.direction, BookkeepingDirection::Expense);
        assert_eq!(expense.review_status, BookkeepingReviewStatus::NeedsReview);
        let reasons: Vec<serde_json::Value> =
            serde_json::from_str(&expense.review_reasons_json).expect("reasons json");
        assert!(
            reasons.iter().any(|r| {
                r.get("code").and_then(|c| c.as_str()) == Some("source_direction_changed")
            }),
            "direction-change hint expected, got {reasons:?}"
        );

        // 멱등: 같은 상태로 한 번 더 돌려도 사유는 1개만.
        exec_fixture(
            &path,
            "UPDATE INOUTCOME SET UTIME=1000 WHERE uid='mm-exp-1'",
        )
        .await;
        import_bookkeeping_mmbak_inner(&db, mmbak_input(&path))
            .await
            .expect("third import");
        let rows = mm_rows(&db).await;
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        let reasons: Vec<serde_json::Value> =
            serde_json::from_str(&expense.review_reasons_json).expect("reasons json");
        let count = reasons
            .iter()
            .filter(|r| r.get("code").and_then(|c| c.as_str()) == Some("source_direction_changed"))
            .count();
        assert_eq!(count, 1, "guarded append must be idempotent");
    }

    #[tokio::test]
    async fn mmbak_dup_probe_cap_skips_probing_but_still_imports() {
        let db = pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = fixture_mmbak(&dir).await;

        // exp와 정확히 겹치는 gmail 행이 있어도 cap=0이면 프로브 자체를 건너뛴다.
        upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            CreateBookkeepingTransactionInput {
                project_id: None,
                source: BookkeepingSource::Gmail,
                source_ref: Some("gmail-msg-1".to_string()),
                merchant: "스타벅스".to_string(),
                description: None,
                amount_minor: 5500,
                currency: "KRW".to_string(),
                spent_at: "2026-06-15".to_string(),
                category: "식비".to_string(),
                note: None,
                payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
                payment_method_label: None,
                payment_method_last4: None,
                expense_kind: BookkeepingExpenseKind::Variable,
                recurring_expense_id: None,
                recurring_occurrence_id: None,
                direction: BookkeepingDirection::Expense,
                account: None,
                subcategory: None,
                category_code: None,
                subcategory_code: None,
                raw_category: None,
                spent_at_time: None,
                confidence: None,
                field_confidence_json: None,
                review_reasons_json: None,
                order_no: None,
                payment_no: None,
            },
            "transaction.gmail_ingested",
            "test seed",
        )
        .await
        .expect("seed gmail row");

        let summary = import_bookkeeping_mmbak_with_probe_cap(&db, mmbak_input(&path), 0)
            .await
            .expect("import with cap 0");
        // 신규 2행(exp/inc) 모두 프로브 스킵 — 그래도 임포트는 정상.
        assert_eq!(summary.imported_count, 2);
        assert_eq!(summary.dup_probe_skipped_count, 2);

        let rows = mm_rows(&db).await;
        let expense = rows
            .iter()
            .find(|r| r.source_ref.as_deref() == Some("mm-exp-1"))
            .expect("expense");
        let reasons: Vec<serde_json::Value> =
            serde_json::from_str(&expense.review_reasons_json).expect("reasons json");
        assert!(
            !reasons
                .iter()
                .any(|r| r.get("code").and_then(|c| c.as_str()) == Some("possible_duplicate")),
            "probe capped: no possible_duplicate hint expected"
        );
        assert_eq!(expense.review_status, BookkeepingReviewStatus::NeedsReview);
    }

    fn race_ingest_input(
        source_ref: &str,
        category_code: Option<&str>,
        subcategory_code: Option<&str>,
    ) -> CreateBookkeepingTransactionInput {
        CreateBookkeepingTransactionInput {
            project_id: None,
            source: BookkeepingSource::MoneyManager,
            source_ref: Some(source_ref.to_string()),
            merchant: "편의점담배".to_string(),
            description: None,
            amount_minor: 12000,
            currency: "KRW".to_string(),
            spent_at: "2026-06-20".to_string(),
            category: "낭비".to_string(),
            note: None,
            payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Variable,
            recurring_expense_id: None,
            recurring_occurrence_id: None,
            direction: BookkeepingDirection::Expense,
            account: None,
            subcategory: None,
            category_code: category_code.map(str::to_string),
            subcategory_code: subcategory_code.map(str::to_string),
            raw_category: Some("낭비 > 담배".to_string()),
            spent_at_time: None,
            confidence: None,
            field_confidence_json: None,
            review_reasons_json: None,
            order_no: None,
            payment_no: None,
        }
    }

    /// 동시 임포트 레이스 재현: 다른 임포트가 행을 먼저 삽입하고 사람이 (shopping, sub 없음)
    /// 으로 오버라이드한 뒤, 이 임포트가 "신규"라 믿고 명시 mm- 코드를 실어 삽입을 시도한다.
    /// insert-if-absent는 존재 판정과 원자적(ON CONFLICT DO NOTHING)이라 아무것도 쓰지
    /// 않는다 — 프리플라이트-읽기 기반 분기가 남기던 COALESCE sub-누수 창 자체가 없다.
    #[tokio::test]
    async fn mmbak_atomic_insert_never_leaks_source_codes_into_existing_overridden_row() {
        let db = pool().await;

        // 경쟁 임포트가 먼저 삽입한 행(+ 사람 오버라이드: shopping, sub 없음).
        let seeded = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            race_ingest_input("race-uid-1", None, None),
            "transaction.mmbak_ingested",
            "경쟁 임포트 시뮬레이션",
        )
        .await
        .expect("seed row");
        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: seeded.id.clone(),
                category_code: Some("shopping".to_string()),
                subcategory_code: None,
                reason: None,
            },
        )
        .await
        .expect("manual override");

        // "신규"라 믿는 쪽의 명시-코드 삽입 시도 → conflict → DO NOTHING.
        let inserted = insert_bookkeeping_transaction_from_ingest_if_absent_inner(
            &db,
            race_ingest_input("race-uid-1", Some("mm-30"), Some("mm-31")),
            "transaction.mmbak_ingested",
            "레이스 삽입 시도",
        )
        .await
        .expect("atomic insert-if-absent");
        assert!(inserted.is_none(), "existing row → insert must be a no-op");

        // 임포터의 폴백(명시 코드 없는 공유 upsert)까지 거쳐도 사람 판단은 그대로다.
        upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            race_ingest_input("race-uid-1", None, None),
            "transaction.mmbak_ingested",
            "폴백 미러 갱신",
        )
        .await
        .expect("codeless fallback upsert");

        let (code, sub): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT category_code, subcategory_code FROM bookkeeping_transactions \
             WHERE source='moneymanager' AND source_ref='race-uid-1'",
        )
        .fetch_one(&db)
        .await
        .expect("row");
        assert_eq!(code.as_deref(), Some("shopping"), "human override wins");
        assert_eq!(sub, None, "source subcategory must not leak under override");
    }
}
