//! 재고 — 로트 단위(pantry_lots) + append-only 이벤트(pantry_events). 차감은 커널 FEFO.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, new_id, validate_date, validate_positive};
use crate::db::Db;
use crate::diet::{self, FefoLot};
use crate::error::AppError;
use crate::models::{
    AddPantryLotInput, ConsumePantryResult, PantryEventKind, PantryFoodSummary, PantryLocation,
    PantryLot, PantryTake,
};

#[derive(Debug, sqlx::FromRow)]
struct LotRow {
    id: String,
    food_id: String,
    food_name: String,
    location: PantryLocation,
    acquired_on: String,
    expires_on: Option<String>,
    opened_on: Option<String>,
    initial_qty_g: f64,
    remaining_qty_g: f64,
    order_line_id: Option<String>,
    note: Option<String>,
    created_at: String,
    updated_at: String,
}

const LOT_SELECT: &str = "SELECT l.id, l.food_id, f.name AS food_name, l.location, l.acquired_on, \
       l.expires_on, l.opened_on, l.initial_qty_g, l.remaining_qty_g, l.order_line_id, l.note, \
       l.created_at, l.updated_at \
  FROM pantry_lots l JOIN foods f ON f.id = l.food_id";

fn lot_from_row(row: LotRow) -> PantryLot {
    PantryLot {
        id: row.id,
        food_id: row.food_id,
        food_name: row.food_name,
        location: row.location,
        acquired_on: row.acquired_on,
        expires_on: row.expires_on,
        opened_on: row.opened_on,
        initial_qty_g: row.initial_qty_g,
        remaining_qty_g: row.remaining_qty_g,
        order_line_id: row.order_line_id,
        note: row.note,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(crate) async fn fetch_lot(db: &Db, id: &str) -> Result<PantryLot, AppError> {
    let row = sqlx::query_as::<_, LotRow>(&format!("{LOT_SELECT} WHERE l.id = ?1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("diet.pantry.lot_missing", "pantry lot not found"))?;
    Ok(lot_from_row(row))
}

async fn insert_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    lot_id: &str,
    kind: PantryEventKind,
    delta_g: f64,
    reason: Option<&str>,
    meal_log_id: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO pantry_events (id, lot_id, kind, delta_g, reason, meal_log_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(new_id())
    .bind(lot_id)
    .bind(kind)
    .bind(delta_g)
    .bind(reason)
    .bind(meal_log_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 로트 입고를 **호출자 트랜잭션에 합류**시켜 수행하고 새 로트 id를 반환한다.
/// receive_order_line처럼 "라인 received 플립 + 로트 생성"이 하나의 원자 단위여야 하는
/// 경로가 있어(critic MAJOR-1) 커밋 권한은 호출자가 가진다.
pub(crate) async fn add_lot_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    input: &AddPantryLotInput,
    order_line_id: Option<&str>,
) -> Result<String, AppError> {
    validate_date(&input.acquired_on, "diet.pantry.acquired_on")?;
    if let Some(expires) = input.expires_on.as_deref() {
        validate_date(expires, "diet.pantry.expires_on")?;
    }
    validate_positive(input.initial_qty_g, "diet.pantry.qty")?;
    // food 존재 확인(FK 에러를 친절한 validation으로).
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM foods WHERE id = ?1")
        .bind(&input.food_id)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::not_found("diet.food.missing", "food not found"));
    }

    let id = new_id();
    sqlx::query(
        "INSERT INTO pantry_lots (id, food_id, location, acquired_on, expires_on, \
           initial_qty_g, remaining_qty_g, order_line_id, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(&input.food_id)
    .bind(input.location)
    .bind(input.acquired_on.trim())
    .bind(input.expires_on.as_deref().map(str::trim))
    .bind(input.initial_qty_g)
    .bind(order_line_id)
    .bind(clean_optional(input.note.clone()).as_deref())
    .execute(&mut **tx)
    .await?;
    insert_event(
        tx,
        &id,
        PantryEventKind::Purchased,
        input.initial_qty_g,
        None,
        None,
    )
    .await?;
    Ok(id)
}

pub(crate) async fn add_pantry_lot_inner(
    db: &Db,
    input: AddPantryLotInput,
) -> Result<PantryLot, AppError> {
    let mut tx = db.begin().await?;
    let id = add_lot_in_tx(&mut tx, &input, None).await?;
    tx.commit().await?;
    fetch_lot(db, &id).await
}

pub(crate) async fn list_pantry_inner(db: &Db) -> Result<Vec<PantryFoodSummary>, AppError> {
    let rows = sqlx::query_as::<_, LotRow>(&format!(
        "{LOT_SELECT} WHERE l.remaining_qty_g > 0 \
          ORDER BY f.name, l.expires_on IS NULL, l.expires_on, l.acquired_on, l.created_at"
    ))
    .fetch_all(db)
    .await?;

    let mut summaries: Vec<PantryFoodSummary> = Vec::new();
    for row in rows {
        let lot = lot_from_row(row);
        match summaries.last_mut() {
            Some(s) if s.food_id == lot.food_id => {
                s.total_remaining_g += lot.remaining_qty_g;
                if s.nearest_expiry.is_none() {
                    s.nearest_expiry = lot.expires_on.clone();
                }
                s.lots.push(lot);
            }
            _ => summaries.push(PantryFoodSummary {
                food_id: lot.food_id.clone(),
                food_name: lot.food_name.clone(),
                total_remaining_g: lot.remaining_qty_g,
                nearest_expiry: lot.expires_on.clone(),
                lots: vec![lot],
            }),
        }
    }
    Ok(summaries)
}

/// FEFO 차감. 부족해도 있는 만큼 차감하고 shortfall로 보고(물리적 현실 우선).
pub(crate) async fn consume_pantry_inner(
    db: &Db,
    food_id: &str,
    qty_g: f64,
    meal_log_id: Option<String>,
    reason: Option<String>,
) -> Result<ConsumePantryResult, AppError> {
    validate_positive(qty_g, "diet.pantry.consume_qty")?;
    // 존재 확인 — 오타 food_id가 "재고 0 = 전량 shortfall"로 조용히 위장하지 않게(critic).
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM foods WHERE id = ?1")
        .bind(food_id)
        .fetch_optional(db)
        .await?;
    if exists.is_none() {
        return Err(AppError::not_found("diet.food.missing", "food not found"));
    }
    let reason = clean_optional(reason);
    let meal_log_id = clean_optional(meal_log_id);

    // 읽기(스냅샷)와 차감을 같은 tx에 둔다 — 동시 consume 레이스에서 잘못된 계획이 커밋되지
    // 않게. 만에 하나 겹쳐도 `CHECK (remaining_qty_g >= 0)`가 음수 차감을 롤백시킨다
    // (CHECK가 동시성 안전의 최종 방어선 — 제거 금지).
    let mut tx = db.begin().await?;
    let lots: Vec<(String, Option<String>, f64)> = sqlx::query_as(
        "SELECT id, expires_on, remaining_qty_g FROM pantry_lots \
          WHERE food_id = ?1 AND remaining_qty_g > 0 \
          ORDER BY acquired_on, created_at",
    )
    .bind(food_id)
    .fetch_all(&mut *tx)
    .await?;
    let fefo_lots: Vec<FefoLot> = lots
        .into_iter()
        .map(|(id, expires_on, remaining_qty_g)| FefoLot {
            id,
            expires_on,
            remaining_qty_g,
        })
        .collect();
    let (takes, shortfall_g) = diet::fefo_allocate(&fefo_lots, qty_g);
    for (lot_id, take) in &takes {
        sqlx::query(
            "UPDATE pantry_lots SET remaining_qty_g = remaining_qty_g - ?2, \
               updated_at = datetime('now') WHERE id = ?1",
        )
        .bind(lot_id)
        .bind(take)
        .execute(&mut *tx)
        .await?;
        insert_event(
            &mut tx,
            lot_id,
            PantryEventKind::Consumed,
            -take,
            reason.as_deref(),
            meal_log_id.as_deref(),
        )
        .await?;
    }
    tx.commit().await?;

    Ok(ConsumePantryResult {
        taken: takes
            .into_iter()
            .map(|(lot_id, qty_g)| PantryTake { lot_id, qty_g })
            .collect(),
        shortfall_g,
    })
}

/// 실사 보정 — 잔량을 실측값으로 맞추고 delta를 adjusted 이벤트로 남긴다.
pub(crate) async fn adjust_pantry_lot_inner(
    db: &Db,
    lot_id: &str,
    new_remaining_g: f64,
    reason: Option<String>,
) -> Result<PantryLot, AppError> {
    if !new_remaining_g.is_finite() || new_remaining_g < 0.0 {
        return Err(AppError::validation(
            "diet.pantry.adjust",
            "remaining must be non-negative",
        ));
    }
    // delta 계산용 읽기도 같은 tx 안 — 이벤트 트레일의 delta가 실제 반영값과 어긋나지 않게.
    let mut tx = db.begin().await?;
    let current: Option<f64> =
        sqlx::query_scalar("SELECT remaining_qty_g FROM pantry_lots WHERE id = ?1")
            .bind(lot_id)
            .fetch_optional(&mut *tx)
            .await?;
    let current = current
        .ok_or_else(|| AppError::not_found("diet.pantry.lot_missing", "pantry lot not found"))?;
    let delta = new_remaining_g - current;
    sqlx::query(
        "UPDATE pantry_lots SET remaining_qty_g = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(lot_id)
    .bind(new_remaining_g)
    .execute(&mut *tx)
    .await?;
    insert_event(
        &mut tx,
        lot_id,
        PantryEventKind::Adjusted,
        delta,
        clean_optional(reason).as_deref(),
        None,
    )
    .await?;
    tx.commit().await?;
    fetch_lot(db, lot_id).await
}

/// 폐기/유통기한 만료 처리. qty_g=None이면 잔량 전부.
pub(crate) async fn waste_pantry_lot_inner(
    db: &Db,
    lot_id: &str,
    qty_g: Option<f64>,
    kind: PantryEventKind,
    reason: Option<String>,
) -> Result<PantryLot, AppError> {
    if !matches!(kind, PantryEventKind::Wasted | PantryEventKind::Expired) {
        return Err(AppError::validation(
            "diet.pantry.waste_kind",
            "kind must be wasted or expired",
        ));
    }
    // 잔량 읽기와 차감을 같은 tx에 — "잔량 초과 폐기" 가드가 낡은 읽기 위에서 통과하지 않게.
    let mut tx = db.begin().await?;
    let current: Option<f64> =
        sqlx::query_scalar("SELECT remaining_qty_g FROM pantry_lots WHERE id = ?1")
            .bind(lot_id)
            .fetch_optional(&mut *tx)
            .await?;
    let current = current
        .ok_or_else(|| AppError::not_found("diet.pantry.lot_missing", "pantry lot not found"))?;
    let qty = match qty_g {
        Some(q) => {
            validate_positive(q, "diet.pantry.waste_qty")?;
            if q > current {
                return Err(AppError::validation(
                    "diet.pantry.waste_qty",
                    "cannot waste more than remaining",
                ));
            }
            q
        }
        None => current,
    };
    if qty <= 0.0 {
        drop(tx);
        return fetch_lot(db, lot_id).await;
    }
    sqlx::query(
        "UPDATE pantry_lots SET remaining_qty_g = remaining_qty_g - ?2, \
           updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(lot_id)
    .bind(qty)
    .execute(&mut *tx)
    .await?;
    insert_event(
        &mut tx,
        lot_id,
        kind,
        -qty,
        clean_optional(reason).as_deref(),
        None,
    )
    .await?;
    tx.commit().await?;
    fetch_lot(db, lot_id).await
}

/// 기준일로부터 within_days 안에 만료되는(이미 지난 것 포함) 잔량>0 로트.
pub(crate) async fn expiring_pantry_inner(
    db: &Db,
    today: &str,
    within_days: i32,
) -> Result<Vec<PantryLot>, AppError> {
    let today = validate_date(today, "diet.pantry.today")?;
    if within_days < 0 {
        return Err(AppError::validation(
            "diet.pantry.within_days",
            "within_days must be >= 0",
        ));
    }
    let cutoff = (today + chrono::Duration::days(within_days as i64))
        .format("%Y-%m-%d")
        .to_string();
    let rows = sqlx::query_as::<_, LotRow>(&format!(
        "{LOT_SELECT} WHERE l.remaining_qty_g > 0 AND l.expires_on IS NOT NULL \
           AND l.expires_on <= ?1 ORDER BY l.expires_on, f.name"
    ))
    .bind(&cutoff)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(lot_from_row).collect())
}

#[tauri::command]
#[specta::specta]
pub async fn add_pantry_lot(
    db: State<'_, Db>,
    input: AddPantryLotInput,
) -> Result<PantryLot, AppError> {
    add_pantry_lot_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_pantry(db: State<'_, Db>) -> Result<Vec<PantryFoodSummary>, AppError> {
    list_pantry_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn consume_pantry(
    db: State<'_, Db>,
    food_id: String,
    qty_g: f64,
    meal_log_id: Option<String>,
    reason: Option<String>,
) -> Result<ConsumePantryResult, AppError> {
    consume_pantry_inner(db.inner(), &food_id, qty_g, meal_log_id, reason).await
}

#[tauri::command]
#[specta::specta]
pub async fn adjust_pantry_lot(
    db: State<'_, Db>,
    lot_id: String,
    new_remaining_g: f64,
    reason: Option<String>,
) -> Result<PantryLot, AppError> {
    adjust_pantry_lot_inner(db.inner(), &lot_id, new_remaining_g, reason).await
}

#[tauri::command]
#[specta::specta]
pub async fn waste_pantry_lot(
    db: State<'_, Db>,
    lot_id: String,
    qty_g: Option<f64>,
    kind: PantryEventKind,
    reason: Option<String>,
) -> Result<PantryLot, AppError> {
    waste_pantry_lot_inner(db.inner(), &lot_id, qty_g, kind, reason).await
}

#[tauri::command]
#[specta::specta]
pub async fn expiring_pantry(
    db: State<'_, Db>,
    today: String,
    within_days: i32,
) -> Result<Vec<PantryLot>, AppError> {
    expiring_pantry_inner(db.inner(), &today, within_days).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{AddPantryLotInput, PantryLocation};

    pub(crate) async fn seed_lot(
        db: &Db,
        food_id: &str,
        qty_g: f64,
        acquired: &str,
        expires: Option<&str>,
    ) -> String {
        super::add_pantry_lot_inner(
            db,
            AddPantryLotInput {
                food_id: food_id.into(),
                location: PantryLocation::Fridge,
                acquired_on: acquired.into(),
                expires_on: expires.map(str::to_string),
                initial_qty_g: qty_g,
                note: None,
            },
        )
        .await
        .expect("seed lot")
        .id
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::seed_lot;
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::PantryEventKind;

    #[tokio::test]
    async fn consume_uses_fefo_and_records_events() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let late = seed_lot(&db, &chicken, 500.0, "2026-07-15", Some("2026-08-01")).await;
        let early = seed_lot(&db, &chicken, 300.0, "2026-07-10", Some("2026-07-20")).await;

        let result = super::consume_pantry_inner(&db, &chicken, 400.0, None, Some("점심".into()))
            .await
            .unwrap();
        assert_eq!(result.shortfall_g, 0.0);
        assert_eq!(result.taken.len(), 2);
        assert_eq!(result.taken[0].lot_id, early, "빠른 기한 먼저");
        assert_eq!(result.taken[0].qty_g, 300.0);
        assert_eq!(result.taken[1].lot_id, late);
        assert_eq!(result.taken[1].qty_g, 100.0);

        let early_lot = super::fetch_lot(&db, &early).await.unwrap();
        assert_eq!(early_lot.remaining_qty_g, 0.0);
        let late_lot = super::fetch_lot(&db, &late).await.unwrap();
        assert_eq!(late_lot.remaining_qty_g, 400.0);

        // 이벤트: purchased 2 + consumed 2.
        let (events,): (i32,) =
            sqlx::query_as("SELECT COUNT(*) FROM pantry_events WHERE kind = 'consumed'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(events, 2);

        // 부족 소비 — 있는 만큼 차감 + shortfall 보고.
        let short = super::consume_pantry_inner(&db, &chicken, 1000.0, None, None)
            .await
            .unwrap();
        assert_eq!(short.shortfall_g, 600.0);
        let summary = super::list_pantry_inner(&db).await.unwrap();
        assert!(summary.is_empty(), "잔량 0이면 목록에서 제외");
    }

    #[tokio::test]
    async fn adjust_and_waste_keep_append_only_trail() {
        let db = fresh_db().await;
        let milk = seed_food(&db, "우유", 61.0, 3.2).await;
        let lot = seed_lot(&db, &milk, 900.0, "2026-07-15", Some("2026-07-22")).await;

        let adjusted = super::adjust_pantry_lot_inner(&db, &lot, 700.0, Some("실사".into()))
            .await
            .unwrap();
        assert_eq!(adjusted.remaining_qty_g, 700.0);

        let wasted =
            super::waste_pantry_lot_inner(&db, &lot, Some(200.0), PantryEventKind::Wasted, None)
                .await
                .unwrap();
        assert_eq!(wasted.remaining_qty_g, 500.0);

        // 잔량 초과 폐기 거부 / consumed 종류로 waste 호출 거부.
        assert!(super::waste_pantry_lot_inner(
            &db,
            &lot,
            Some(9999.0),
            PantryEventKind::Expired,
            None
        )
        .await
        .is_err());
        assert!(
            super::waste_pantry_lot_inner(&db, &lot, None, PantryEventKind::Consumed, None)
                .await
                .is_err()
        );

        let deltas: Vec<(String, f64)> =
            sqlx::query_as("SELECT kind, delta_g FROM pantry_events ORDER BY created_at, rowid")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(
            deltas,
            vec![
                ("purchased".to_string(), 900.0),
                ("adjusted".to_string(), -200.0),
                ("wasted".to_string(), -200.0),
            ]
        );
    }

    #[tokio::test]
    async fn expiring_list_includes_already_expired() {
        let db = fresh_db().await;
        let milk = seed_food(&db, "우유", 61.0, 3.2).await;
        seed_lot(&db, &milk, 900.0, "2026-07-01", Some("2026-07-10")).await; // 이미 지남
        seed_lot(&db, &milk, 900.0, "2026-07-15", Some("2026-07-19")).await; // 2일 내
        seed_lot(&db, &milk, 900.0, "2026-07-15", Some("2026-09-01")).await; // 멀었음
        seed_lot(&db, &milk, 900.0, "2026-07-15", None).await; // 기한 없음

        let expiring = super::expiring_pantry_inner(&db, "2026-07-17", 3)
            .await
            .unwrap();
        assert_eq!(expiring.len(), 2);
        assert_eq!(expiring[0].expires_on.as_deref(), Some("2026-07-10"));
    }
}
