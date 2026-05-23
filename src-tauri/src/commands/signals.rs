use tauri::State;

use crate::commands::signal_store::SIGNAL_COLS;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    CreateSignalInput, Promotion, PromotionTarget, Quadrant, SignalStatus, WorkSignal,
};

// ── Signals: 생성 / 조회 / 분류 ──────────────────────────────────────────────

/// braindump 입력 정규화 (dedup 키 기준). 소문자 + 공백 정리.
fn normalize(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// 한 줄 braindump → 미분류 카드 생성.
/// INVARIANT #1: 항상 `unclassified`로 진입한다 (자동 분류 없음).
/// INVARIANT #3: 같은 입력은 dedup 키로 합쳐진다 (append 아님, upsert).
pub(crate) async fn insert_signal(
    db: &Db,
    input: &CreateSignalInput,
) -> Result<WorkSignal, sqlx::Error> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(sqlx::Error::Protocol("empty signal title".into()));
    }
    let dedup_key = format!("braindump:{}", normalize(title));

    // dedup: 동일 입력이 이미 있으면 touch 후 반환 (합쳐짐). 미태깅이면 project_id 보강.
    let existing = sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET updated_at = datetime('now'), project_id = COALESCE(project_id, ?2) \
         WHERE dedup_key = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&dedup_key)
    .bind(&input.project_id)
    .fetch_optional(db)
    .await?;
    if let Some(sig) = existing {
        return Ok(sig);
    }

    sqlx::query_as::<_, WorkSignal>(&format!(
        "INSERT INTO signals (id, project_id, title, source, type, quadrant, kind, dedup_key, status) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, 'braindump', 'thought', 'unclassified', ?3, ?4, 'new') \
         RETURNING {SIGNAL_COLS}"
    ))
    .bind(&input.project_id)
    .bind(title)
    .bind(input.kind)
    .bind(&dedup_key)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_signal(
    db: State<'_, Db>,
    input: CreateSignalInput,
) -> Result<WorkSignal, AppError> {
    insert_signal(db.inner(), &input)
        .await
        .map_err(|e| match e {
            sqlx::Error::Protocol(msg) => AppError::validation("signals.empty_title", msg),
            other => AppError::from(other),
        })
}

/// 매트릭스 + 미분류 카드 (Today로 승격되지 않은 active 신호).
pub(crate) async fn fetch_signals(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_for_date IS NULL AND status NOT IN ('done','archived','snoozed') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_signals(db: State<'_, Db>) -> Result<Vec<WorkSignal>, AppError> {
    Ok(fetch_signals(db.inner()).await?)
}

/// 사분면 분류 (사람 결정 레일 — INVARIANT #1). quadrant를 바꾸는 유일한 경로.
pub(crate) async fn set_quadrant(
    db: &Db,
    id: &str,
    quadrant: Quadrant,
) -> Result<WorkSignal, sqlx::Error> {
    let status = if matches!(quadrant, Quadrant::Unclassified) {
        SignalStatus::New
    } else {
        SignalStatus::Classified
    };
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET quadrant = ?2, status = ?3, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(quadrant)
    .bind(status)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn classify_signal(
    db: State<'_, Db>,
    id: String,
    quadrant: Quadrant,
) -> Result<WorkSignal, AppError> {
    Ok(set_quadrant(db.inner(), &id, quadrant).await?)
}

/// 상태 변경 (완료/보관 등). done/archive 카드 메뉴.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_status(
    db: State<'_, Db>,
    id: String,
    status: SignalStatus,
) -> Result<WorkSignal, AppError> {
    Ok(sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET status = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(status)
    .fetch_one(db.inner())
    .await?)
}

/// 미루기 (snooze). 매트릭스에서 숨고 snooze_until에 복귀 시점 기록.
#[tauri::command]
#[specta::specta]
pub async fn snooze_signal(
    db: State<'_, Db>,
    id: String,
    until: String,
) -> Result<WorkSignal, AppError> {
    Ok(sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET status = 'snoozed', snooze_until = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(&until)
    .fetch_one(db.inner())
    .await?)
}

// ── 브레인덤프 편집 / 하드 삭제 (Phase 15 #5) ──────────────────────────────────
//
// 둘 다 로컬 액션(외부 무변경) + 결정 레일 무침범(quadrant 안 건드림 — INVARIANT #1).
// 편집은 제목 변경 시 dedup 키를 새 제목 normalize로 갱신한다(INVARIANT #3: dedup 키 일관).

/// 신호 제목 편집 코어(테스트 가능). 새 제목으로 title + dedup_key(braindump:normalize) 갱신.
/// 빈 제목은 거부. quadrant/status는 건드리지 않는다(결정 레일 무침범).
pub(crate) async fn update_title(
    db: &Db,
    id: &str,
    title: &str,
) -> Result<WorkSignal, sqlx::Error> {
    let title = title.trim();
    if title.is_empty() {
        return Err(sqlx::Error::Protocol("empty signal title".into()));
    }
    let dedup_key = format!("braindump:{}", normalize(title));
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET title = ?2, dedup_key = ?3, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(title)
    .bind(&dedup_key)
    .fetch_one(db)
    .await
}

/// 브레인덤프 카드 제목 인라인 편집. dedup 키를 새 제목으로 갱신한다(INVARIANT #3).
#[tauri::command]
#[specta::specta]
pub async fn update_signal_title(
    db: State<'_, Db>,
    id: String,
    title: String,
) -> Result<WorkSignal, AppError> {
    update_title(db.inner(), &id, &title)
        .await
        .map_err(|e| match e {
            sqlx::Error::Protocol(msg) => AppError::validation("signals.empty_title", msg),
            other => AppError::from(other),
        })
}

/// 신호 하드 삭제(영구 — archive와 구분). 카드 행 자체를 DELETE한다(보관/스누즈와 달리 복원 불가).
#[tauri::command]
#[specta::specta]
pub async fn delete_signal(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    sqlx::query("DELETE FROM signals WHERE id = ?1")
        .bind(&id)
        .execute(db.inner())
        .await?;
    Ok(())
}

// ── 승격 draft (외부 = Acceptance 게이트, INVARIANT #2) ────────────────────────

/// 백로그/안건/캘린더 승격 = `Promotion` draft만 생성. 외부(Notion/Calendar)는 변경하지 않는다.
/// 실제 외부 write는 Phase 3/11에서 Acceptance를 거쳐 수행된다.
pub(crate) async fn insert_promotion_draft(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
) -> Result<Promotion, sqlx::Error> {
    // draft payload에 제목 스냅샷만 담는다 (미래 외부 write의 입력).
    let title: (String,) = sqlx::query_as("SELECT title FROM signals WHERE id = ?1")
        .bind(signal_id)
        .fetch_one(db)
        .await?;
    let payload = serde_json::json!({ "title": title.0 }).to_string();

    sqlx::query_as::<_, Promotion>(
        "INSERT INTO promotions (id, signal_id, target, status, draft_payload) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, 'draft', ?3) \
         RETURNING id, signal_id, target, status, draft_payload, created_external_id, created_at",
    )
    .bind(signal_id)
    .bind(target)
    .bind(&payload)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_promotion_draft(
    db: State<'_, Db>,
    signal_id: String,
    target: PromotionTarget,
) -> Result<Promotion, AppError> {
    Ok(insert_promotion_draft(db.inner(), &signal_id, target).await?)
}

// ── FTS 검색 ──────────────────────────────────────────────────────────────────

/// 본문/제목 전역 검색 (FTS5). 빈 쿼리는 빈 결과.
#[tauri::command]
#[specta::specta]
pub async fn search_signals(db: State<'_, Db>, query: String) -> Result<Vec<WorkSignal>, AppError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // 사용자 입력을 phrase로 감싸 FTS 연산자 오인을 막는다.
    let match_expr = format!("\"{}\"", q.replace('"', "\"\""));
    Ok(sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {} FROM signals s \
         JOIN signals_fts f ON f.rowid = s.rowid \
         WHERE signals_fts MATCH ?1 ORDER BY rank",
        SIGNAL_COLS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
    .bind(match_expr)
    .fetch_all(db.inner())
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::models::Kind;
    use crate::models::SignalSource;

    /// INVARIANT #1: 생성된 카드는 항상 unclassified로 진입한다.
    #[tokio::test]
    async fn create_signal_is_always_unclassified() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("히어로 카피 다시", Some(Kind::Work)))
            .await
            .unwrap();
        assert!(matches!(sig.quadrant, Quadrant::Unclassified));
        assert!(matches!(sig.status, SignalStatus::New));
        assert!(matches!(sig.kind, Some(Kind::Work)));
        assert!(matches!(sig.source, SignalSource::Braindump));
        assert!(sig.today_for_date.is_none());
    }

    /// INVARIANT #3: 같은 입력은 dedup으로 합쳐진다 (새 행 생성 안 함).
    #[tokio::test]
    async fn create_signal_dedups_same_input() {
        let db = fresh_db().await;
        let a = insert_signal(&db, &input("커피 원두 주문", None))
            .await
            .unwrap();
        // 공백/대소문자만 다른 동일 입력.
        let b = insert_signal(&db, &input("  커피 원두 주문  ", None))
            .await
            .unwrap();
        assert_eq!(a.id, b.id, "동일 입력은 같은 신호로 합쳐져야 함");
        let all = fetch_signals(&db).await.unwrap();
        assert_eq!(all.len(), 1, "dedup이면 행은 하나");
    }

    /// INVARIANT #1: quadrant는 명시적 classify 호출로만 바뀐다.
    #[tokio::test]
    async fn classify_is_the_only_quadrant_path() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("PR CI 빨강 추적", Some(Kind::Work)))
            .await
            .unwrap();
        let classified = set_quadrant(&db, &sig.id, Quadrant::Q1DoNow).await.unwrap();
        assert!(matches!(classified.quadrant, Quadrant::Q1DoNow));
        assert!(matches!(classified.status, SignalStatus::Classified));
    }

    /// INVARIANT #2: 외부 승격은 draft만 — 외부 무변경, status=draft.
    #[tokio::test]
    async fn promotion_draft_is_draft_only() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("백로그 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let promo = insert_promotion_draft(&db, &sig.id, PromotionTarget::NotionBacklog)
            .await
            .unwrap();
        assert!(matches!(
            promo.status,
            crate::models::PromotionStatus::Draft
        ));
        assert!(
            promo.created_external_id.is_none(),
            "외부 ID 없음(외부 무변경)"
        );
    }

    /// Phase 15 #5: 제목 편집은 title + dedup 키를 새 제목 normalize로 갱신한다(INVARIANT #3).
    #[tokio::test]
    async fn update_title_recomputes_dedup_key() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("원두 주문", Some(Kind::Personal)))
            .await
            .unwrap();
        let updated = update_title(&db, &sig.id, "  데모 슬라이드 준비  ")
            .await
            .unwrap();
        assert_eq!(updated.title, "데모 슬라이드 준비"); // trim 반영.
        assert!(matches!(updated.quadrant, Quadrant::Unclassified)); // 결정 레일 무침범.

        // dedup 키가 새 제목으로 갱신됨 → 새 제목 재캡처는 같은 행으로 합쳐진다(append 아님).
        let dup = insert_signal(&db, &input("데모 슬라이드 준비", None))
            .await
            .unwrap();
        assert_eq!(dup.id, sig.id, "새 제목 dedup 키로 합쳐져야 함");
        // 옛 제목은 더 이상 이 행과 충돌하지 않으므로 새 행이 생긴다.
        let old = insert_signal(&db, &input("원두 주문", None)).await.unwrap();
        assert_ne!(old.id, sig.id);

        // 빈 제목은 거부.
        assert!(update_title(&db, &sig.id, "   ").await.is_err());
    }

    /// Phase 15 #5: 하드 삭제는 행을 영구 제거한다(archive와 구분 — 복원 불가).
    #[tokio::test]
    async fn delete_signal_hard_removes_row() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("지울 카드", None)).await.unwrap();
        sqlx::query("DELETE FROM signals WHERE id = ?1")
            .bind(&sig.id)
            .execute(&db)
            .await
            .unwrap();
        let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM signals WHERE id = ?1")
            .bind(&sig.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(cnt.0, 0, "하드 삭제 = 행 영구 제거");
        // FTS도 트리거로 동기 삭제(삭제 후 검색 0건).
        let hits = fetch_signals(&db).await.unwrap();
        assert!(hits.is_empty());
    }

    /// FTS: 본문/제목 매칭.
    #[tokio::test]
    async fn fts_matches_title() {
        let db = fresh_db().await;
        insert_signal(&db, &input("deploy radar pipeline", Some(Kind::Work)))
            .await
            .unwrap();
        let hits = sqlx::query_as::<_, WorkSignal>(&format!(
            "SELECT {} FROM signals s JOIN signals_fts f ON f.rowid = s.rowid \
             WHERE signals_fts MATCH ?1",
            SIGNAL_COLS
                .split(", ")
                .map(|c| format!("s.{c}"))
                .collect::<Vec<_>>()
                .join(", ")
        ))
        .bind("pipeline")
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(hits.len(), 1);
    }
}
