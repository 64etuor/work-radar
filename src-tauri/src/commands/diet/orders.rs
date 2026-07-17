//! 주문 내역 원장(grocery_orders/-_lines) — **기록 전용**. 체크아웃/결제 경로 없음(범위 밖).
//! 입고(receive)는 pantry 로트 생성으로 이어진다(백업-wins 아님 — 라인 1회 입고 강제).

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, clean_required, new_id, validate_positive};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    AddPantryLotInput, GroceryOrder, GroceryOrderLine, GroceryOrderStatus, PantryLot,
    ReceiveOrderLineInput, RecordGroceryOrderInput,
};

#[derive(Debug, sqlx::FromRow)]
struct OrderRow {
    id: String,
    merchant: String,
    ordered_at: String,
    external_order_no: Option<String>,
    total_krw: Option<i32>,
    shipping_krw: Option<i32>,
    status: GroceryOrderStatus,
    note: Option<String>,
    created_at: String,
    updated_at: String,
}

const ORDER_COLS: &str = "id, merchant, ordered_at, external_order_no, total_krw, shipping_krw, \
     status, note, created_at, updated_at";
const LINE_COLS: &str = "id, order_id, product_name, food_id, quantity, total_g, unit_price_krw, \
     line_total_krw, received, note";

async fn lines_for(db: &Db, order_id: &str) -> Result<Vec<GroceryOrderLine>, AppError> {
    Ok(sqlx::query_as::<_, GroceryOrderLine>(&format!(
        "SELECT {LINE_COLS} FROM grocery_order_lines WHERE order_id = ?1 ORDER BY rowid"
    ))
    .bind(order_id)
    .fetch_all(db)
    .await?)
}

async fn order_from_row(db: &Db, row: OrderRow) -> Result<GroceryOrder, AppError> {
    let lines = lines_for(db, &row.id).await?;
    Ok(GroceryOrder {
        id: row.id,
        merchant: row.merchant,
        ordered_at: row.ordered_at,
        external_order_no: row.external_order_no,
        total_krw: row.total_krw,
        shipping_krw: row.shipping_krw,
        status: row.status,
        note: row.note,
        lines,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn fetch_order(db: &Db, id: &str) -> Result<GroceryOrder, AppError> {
    let row = sqlx::query_as::<_, OrderRow>(&format!(
        "SELECT {ORDER_COLS} FROM grocery_orders WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("diet.order.missing", "grocery order not found"))?;
    order_from_row(db, row).await
}

pub(crate) async fn record_grocery_order_inner(
    db: &Db,
    input: RecordGroceryOrderInput,
) -> Result<GroceryOrder, AppError> {
    let merchant = clean_required(&input.merchant, "diet.order.merchant", "merchant")?;
    let ordered_at = clean_required(&input.ordered_at, "diet.order.ordered_at", "ordered_at")?;
    if input.lines.is_empty() {
        return Err(AppError::validation(
            "diet.order.lines",
            "an order needs at least one line",
        ));
    }
    // 금액은 DB CHECK(>=0)로도 막히지만, 친절한 validation 에러로 경계에서 먼저 잡는다.
    for (value, code) in [
        (input.total_krw, "diet.order.total_krw"),
        (input.shipping_krw, "diet.order.shipping_krw"),
    ] {
        if value.is_some_and(|v| v < 0) {
            return Err(AppError::validation(code, "amount must be non-negative"));
        }
    }
    for line in &input.lines {
        clean_required(
            &line.product_name,
            "diet.order.product_name",
            "product name",
        )?;
        validate_positive(line.quantity, "diet.order.quantity")?;
        if let Some(g) = line.total_g {
            validate_positive(g, "diet.order.total_g")?;
        }
        if line.unit_price_krw.is_some_and(|v| v < 0) || line.line_total_krw.is_some_and(|v| v < 0)
        {
            return Err(AppError::validation(
                "diet.order.line_amount",
                "amount must be non-negative",
            ));
        }
    }

    let order_id = new_id();
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO grocery_orders (id, merchant, ordered_at, external_order_no, total_krw, \
           shipping_krw, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&order_id)
    .bind(&merchant)
    .bind(&ordered_at)
    .bind(clean_optional(input.external_order_no).as_deref())
    .bind(input.total_krw)
    .bind(input.shipping_krw)
    .bind(clean_optional(input.note).as_deref())
    .execute(&mut *tx)
    .await?;
    for line in &input.lines {
        sqlx::query(
            "INSERT INTO grocery_order_lines (id, order_id, product_name, food_id, quantity, \
               total_g, unit_price_krw, line_total_krw, note) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(new_id())
        .bind(&order_id)
        .bind(line.product_name.trim())
        .bind(line.food_id.as_deref())
        .bind(line.quantity)
        .bind(line.total_g)
        .bind(line.unit_price_krw)
        .bind(line.line_total_krw)
        .bind(clean_optional(line.note.clone()).as_deref())
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
                AppError::validation("diet.order.line_food", "line food not found")
            }
            other => AppError::from(other),
        })?;
    }
    tx.commit().await?;
    fetch_order(db, &order_id).await
}

pub(crate) async fn list_grocery_orders_inner(
    db: &Db,
    limit: i32,
) -> Result<Vec<GroceryOrder>, AppError> {
    let limit = limit.clamp(1, 500);
    let rows = sqlx::query_as::<_, OrderRow>(&format!(
        "SELECT {ORDER_COLS} FROM grocery_orders ORDER BY ordered_at DESC, created_at DESC LIMIT ?1"
    ))
    .bind(limit)
    .fetch_all(db)
    .await?;
    let mut orders = Vec::with_capacity(rows.len());
    for row in rows {
        orders.push(order_from_row(db, row).await?);
    }
    Ok(orders)
}

pub(crate) async fn set_grocery_order_status_inner(
    db: &Db,
    id: &str,
    status: GroceryOrderStatus,
) -> Result<GroceryOrder, AppError> {
    let updated = sqlx::query(
        "UPDATE grocery_orders SET status = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .bind(status)
    .execute(db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.order.missing",
            "grocery order not found",
        ));
    }
    fetch_order(db, id).await
}

/// 라인의 food 링크 지정/해제 — 장보기 pending 계산과 입고에 필요.
pub(crate) async fn set_order_line_food_inner(
    db: &Db,
    line_id: &str,
    food_id: Option<String>,
) -> Result<GroceryOrderLine, AppError> {
    if let Some(fid) = food_id.as_deref() {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM foods WHERE id = ?1")
            .bind(fid)
            .fetch_optional(db)
            .await?;
        if exists.is_none() {
            return Err(AppError::not_found("diet.food.missing", "food not found"));
        }
    }
    let updated = sqlx::query("UPDATE grocery_order_lines SET food_id = ?2 WHERE id = ?1")
        .bind(line_id)
        .bind(food_id.as_deref())
        .execute(db)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.order.line_missing",
            "order line not found",
        ));
    }
    Ok(sqlx::query_as::<_, GroceryOrderLine>(&format!(
        "SELECT {LINE_COLS} FROM grocery_order_lines WHERE id = ?1"
    ))
    .bind(line_id)
    .fetch_one(db)
    .await?)
}

/// 입고 — 라인 1회 한정(중복 입고 = 재고 이중 계상 방지). **단일 tx**: 조건부
/// `received=0→1` UPDATE가 게이트이고, 로트 생성 + purchased 이벤트가 같은 tx에 합류한다
/// (critic MAJOR-1 — 크래시 창/TOCTOU 양쪽에서 로트와 received 플래그가 함께 성립/함께 소멸).
pub(crate) async fn receive_order_line_inner(
    db: &Db,
    input: ReceiveOrderLineInput,
) -> Result<PantryLot, AppError> {
    let mut tx = db.begin().await?;
    // 게이트: 이 UPDATE가 0행이면 "없는 라인" 또는 "이미 입고" — write-tx로 시작해 직렬화.
    let gate =
        sqlx::query("UPDATE grocery_order_lines SET received = 1 WHERE id = ?1 AND received = 0")
            .bind(&input.line_id)
            .execute(&mut *tx)
            .await?;
    if gate.rows_affected() == 0 {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM grocery_order_lines WHERE id = ?1")
                .bind(&input.line_id)
                .fetch_optional(&mut *tx)
                .await?;
        return Err(match exists {
            Some(_) => AppError::validation(
                "diet.order.already_received",
                "order line was already received",
            ),
            None => AppError::not_found("diet.order.line_missing", "order line not found"),
        });
    }
    let (product_name, food_id, total_g): (String, Option<String>, Option<f64>) = sqlx::query_as(
        "SELECT product_name, food_id, total_g FROM grocery_order_lines WHERE id = ?1",
    )
    .bind(&input.line_id)
    .fetch_one(&mut *tx)
    .await?;
    // 검증 실패 시 return → tx drop → 롤백(received 플립도 함께 취소).
    let food_id = food_id.ok_or_else(|| {
        AppError::validation(
            "diet.order.line_unlinked",
            "link the line to a food first (set_order_line_food)",
        )
    })?;
    let qty_g = input.total_g_override.or(total_g).ok_or_else(|| {
        AppError::validation(
            "diet.order.line_weight",
            "line has no total_g — pass total_g_override",
        )
    })?;

    let lot_id = super::pantry::add_lot_in_tx(
        &mut tx,
        &AddPantryLotInput {
            food_id,
            location: input.location,
            acquired_on: input.acquired_on.clone(),
            expires_on: input.expires_on.clone(),
            initial_qty_g: qty_g,
            note: Some(format!("주문 입고: {product_name}")),
        },
        Some(&input.line_id),
    )
    .await?;
    tx.commit().await?;
    super::pantry::fetch_lot(db, &lot_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn record_grocery_order(
    db: State<'_, Db>,
    input: RecordGroceryOrderInput,
) -> Result<GroceryOrder, AppError> {
    record_grocery_order_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_grocery_orders(
    db: State<'_, Db>,
    limit: i32,
) -> Result<Vec<GroceryOrder>, AppError> {
    list_grocery_orders_inner(db.inner(), limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_grocery_order_status(
    db: State<'_, Db>,
    id: String,
    status: GroceryOrderStatus,
) -> Result<GroceryOrder, AppError> {
    set_grocery_order_status_inner(db.inner(), &id, status).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_order_line_food(
    db: State<'_, Db>,
    line_id: String,
    food_id: Option<String>,
) -> Result<GroceryOrderLine, AppError> {
    set_order_line_food_inner(db.inner(), &line_id, food_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn receive_order_line(
    db: State<'_, Db>,
    input: ReceiveOrderLineInput,
) -> Result<PantryLot, AppError> {
    receive_order_line_inner(db.inner(), input).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{GroceryOrderLineInput, RecordGroceryOrderInput};

    pub(crate) async fn seed_order(
        db: &Db,
        lines: Vec<(String, Option<String>, Option<f64>)>,
    ) -> crate::models::GroceryOrder {
        super::record_grocery_order_inner(
            db,
            RecordGroceryOrderInput {
                merchant: "coupang".into(),
                ordered_at: "2026-07-17T09:00:00+09:00".into(),
                external_order_no: Some("240717-0001".into()),
                total_krw: Some(67400),
                shipping_krw: Some(0),
                note: None,
                lines: lines
                    .into_iter()
                    .map(|(name, food_id, total_g)| GroceryOrderLineInput {
                        product_name: name,
                        food_id,
                        quantity: 1.0,
                        total_g,
                        unit_price_krw: None,
                        line_total_krw: None,
                        note: None,
                    })
                    .collect(),
            },
        )
        .await
        .expect("seed order")
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::seed_order;
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{GroceryOrderStatus, PantryLocation, ReceiveOrderLineInput};

    #[tokio::test]
    async fn order_roundtrip_and_receive_creates_lot_once() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let order = seed_order(
            &db,
            vec![
                (
                    "곰곰 닭다리살 1.2kg".into(),
                    Some(chicken.clone()),
                    Some(1200.0),
                ),
                ("어쩌다 세제".into(), None, None),
            ],
        )
        .await;
        assert_eq!(order.lines.len(), 2);
        assert_eq!(order.total_krw, Some(67400));

        let line_id = order.lines[0].id.clone();
        let lot = super::receive_order_line_inner(
            &db,
            ReceiveOrderLineInput {
                line_id: line_id.clone(),
                location: PantryLocation::Freezer,
                acquired_on: "2026-07-18".into(),
                expires_on: Some("2026-10-18".into()),
                total_g_override: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(lot.food_id, chicken);
        assert_eq!(lot.initial_qty_g, 1200.0);
        assert_eq!(lot.order_line_id.as_deref(), Some(line_id.as_str()));

        // 중복 입고 거부(재고 이중 계상 방지).
        let dup = super::receive_order_line_inner(
            &db,
            ReceiveOrderLineInput {
                line_id,
                location: PantryLocation::Freezer,
                acquired_on: "2026-07-18".into(),
                expires_on: None,
                total_g_override: None,
            },
        )
        .await;
        assert!(dup.is_err());

        // food 링크 없는 라인은 입고 전에 링크를 요구 — 그리고 실패한 입고는 **원자적으로 롤백**
        // 되어야 한다: 게이트 UPDATE(received=1)가 먼저 갔더라도 tx 실패로 함께 취소(critic MAJOR-1).
        let unlinked = order.lines[1].id.clone();
        let need_link = super::receive_order_line_inner(
            &db,
            ReceiveOrderLineInput {
                line_id: unlinked.clone(),
                location: PantryLocation::Pantry,
                acquired_on: "2026-07-18".into(),
                expires_on: None,
                total_g_override: Some(1000.0),
            },
        )
        .await;
        assert!(need_link.is_err());
        let (still_unreceived,): (bool,) =
            sqlx::query_as("SELECT received FROM grocery_order_lines WHERE id = ?1")
                .bind(&unlinked)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(!still_unreceived, "실패한 입고는 received 플립까지 롤백");
        let (lots,): (i32,) = sqlx::query_as("SELECT COUNT(*) FROM pantry_lots")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(lots, 1, "성공한 입고 1건의 로트만 존재(이중 계상 없음)");

        let status =
            super::set_grocery_order_status_inner(&db, &order.id, GroceryOrderStatus::Delivered)
                .await
                .unwrap();
        assert_eq!(status.status, GroceryOrderStatus::Delivered);
    }

    #[tokio::test]
    async fn line_food_link_can_be_set_later() {
        let db = fresh_db().await;
        let shrimp = seed_food(&db, "새우", 85.0, 20.0).await;
        let order = seed_order(&db, vec![("생새우 600g".into(), None, Some(600.0))]).await;
        let line = super::set_order_line_food_inner(&db, &order.lines[0].id, Some(shrimp.clone()))
            .await
            .unwrap();
        assert_eq!(line.food_id.as_deref(), Some(shrimp.as_str()));

        // 존재하지 않는 food 링크 거부 / 빈 주문 거부.
        assert!(
            super::set_order_line_food_inner(&db, &order.lines[0].id, Some("ghost".into()))
                .await
                .is_err()
        );
        let empty = super::record_grocery_order_inner(
            &db,
            crate::models::RecordGroceryOrderInput {
                merchant: "coupang".into(),
                ordered_at: "2026-07-17".into(),
                external_order_no: None,
                total_krw: None,
                shipping_krw: None,
                note: None,
                lines: vec![],
            },
        )
        .await;
        assert!(empty.is_err());
    }
}
