use tauri::State;

use crate::commands::nav::{get_config, set_config};
use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    CreateSignalInput, Kind, LifeWheelTagConfig, Promotion, PromotionTarget, Quadrant,
    SignalStatus, WorkSignal,
};

// ── Signals: 생성 / 조회 / 분류 ──────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn create_signal(
    db: State<'_, Db>,
    input: CreateSignalInput,
) -> Result<WorkSignal, AppError> {
    signal_store::insert_signal(db.inner(), &input)
        .await
        .map_err(|e| match e {
            sqlx::Error::Protocol(msg) => AppError::validation("signals.empty_title", msg),
            other => AppError::from(other),
        })
}

#[tauri::command]
#[specta::specta]
pub async fn list_signals(db: State<'_, Db>) -> Result<Vec<WorkSignal>, AppError> {
    Ok(signal_store::fetch_signals(db.inner()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn classify_signal(
    db: State<'_, Db>,
    id: String,
    quadrant: Quadrant,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::set_quadrant(db.inner(), &id, quadrant).await?)
}

/// 상태 변경 (완료/보관 등). done/archive 카드 메뉴.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_status(
    db: State<'_, Db>,
    id: String,
    status: SignalStatus,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::set_signal_status(db.inner(), &id, status).await?)
}

/// 미루기 (snooze). 매트릭스에서 숨고 snooze_until에 복귀 시점 기록.
#[tauri::command]
#[specta::specta]
pub async fn snooze_signal(
    db: State<'_, Db>,
    id: String,
    until: String,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::snooze_signal(db.inner(), &id, &until).await?)
}

// ── 브레인덤프 편집 / 하드 삭제 (Phase 15 #5) ──────────────────────────────────
//
// 둘 다 로컬 액션(외부 무변경) + 결정 레일 무침범(quadrant 안 건드림 — INVARIANT #1).
// 편집은 제목 변경 시 dedup 키를 새 제목 normalize로 갱신한다(INVARIANT #3: dedup 키 일관).

/// 브레인덤프 카드 제목 인라인 편집. dedup 키를 새 제목으로 갱신한다(INVARIANT #3).
#[tauri::command]
#[specta::specta]
pub async fn update_signal_title(
    db: State<'_, Db>,
    id: String,
    title: String,
) -> Result<WorkSignal, AppError> {
    signal_store::update_title(db.inner(), &id, &title)
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
    signal_store::delete_signal_row(db.inner(), &id).await?;
    Ok(())
}

/// 개인/업무 분류 수정. 사람의 manual override이며 quadrant 결정 레일과 독립이다.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_kind(
    db: State<'_, Db>,
    id: String,
    kind: Option<Kind>,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::set_signal_kind(db.inner(), &id, kind).await?)
}

const KEY_LIFE_WHEEL_TAGS: &str = "life_wheel.tags";

// 정본 = DESIGN.md §Colors. green family(work/health/environment) +
// blue family(studies/friends/finances) + warm family(recreation/romance/family) +
// neutral(other). 10개여도 패밀리 3개로 묶여 시각적 잡음을 줄임.
fn default_life_wheel_tags() -> Vec<LifeWheelTagConfig> {
    [
        ("health", "건강", "#5a8a78"),      // sage (green family)
        ("work", "업무", "#003c33"),        // Deep Enterprise Green
        ("studies", "학습", "#1863dc"),     // Action Blue
        ("environment", "환경", "#8aa67a"), // pale herb (green family)
        ("recreation", "휴식", "#ff7759"),  // Coral
        ("romance", "연애", "#ffad9b"),     // Soft Coral
        ("family", "가족", "#a89175"),      // warm stone
        ("friends", "친구", "#4c6ee6"),     // Focus Blue
        ("finances", "재정", "#071829"),    // Dark Navy
        ("other", "기타", "#75758a"),       // Slate
    ]
    .into_iter()
    .map(|(id, label, color)| LifeWheelTagConfig {
        id: id.to_string(),
        label: label.to_string(),
        color: color.to_string(),
        built_in: true,
        enabled: true,
    })
    .collect()
}

fn is_builtin_area_key(id: &str) -> bool {
    matches!(
        id,
        "health"
            | "work"
            | "studies"
            | "environment"
            | "recreation"
            | "romance"
            | "family"
            | "friends"
            | "finances"
            | "other"
    )
}

fn normalize_tag_id(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn valid_hex_color(color: &str) -> bool {
    let bytes = color.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn normalize_life_wheel_tags(
    tags: Vec<LifeWheelTagConfig>,
) -> Result<Vec<LifeWheelTagConfig>, (&'static str, &'static str)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for tag in tags {
        let id = normalize_tag_id(&tag.id);
        if id.is_empty() {
            return Err(("life_wheel.invalid_id", "태그 key는 비어 있을 수 없습니다"));
        }
        if !seen.insert(id.clone()) {
            return Err(("life_wheel.duplicate_id", "태그 key가 중복되었습니다"));
        }
        let label = tag.label.trim().to_string();
        if label.is_empty() {
            return Err((
                "life_wheel.empty_label",
                "태그 이름은 비어 있을 수 없습니다",
            ));
        }
        if !valid_hex_color(&tag.color) {
            return Err((
                "life_wheel.invalid_color",
                "색상은 #RRGGBB 형식이어야 합니다",
            ));
        }
        out.push(LifeWheelTagConfig {
            built_in: is_builtin_area_key(&id),
            id,
            label,
            color: tag.color,
            enabled: tag.enabled,
        });
    }
    if out.iter().all(|tag| !tag.enabled) {
        return Err((
            "life_wheel.no_enabled_tags",
            "최소 하나 이상의 Life Wheel 태그가 필요합니다",
        ));
    }
    Ok(out)
}

async fn current_life_wheel_tags(db: &Db) -> Result<Vec<LifeWheelTagConfig>, AppError> {
    let Some(raw) = get_config(db, KEY_LIFE_WHEEL_TAGS).await? else {
        return Ok(default_life_wheel_tags());
    };
    match serde_json::from_str::<Vec<LifeWheelTagConfig>>(&raw) {
        Ok(tags) => normalize_life_wheel_tags(tags)
            .map_err(|(code, message)| AppError::validation(code, message)),
        Err(_) => Ok(default_life_wheel_tags()),
    }
}

/// Life Wheel 팔레트 설정 조회. 기본 taxonomy는 유지하되 사용자가 색/노출/커스텀 태그를 편집한다.
#[tauri::command]
#[specta::specta]
pub async fn get_life_wheel_tags(db: State<'_, Db>) -> Result<Vec<LifeWheelTagConfig>, AppError> {
    current_life_wheel_tags(db.inner()).await
}

/// Life Wheel 팔레트 설정 저장. 비밀이 아닌 per-machine UI 설정이므로 app_config에 JSON 저장한다.
#[tauri::command]
#[specta::specta]
pub async fn set_life_wheel_tags(
    db: State<'_, Db>,
    tags: Vec<LifeWheelTagConfig>,
) -> Result<Vec<LifeWheelTagConfig>, AppError> {
    let normalized = normalize_life_wheel_tags(tags)
        .map_err(|(code, message)| AppError::validation(code, message))?;
    let raw = serde_json::to_string(&normalized)
        .map_err(|e| AppError::unexpected("life_wheel.serialize", e.to_string()))?;
    set_config(db.inner(), KEY_LIFE_WHEEL_TAGS, &raw).await?;
    Ok(normalized)
}

/// Life Wheel 수동 선택. 커스텀 tag key도 허용하되 설정에 존재하는 enabled tag만 저장한다.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_area_tag_key(
    db: State<'_, Db>,
    id: String,
    tag_key: Option<String>,
) -> Result<WorkSignal, AppError> {
    let normalized = tag_key
        .as_deref()
        .map(normalize_tag_id)
        .filter(|key| !key.is_empty());
    if let Some(key) = normalized.as_deref() {
        let tags = current_life_wheel_tags(db.inner()).await?;
        if !tags.iter().any(|tag| tag.enabled && tag.id == key) {
            return Err(AppError::validation(
                "life_wheel.unknown_tag",
                "설정에 없는 Life Wheel 태그입니다",
            ));
        }
    }
    Ok(signal_store::set_signal_area_tag_key(db.inner(), &id, normalized.as_deref()).await?)
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
    let title = signal_store::fetch_signal_title(db, signal_id).await?;
    let payload = serde_json::json!({ "title": title }).to_string();

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
    Ok(signal_store::search_signals(db.inner(), q).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::{
        fetch_signals, insert_signal, set_quadrant, update_title, SIGNAL_COLS,
    };
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
