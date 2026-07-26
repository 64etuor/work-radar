//! 레시피 저작 — 재료(g 정규화) + 단계 + 개정 이력 + 맛 피드백.
//! 설계 정본: `docs/plans/2026-07-26-recipe-authoring-workout.md`.
//!
//! 영양은 저장하지 않고 조회 시 커널로 계산 — 계획/기록에 넣는 순간에만 스냅샷이 남는다
//! (plans.rs / logs.rs). 레시피를 나중에 고쳐도 과거 계획·기록의 수치는 변하지 않는다.
//!
//! **레시피 _내용_ 을 바꾸는 모든 mutate는 리비전 append를 포함한 단일 tx가 계약이다.**
//! 리비전 없는 내용 변경은 "계속 수정하다가 되돌릴 수 없는" 상태를 만든다 — 이 도메인의 존재
//! 이유를 깨는 것이다. 순서: `begin_mutation`(rev 가드 + 직전 상태 baseline) → 실제 변경 →
//! `finish_mutation`(결과 상태를 새 rev로 append + `recipes.rev_no` 전진).
//!
//! 계약 밖에 있는 것은 **`archived` 하나**다(`set_recipe_archived`). 보관은 내용이 아니라
//! 라이브러리 가시성 플래그이므로 `RecipeSnapshot`에 담지 않고 리비전도 만들지 않는다 —
//! 담으면 "rev 2로 되돌리기"가 보관 상태까지 되살려서, 조리법을 되돌렸을 뿐인데 레시피가
//! 라이브러리에 다시 튀어나오는 놀라운 동작이 된다. 되돌리기 경로도 `archived`를 건드리지 않는다.

#![allow(clippy::result_large_err)]

use sqlx::{Sqlite, SqliteConnection, Transaction};
use tauri::State;

use super::{clean_optional, clean_required, new_id, validate_positive};
use crate::db::Db;
use crate::diet::{self, UnitConversionEntry, UnitResolveError};
use crate::error::AppError;
use crate::models::{
    AddRecipeFeedbackInput, CreateRecipeInput, DietMacros, PatchRecipeInput, Recipe,
    RecipeClearableField, RecipeDiffEntry, RecipeEditor, RecipeFeedback, RecipeIngredient,
    RecipeIngredientInput, RecipeRevision, RecipeRevisionDetail, RecipeSnapshot, RecipeStep,
    RecipeStepInput, RecipeTasteSummary, ScaledIngredient, ScaledRecipe, SetRecipeIngredientInput,
    SetRecipeStepInput, UnitConversion, UpdateRecipeInput, UpsertUnitConversionInput,
};

#[derive(Debug, sqlx::FromRow)]
struct RecipeRow {
    id: String,
    name: String,
    servings: f64,
    cook_minutes: Option<i32>,
    meal_tags: String,
    source_url: Option<String>,
    yield_g: Option<f64>,
    notes: Option<String>,
    rev_no: i32,
    archived: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct IngredientRow {
    id: String,
    recipe_id: String,
    food_id: String,
    food_name: String,
    qty_g: f64,
    qty: Option<f64>,
    unit: Option<String>,
    to_taste: bool,
    optional: bool,
    note: Option<String>,
    sort_rank: i32,
    kcal_per_100g: f64,
    protein_g_per_100g: f64,
    fat_g_per_100g: f64,
    carb_g_per_100g: f64,
}

#[derive(Debug, sqlx::FromRow)]
struct StepRow {
    id: String,
    recipe_id: String,
    sort_rank: f64,
    body: String,
    duration_minutes: Option<i32>,
    note: Option<String>,
}

const RECIPE_COLS: &str = "id, name, servings, cook_minutes, meal_tags, source_url, yield_g, \
                           notes, rev_no, archived, created_at, updated_at";

/// 해소된 재료 한 줄 — `qty_g`가 확정된 상태(커널 환산 완료).
#[derive(Debug, Clone)]
struct ResolvedIngredient {
    food_id: String,
    qty_g: f64,
    qty: Option<f64>,
    unit: Option<String>,
    to_taste: bool,
    optional: bool,
    note: Option<String>,
}

fn parse_tags(raw: &str) -> Result<Vec<String>, AppError> {
    serde_json::from_str::<Vec<String>>(raw)
        .map_err(|e| AppError::unexpected("diet.recipe.tags.parse", e.to_string()))
}

fn serialize_tags(tags: Vec<String>) -> Result<String, AppError> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed = tag.trim().to_lowercase();
        if !trimmed.is_empty() && !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    serde_json::to_string(&out).map_err(|e| AppError::unexpected("diet.recipe.tags", e.to_string()))
}

// --- 단위 환산 -------------------------------------------------------------

/// 환산 테이블 전체(전역 + food 전용). 개인용 규모라 통째로 읽어 커널에 넘긴다.
async fn load_conversions(
    conn: &mut SqliteConnection,
) -> Result<Vec<UnitConversionEntry>, AppError> {
    let rows: Vec<(String, Option<String>, f64)> =
        sqlx::query_as("SELECT unit, food_id, grams_per_unit FROM unit_conversions")
            .fetch_all(&mut *conn)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(unit, food_id, grams_per_unit)| UnitConversionEntry {
            unit,
            food_id,
            grams_per_unit,
        })
        .collect())
}

/// 입력 재료 → `qty_g` 확정. `qty_g`가 있으면 그것이 이기고, 없으면 `qty`+`unit`을 환산한다.
/// 환산 실패는 검증 오류로 접는다 — 조용한 0g 금지(영양·재고 차감이 전부 틀어진다).
fn resolve_ingredient(
    input: &RecipeIngredientInput,
    conversions: &[UnitConversionEntry],
) -> Result<ResolvedIngredient, AppError> {
    let food_id = clean_required(
        &input.food_id,
        "diet.recipe.ingredient.food",
        "ingredient food",
    )?;
    let unit = clean_optional(input.unit.clone());
    // 표기는 (qty, unit) 쌍이어야 한다 — 한쪽만 오면 표시가 깨지고 환산 의도도 불분명하다.
    if unit.is_some() != input.qty.is_some() {
        return Err(AppError::validation(
            "diet.recipe.ingredient.unit",
            "qty and unit must be given together",
        ));
    }

    let qty_g = match input.qty_g {
        Some(direct) => {
            validate_positive(direct, "diet.recipe.ingredient.qty")?;
            direct
        }
        None => {
            let (Some(qty), Some(unit)) = (input.qty, unit.as_deref()) else {
                return Err(AppError::validation(
                    "diet.recipe.ingredient.qty",
                    "either qtyG or qty+unit is required",
                ));
            };
            diet::resolve_qty_g(qty, unit, &food_id, conversions).map_err(|e| match e {
                UnitResolveError::NonPositiveQty => {
                    AppError::validation("diet.recipe.ingredient.qty", "qty must be > 0")
                }
                UnitResolveError::UnknownUnit(unit) => AppError::validation(
                    "diet.recipe.ingredient.unit",
                    format!(
                        "no gram conversion for unit '{unit}' — register one via \
                         upsert_unit_conversion first"
                    ),
                ),
            })?
        }
    };

    Ok(ResolvedIngredient {
        food_id,
        qty_g,
        qty: input.qty,
        unit,
        to_taste: input.to_taste,
        optional: input.optional,
        note: clean_optional(input.note.clone()),
    })
}

async fn resolve_ingredients(
    conn: &mut SqliteConnection,
    inputs: &[RecipeIngredientInput],
) -> Result<Vec<ResolvedIngredient>, AppError> {
    let conversions = load_conversions(conn).await?;
    inputs
        .iter()
        .map(|i| resolve_ingredient(i, &conversions))
        .collect()
}

fn clean_steps(inputs: &[RecipeStepInput]) -> Result<Vec<RecipeStepInput>, AppError> {
    inputs
        .iter()
        .map(|s| {
            let body = clean_required(&s.body, "diet.recipe.step.body", "step body")?;
            if let Some(minutes) = s.duration_minutes {
                if minutes <= 0 {
                    return Err(AppError::validation(
                        "diet.recipe.step.duration",
                        "durationMinutes must be > 0",
                    ));
                }
            }
            Ok(RecipeStepInput {
                body,
                duration_minutes: s.duration_minutes,
                note: clean_optional(s.note.clone()),
            })
        })
        .collect()
}

// --- 조회 ------------------------------------------------------------------

/// tx 안/밖 모두에서 쓰는 단일 로더. tx 안에서는 `&mut *tx`로, 밖에서는 pool 커넥션으로 호출한다
/// (리비전 스냅샷은 **커밋 전 상태**를 읽어야 하므로 tx 경로가 필수다).
async fn load_recipe(conn: &mut SqliteConnection, id: &str) -> Result<Recipe, AppError> {
    let row =
        sqlx::query_as::<_, RecipeRow>(&format!("SELECT {RECIPE_COLS} FROM recipes WHERE id = ?1"))
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(|| AppError::not_found("diet.recipe.missing", "recipe not found"))?;

    let ingredient_rows = sqlx::query_as::<_, IngredientRow>(
        "SELECT ri.id, ri.recipe_id, ri.food_id, f.name AS food_name, ri.qty_g, ri.qty, ri.unit, \
                ri.to_taste, ri.optional, ri.note, ri.sort_rank, f.kcal_per_100g, \
                f.protein_g_per_100g, f.fat_g_per_100g, f.carb_g_per_100g \
           FROM recipe_ingredients ri JOIN foods f ON f.id = ri.food_id \
          WHERE ri.recipe_id = ?1 ORDER BY ri.sort_rank, ri.id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;

    let step_rows = sqlx::query_as::<_, StepRow>(
        "SELECT id, recipe_id, sort_rank, body, duration_minutes, note \
           FROM recipe_steps WHERE recipe_id = ?1 ORDER BY sort_rank, id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;

    // per-100g 매크로는 조회 시점 food 값 — 저장 스냅샷이 아님(의도).
    let per_qty: Vec<(DietMacros, f64)> = ingredient_rows
        .iter()
        .map(|r| {
            (
                DietMacros {
                    kcal: r.kcal_per_100g,
                    protein_g: r.protein_g_per_100g,
                    fat_g: r.fat_g_per_100g,
                    carb_g: r.carb_g_per_100g,
                },
                r.qty_g,
            )
        })
        .collect();
    let total = diet::recipe_totals(per_qty.iter().map(|(m, q)| (m, *q)));
    let per_serving = diet::per_serving(&total, row.servings);

    Ok(Recipe {
        id: row.id,
        name: row.name,
        servings: row.servings,
        cook_minutes: row.cook_minutes,
        meal_tags: parse_tags(&row.meal_tags)?,
        source_url: row.source_url,
        yield_g: row.yield_g,
        notes: row.notes,
        rev_no: row.rev_no,
        archived: row.archived,
        ingredients: ingredient_rows
            .into_iter()
            .map(|r| RecipeIngredient {
                id: r.id,
                recipe_id: r.recipe_id,
                food_id: r.food_id,
                food_name: r.food_name,
                qty_g: r.qty_g,
                qty: r.qty,
                unit: r.unit,
                to_taste: r.to_taste,
                optional: r.optional,
                note: r.note,
                sort_rank: r.sort_rank,
            })
            .collect(),
        steps: step_rows
            .into_iter()
            .enumerate()
            .map(|(idx, r)| RecipeStep {
                id: r.id,
                recipe_id: r.recipe_id,
                // 1-based 표시 번호는 여기서 파생 — 저장 컬럼이 아니다.
                step_no: idx as i32 + 1,
                sort_rank: r.sort_rank,
                body: r.body,
                duration_minutes: r.duration_minutes,
                note: r.note,
            })
            .collect(),
        total,
        per_serving,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn fetch_recipe(db: &Db, id: &str) -> Result<Recipe, AppError> {
    let mut conn = db.acquire().await?;
    load_recipe(&mut conn, id).await
}

/// (name, 1인분 매크로) — 계획/기록 스냅샷 계산용.
pub(crate) async fn recipe_per_serving(
    db: &Db,
    id: &str,
) -> Result<(String, DietMacros), AppError> {
    let recipe = fetch_recipe(db, id).await?;
    Ok((recipe.name, recipe.per_serving))
}

// --- 쓰기 프리미티브 -------------------------------------------------------

/// 재료 전체 재기록. `sort_rank`는 항상 배열 위치로 다시 부여한다 — 부분 갱신에서도
/// 재번호를 하므로 rank 충돌/구멍이 구조적으로 생기지 않는다.
async fn write_ingredients(
    tx: &mut Transaction<'_, Sqlite>,
    recipe_id: &str,
    ingredients: &[ResolvedIngredient],
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM recipe_ingredients WHERE recipe_id = ?1")
        .bind(recipe_id)
        .execute(&mut **tx)
        .await?;
    for (rank, ing) in ingredients.iter().enumerate() {
        sqlx::query(
            "INSERT INTO recipe_ingredients \
               (id, recipe_id, food_id, qty_g, qty, unit, to_taste, optional, note, sort_rank) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(new_id())
        .bind(recipe_id)
        .bind(&ing.food_id)
        .bind(ing.qty_g)
        .bind(ing.qty)
        .bind(ing.unit.as_deref())
        .bind(ing.to_taste)
        .bind(ing.optional)
        .bind(ing.note.as_deref())
        .bind(rank as i32)
        .execute(&mut **tx)
        .await
        .map_err(|e| match e {
            // FK 위반 = 존재하지 않는 food — 사용자 입력 오류로 접는다.
            sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
                AppError::validation("diet.recipe.ingredient.food", "ingredient food not found")
            }
            other => AppError::from(other),
        })?;
    }
    Ok(())
}

/// 단계 전체 재기록. rank = 배열 위치(0,1,2,…) — REAL 컬럼이지만 항상 정수로 재부여하므로
/// 중간 삽입을 반복해도 부동소수 rank가 수렴해 붕괴하는 일이 없다.
async fn write_steps(
    tx: &mut Transaction<'_, Sqlite>,
    recipe_id: &str,
    steps: &[RecipeStepInput],
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM recipe_steps WHERE recipe_id = ?1")
        .bind(recipe_id)
        .execute(&mut **tx)
        .await?;
    for (rank, step) in steps.iter().enumerate() {
        sqlx::query(
            "INSERT INTO recipe_steps (id, recipe_id, sort_rank, body, duration_minutes, note) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(new_id())
        .bind(recipe_id)
        .bind(rank as f64)
        .bind(&step.body)
        .bind(step.duration_minutes)
        .bind(step.note.as_deref())
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// 현재 상태를 `rev_no`로 append. `or_ignore`면 이미 그 rev가 있을 때 조용히 통과(baseline 용).
async fn write_revision(
    tx: &mut Transaction<'_, Sqlite>,
    recipe_id: &str,
    rev_no: i32,
    change_summary: Option<&str>,
    changed_by: RecipeEditor,
    or_ignore: bool,
) -> Result<(), AppError> {
    let recipe = load_recipe(tx, recipe_id).await?;
    let snapshot = diet::recipe_snapshot(&recipe);
    let json = serde_json::to_string(&snapshot)
        .map_err(|e| AppError::unexpected("diet.recipe.snapshot", e.to_string()))?;
    let verb = if or_ignore {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    sqlx::query(&format!(
        "{verb} INTO recipe_revisions \
           (id, recipe_id, rev_no, snapshot_json, change_summary, changed_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ))
    .bind(new_id())
    .bind(recipe_id)
    .bind(rev_no)
    .bind(&json)
    .bind(change_summary)
    .bind(changed_by)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// mutate 진입: 존재 확인 + 낙관적 동시성 가드 + **직전 상태 baseline 리비전** 확보.
///
/// baseline이 필요한 이유: 0075 이전에 만들어진 레시피(또는 rev 1이 유실된 레시피)는
/// 리비전 행이 없다. 그대로 수정하면 "되돌릴 지점"이 사라진다 — 첫 수정 시점에 직전 상태를
/// 그 rev로 채워 넣어 이력의 구멍을 막는다.
async fn begin_mutation(
    tx: &mut Transaction<'_, Sqlite>,
    recipe_id: &str,
    expected_rev_no: Option<i32>,
) -> Result<i32, AppError> {
    let current: i32 = sqlx::query_scalar("SELECT rev_no FROM recipes WHERE id = ?1")
        .bind(recipe_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| AppError::not_found("diet.recipe.missing", "recipe not found"))?;

    if let Some(expected) = expected_rev_no {
        if expected != current {
            return Err(AppError::validation(
                "diet.recipe.rev_conflict",
                format!(
                    "recipe was modified elsewhere (expected rev {expected}, current {current}) \
                     — re-read the recipe and retry"
                ),
            ));
        }
    }

    write_revision(
        tx,
        recipe_id,
        current,
        Some("(baseline)"),
        RecipeEditor::User,
        true,
    )
    .await?;
    Ok(current)
}

/// mutate 종료: 결과 상태를 새 rev로 append + `recipes.rev_no` 전진.
async fn finish_mutation(
    tx: &mut Transaction<'_, Sqlite>,
    recipe_id: &str,
    current_rev: i32,
    change_summary: Option<String>,
    changed_by: Option<RecipeEditor>,
) -> Result<(), AppError> {
    let next = current_rev + 1;
    sqlx::query("UPDATE recipes SET rev_no = ?2, updated_at = datetime('now') WHERE id = ?1")
        .bind(recipe_id)
        .bind(next)
        .execute(&mut **tx)
        .await?;
    write_revision(
        tx,
        recipe_id,
        next,
        clean_optional(change_summary).as_deref(),
        changed_by.unwrap_or(RecipeEditor::User),
        false,
    )
    .await
}

// --- 커맨드 본체 -----------------------------------------------------------

pub(crate) async fn create_recipe_inner(
    db: &Db,
    input: CreateRecipeInput,
) -> Result<Recipe, AppError> {
    let name = clean_required(&input.name, "diet.recipe.name", "recipe name")?;
    validate_positive(input.servings, "diet.recipe.servings")?;
    if let Some(yield_g) = input.yield_g {
        validate_positive(yield_g, "diet.recipe.yield")?;
    }
    let tags = serialize_tags(input.meal_tags)?;
    let steps = clean_steps(&input.steps)?;

    let id = new_id();
    let mut tx = db.begin().await?;
    let ingredients = resolve_ingredients(&mut tx, &input.ingredients).await?;
    sqlx::query(
        "INSERT INTO recipes \
           (id, name, servings, cook_minutes, meal_tags, source_url, yield_g, notes) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(&name)
    .bind(input.servings)
    .bind(input.cook_minutes)
    .bind(&tags)
    .bind(clean_optional(input.source_url).as_deref())
    .bind(input.yield_g)
    .bind(clean_optional(input.notes).as_deref())
    .execute(&mut *tx)
    .await?;
    write_ingredients(&mut tx, &id, &ingredients).await?;
    write_steps(&mut tx, &id, &steps).await?;
    // rev 1 = 생성 시점. rev_no 컬럼 기본값이 1이므로 전진시키지 않는다.
    write_revision(
        &mut tx,
        &id,
        1,
        Some("created"),
        input.changed_by.unwrap_or(RecipeEditor::User),
        false,
    )
    .await?;
    tx.commit().await?;
    fetch_recipe(db, &id).await
}

pub(crate) async fn update_recipe_inner(
    db: &Db,
    input: UpdateRecipeInput,
) -> Result<Recipe, AppError> {
    let name = clean_required(&input.name, "diet.recipe.name", "recipe name")?;
    validate_positive(input.servings, "diet.recipe.servings")?;
    if let Some(yield_g) = input.yield_g {
        validate_positive(yield_g, "diet.recipe.yield")?;
    }
    let tags = serialize_tags(input.meal_tags)?;
    let steps = clean_steps(&input.steps)?;

    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, &input.id, Some(input.expected_rev_no)).await?;
    let ingredients = resolve_ingredients(&mut tx, &input.ingredients).await?;
    sqlx::query(
        "UPDATE recipes SET name = ?2, servings = ?3, cook_minutes = ?4, meal_tags = ?5, \
           source_url = ?6, yield_g = ?7, notes = ?8 WHERE id = ?1",
    )
    .bind(&input.id)
    .bind(&name)
    .bind(input.servings)
    .bind(input.cook_minutes)
    .bind(&tags)
    .bind(clean_optional(input.source_url).as_deref())
    .bind(input.yield_g)
    .bind(clean_optional(input.notes).as_deref())
    .execute(&mut *tx)
    .await?;
    // 재료·단계는 전체 교체 — 과거 계획/기록은 스냅샷이라 영향 없음.
    write_ingredients(&mut tx, &input.id, &ingredients).await?;
    write_steps(&mut tx, &input.id, &steps).await?;
    finish_mutation(
        &mut tx,
        &input.id,
        current,
        input.change_summary,
        input.changed_by,
    )
    .await?;
    tx.commit().await?;
    fetch_recipe(db, &input.id).await
}

pub(crate) async fn patch_recipe_inner(
    db: &Db,
    input: PatchRecipeInput,
) -> Result<Recipe, AppError> {
    let clears = &input.clear;
    let conflicting = (input.cook_minutes.is_some()
        && clears.contains(&RecipeClearableField::CookMinutes))
        || (input.source_url.is_some() && clears.contains(&RecipeClearableField::SourceUrl))
        || (input.yield_g.is_some() && clears.contains(&RecipeClearableField::YieldG))
        || (input.notes.is_some() && clears.contains(&RecipeClearableField::Notes));
    if conflicting {
        return Err(AppError::validation(
            "diet.recipe.patch.conflict",
            "a field cannot be both set and cleared",
        ));
    }

    let name = match input.name.as_deref() {
        Some(raw) => Some(clean_required(raw, "diet.recipe.name", "recipe name")?),
        None => None,
    };
    if let Some(servings) = input.servings {
        validate_positive(servings, "diet.recipe.servings")?;
    }
    if let Some(yield_g) = input.yield_g {
        validate_positive(yield_g, "diet.recipe.yield")?;
    }
    let tags = match input.meal_tags {
        Some(tags) => Some(serialize_tags(tags)?),
        None => None,
    };

    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, &input.id, input.expected_rev_no).await?;

    // 준 필드만 UPDATE. COALESCE로 뭉개지 않는 이유: clear(NULL로 되돌리기)와
    // "안 줬음"을 SQL 한 문장에서 구분할 수 없다.
    if let Some(name) = name {
        sqlx::query("UPDATE recipes SET name = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&name)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(servings) = input.servings {
        sqlx::query("UPDATE recipes SET servings = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(servings)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(tags) = tags {
        sqlx::query("UPDATE recipes SET meal_tags = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&tags)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(minutes) = input.cook_minutes {
        sqlx::query("UPDATE recipes SET cook_minutes = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(minutes)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(url) = clean_optional(input.source_url) {
        sqlx::query("UPDATE recipes SET source_url = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&url)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(yield_g) = input.yield_g {
        sqlx::query("UPDATE recipes SET yield_g = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(yield_g)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(notes) = clean_optional(input.notes) {
        sqlx::query("UPDATE recipes SET notes = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&notes)
            .execute(&mut *tx)
            .await?;
    }
    for field in clears {
        let column = match field {
            RecipeClearableField::CookMinutes => "cook_minutes",
            RecipeClearableField::SourceUrl => "source_url",
            RecipeClearableField::YieldG => "yield_g",
            RecipeClearableField::Notes => "notes",
        };
        sqlx::query(&format!("UPDATE recipes SET {column} = NULL WHERE id = ?1"))
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }

    finish_mutation(
        &mut tx,
        &input.id,
        current,
        input.change_summary,
        input.changed_by,
    )
    .await?;
    tx.commit().await?;
    fetch_recipe(db, &input.id).await
}

pub(crate) async fn set_recipe_ingredient_inner(
    db: &Db,
    input: SetRecipeIngredientInput,
) -> Result<Recipe, AppError> {
    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, &input.recipe_id, input.expected_rev_no).await?;
    let conversions = load_conversions(&mut tx).await?;
    let resolved = resolve_ingredient(&input.ingredient, &conversions)?;

    let recipe = load_recipe(&mut tx, &input.recipe_id).await?;
    let mut ordered: Vec<ResolvedIngredient> = recipe
        .ingredients
        .iter()
        .map(|i| ResolvedIngredient {
            food_id: i.food_id.clone(),
            qty_g: i.qty_g,
            qty: i.qty,
            unit: i.unit.clone(),
            to_taste: i.to_taste,
            optional: i.optional,
            note: i.note.clone(),
        })
        .collect();

    match input.id.as_deref() {
        Some(target) => {
            let idx = recipe
                .ingredients
                .iter()
                .position(|i| i.id == target)
                .ok_or_else(|| {
                    AppError::not_found(
                        "diet.recipe.ingredient.missing",
                        "recipe ingredient not found",
                    )
                })?;
            ordered[idx] = resolved;
        }
        None => {
            let at = match input.after_index {
                None => ordered.len(),
                Some(after) if after <= 0 => 0,
                Some(after) => (after as usize).min(ordered.len()),
            };
            ordered.insert(at, resolved);
        }
    }

    write_ingredients(&mut tx, &input.recipe_id, &ordered).await?;
    finish_mutation(
        &mut tx,
        &input.recipe_id,
        current,
        input.change_summary,
        input.changed_by,
    )
    .await?;
    tx.commit().await?;
    fetch_recipe(db, &input.recipe_id).await
}

pub(crate) async fn remove_recipe_ingredient_inner(
    db: &Db,
    recipe_id: &str,
    ingredient_id: &str,
    expected_rev_no: Option<i32>,
    change_summary: Option<String>,
    changed_by: Option<RecipeEditor>,
) -> Result<Recipe, AppError> {
    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, recipe_id, expected_rev_no).await?;
    let deleted = sqlx::query("DELETE FROM recipe_ingredients WHERE id = ?1 AND recipe_id = ?2")
        .bind(ingredient_id)
        .bind(recipe_id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.recipe.ingredient.missing",
            "recipe ingredient not found",
        ));
    }
    // 남은 재료의 sort_rank를 재부여(구멍 제거).
    let recipe = load_recipe(&mut tx, recipe_id).await?;
    let ordered: Vec<ResolvedIngredient> = recipe
        .ingredients
        .iter()
        .map(|i| ResolvedIngredient {
            food_id: i.food_id.clone(),
            qty_g: i.qty_g,
            qty: i.qty,
            unit: i.unit.clone(),
            to_taste: i.to_taste,
            optional: i.optional,
            note: i.note.clone(),
        })
        .collect();
    write_ingredients(&mut tx, recipe_id, &ordered).await?;
    finish_mutation(&mut tx, recipe_id, current, change_summary, changed_by).await?;
    tx.commit().await?;
    fetch_recipe(db, recipe_id).await
}

fn steps_as_inputs(recipe: &Recipe) -> Vec<RecipeStepInput> {
    recipe
        .steps
        .iter()
        .map(|s| RecipeStepInput {
            body: s.body.clone(),
            duration_minutes: s.duration_minutes,
            note: s.note.clone(),
        })
        .collect()
}

pub(crate) async fn set_recipe_step_inner(
    db: &Db,
    input: SetRecipeStepInput,
) -> Result<Recipe, AppError> {
    let cleaned = clean_steps(std::slice::from_ref(&input.step))?;
    let Some(step) = cleaned.into_iter().next() else {
        return Err(AppError::validation(
            "diet.recipe.step.body",
            "step body is required",
        ));
    };

    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, &input.recipe_id, input.expected_rev_no).await?;
    let recipe = load_recipe(&mut tx, &input.recipe_id).await?;
    let mut steps = steps_as_inputs(&recipe);

    match input.step_no {
        // step_no = 1-based 파생 번호를 그 자리 교체로 해석.
        Some(no) => {
            let idx = usize::try_from(no)
                .ok()
                .and_then(|n| n.checked_sub(1))
                .filter(|idx| *idx < steps.len())
                .ok_or_else(|| {
                    AppError::not_found("diet.recipe.step.missing", "recipe step not found")
                })?;
            steps[idx] = step;
        }
        None => {
            let at = match input.after_step_no {
                None => steps.len(),
                Some(after) if after <= 0 => 0,
                Some(after) => (after as usize).min(steps.len()),
            };
            steps.insert(at, step);
        }
    }

    write_steps(&mut tx, &input.recipe_id, &steps).await?;
    finish_mutation(
        &mut tx,
        &input.recipe_id,
        current,
        input.change_summary,
        input.changed_by,
    )
    .await?;
    tx.commit().await?;
    fetch_recipe(db, &input.recipe_id).await
}

pub(crate) async fn remove_recipe_step_inner(
    db: &Db,
    recipe_id: &str,
    step_no: i32,
    expected_rev_no: Option<i32>,
    change_summary: Option<String>,
    changed_by: Option<RecipeEditor>,
) -> Result<Recipe, AppError> {
    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, recipe_id, expected_rev_no).await?;
    let recipe = load_recipe(&mut tx, recipe_id).await?;
    let mut steps = steps_as_inputs(&recipe);
    let idx = usize::try_from(step_no)
        .ok()
        .and_then(|n| n.checked_sub(1))
        .filter(|idx| *idx < steps.len())
        .ok_or_else(|| AppError::not_found("diet.recipe.step.missing", "recipe step not found"))?;
    steps.remove(idx);
    write_steps(&mut tx, recipe_id, &steps).await?;
    finish_mutation(&mut tx, recipe_id, current, change_summary, changed_by).await?;
    tx.commit().await?;
    fetch_recipe(db, recipe_id).await
}

pub(crate) async fn reorder_recipe_steps_inner(
    db: &Db,
    recipe_id: &str,
    order: &[i32],
    expected_rev_no: Option<i32>,
    change_summary: Option<String>,
    changed_by: Option<RecipeEditor>,
) -> Result<Recipe, AppError> {
    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, recipe_id, expected_rev_no).await?;
    let recipe = load_recipe(&mut tx, recipe_id).await?;
    let steps = steps_as_inputs(&recipe);

    // order는 현재 step_no(1-based)의 **완전 순열**이어야 한다. 부분 순열을 허용하면
    // 단계가 조용히 사라진다.
    let mut seen = vec![false; steps.len()];
    let mut reordered = Vec::with_capacity(steps.len());
    for no in order {
        let idx = usize::try_from(*no)
            .ok()
            .and_then(|n| n.checked_sub(1))
            .filter(|idx| *idx < steps.len())
            .ok_or_else(|| {
                AppError::validation(
                    "diet.recipe.step.order",
                    "order contains an unknown step_no",
                )
            })?;
        if seen[idx] {
            return Err(AppError::validation(
                "diet.recipe.step.order",
                "order contains a duplicate step_no",
            ));
        }
        seen[idx] = true;
        reordered.push(steps[idx].clone());
    }
    if reordered.len() != steps.len() {
        return Err(AppError::validation(
            "diet.recipe.step.order",
            "order must list every step exactly once",
        ));
    }

    write_steps(&mut tx, recipe_id, &reordered).await?;
    finish_mutation(&mut tx, recipe_id, current, change_summary, changed_by).await?;
    tx.commit().await?;
    fetch_recipe(db, recipe_id).await
}

// --- 리비전 조회 / 되돌리기 ------------------------------------------------

async fn revision_snapshot(
    conn: &mut SqliteConnection,
    recipe_id: &str,
    rev_no: i32,
) -> Result<RecipeSnapshot, AppError> {
    let json: String = sqlx::query_scalar(
        "SELECT snapshot_json FROM recipe_revisions WHERE recipe_id = ?1 AND rev_no = ?2",
    )
    .bind(recipe_id)
    .bind(rev_no)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::not_found("diet.recipe.revision.missing", "revision not found"))?;
    serde_json::from_str(&json)
        .map_err(|e| AppError::unexpected("diet.recipe.revision.parse", e.to_string()))
}

pub(crate) async fn list_recipe_revisions_inner(
    db: &Db,
    recipe_id: &str,
) -> Result<Vec<RecipeRevision>, AppError> {
    Ok(
        sqlx::query_as::<_, (String, String, i32, Option<String>, RecipeEditor, String)>(
            "SELECT id, recipe_id, rev_no, change_summary, changed_by, created_at \
           FROM recipe_revisions WHERE recipe_id = ?1 ORDER BY rev_no DESC",
        )
        .bind(recipe_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(
            |(id, recipe_id, rev_no, change_summary, changed_by, created_at)| RecipeRevision {
                id,
                recipe_id,
                rev_no,
                change_summary,
                changed_by,
                created_at,
            },
        )
        .collect(),
    )
}

pub(crate) async fn get_recipe_revision_inner(
    db: &Db,
    recipe_id: &str,
    rev_no: i32,
) -> Result<RecipeRevisionDetail, AppError> {
    let mut conn = db.acquire().await?;
    let row = sqlx::query_as::<_, (String, String, i32, Option<String>, RecipeEditor, String)>(
        "SELECT id, recipe_id, rev_no, change_summary, changed_by, created_at \
           FROM recipe_revisions WHERE recipe_id = ?1 AND rev_no = ?2",
    )
    .bind(recipe_id)
    .bind(rev_no)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::not_found("diet.recipe.revision.missing", "revision not found"))?;

    let snapshot = revision_snapshot(&mut conn, recipe_id, rev_no).await?;
    // 직전 rev가 없으면(=최초) diff는 빈 목록 — 없는 비교를 꾸미지 않는다.
    let diff_from_previous: Vec<RecipeDiffEntry> =
        match previous_rev_no(&mut conn, recipe_id, rev_no).await? {
            Some(prev) => {
                let before = revision_snapshot(&mut conn, recipe_id, prev).await?;
                diet::revision_diff(&before, &snapshot)
            }
            None => Vec::new(),
        };

    Ok(RecipeRevisionDetail {
        revision: RecipeRevision {
            id: row.0,
            recipe_id: row.1,
            rev_no: row.2,
            change_summary: row.3,
            changed_by: row.4,
            created_at: row.5,
        },
        snapshot,
        diff_from_previous,
    })
}

async fn previous_rev_no(
    conn: &mut SqliteConnection,
    recipe_id: &str,
    rev_no: i32,
) -> Result<Option<i32>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT max(rev_no) FROM recipe_revisions WHERE recipe_id = ?1 AND rev_no < ?2",
    )
    .bind(recipe_id)
    .bind(rev_no)
    .fetch_one(&mut *conn)
    .await?)
}

/// 되돌리기 = 과거 스냅샷을 **새 rev로 재적용**(append-only). 이력을 재작성하지 않는다.
pub(crate) async fn revert_recipe_inner(
    db: &Db,
    recipe_id: &str,
    rev_no: i32,
    expected_rev_no: Option<i32>,
    changed_by: Option<RecipeEditor>,
) -> Result<Recipe, AppError> {
    let mut tx = db.begin().await?;
    let current = begin_mutation(&mut tx, recipe_id, expected_rev_no).await?;
    let snapshot = revision_snapshot(&mut tx, recipe_id, rev_no).await?;
    let (ingredient_inputs, step_inputs) = diet::snapshot_to_inputs(&snapshot);
    // qty_g가 스냅샷 값으로 실려오므로 환산 테이블이 그 사이 바뀌어도 g은 그대로다.
    let ingredients = resolve_ingredients(&mut tx, &ingredient_inputs).await?;
    let tags = serialize_tags(snapshot.meal_tags.clone())?;

    sqlx::query(
        "UPDATE recipes SET name = ?2, servings = ?3, cook_minutes = ?4, meal_tags = ?5, \
           source_url = ?6, yield_g = ?7, notes = ?8 WHERE id = ?1",
    )
    .bind(recipe_id)
    .bind(&snapshot.name)
    .bind(snapshot.servings)
    .bind(snapshot.cook_minutes)
    .bind(&tags)
    .bind(snapshot.source_url.as_deref())
    .bind(snapshot.yield_g)
    .bind(snapshot.notes.as_deref())
    .execute(&mut *tx)
    .await?;
    write_ingredients(&mut tx, recipe_id, &ingredients).await?;
    write_steps(&mut tx, recipe_id, &step_inputs).await?;
    finish_mutation(
        &mut tx,
        recipe_id,
        current,
        Some(format!("reverted to rev {rev_no}")),
        changed_by,
    )
    .await?;
    tx.commit().await?;
    fetch_recipe(db, recipe_id).await
}

// --- 맛 피드백 ------------------------------------------------------------

fn validate_delta(value: Option<i32>, code: &'static str) -> Result<(), AppError> {
    match value {
        Some(v) if !(-2..=2).contains(&v) => Err(AppError::validation(
            code,
            "taste delta must be between -2 and 2",
        )),
        _ => Ok(()),
    }
}

pub(crate) async fn add_recipe_feedback_inner(
    db: &Db,
    input: AddRecipeFeedbackInput,
) -> Result<RecipeTasteSummary, AppError> {
    if let Some(rating) = input.rating {
        if !(1..=5).contains(&rating) {
            return Err(AppError::validation(
                "diet.recipe.feedback.rating",
                "rating must be between 1 and 5",
            ));
        }
    }
    validate_delta(input.salt_delta, "diet.recipe.feedback.salt")?;
    validate_delta(input.spice_delta, "diet.recipe.feedback.spice")?;
    validate_delta(input.sweet_delta, "diet.recipe.feedback.sweet")?;
    validate_delta(input.sour_delta, "diet.recipe.feedback.sour")?;
    validate_delta(input.richness_delta, "diet.recipe.feedback.richness")?;
    validate_delta(input.doneness_delta, "diet.recipe.feedback.doneness")?;

    let mut tx = db.begin().await?;
    // 어느 리비전을 먹은 평가인지 — 미지정이면 현재 rev로 귀속(나중에 축 집계가 의미를 갖는다).
    let current: i32 = sqlx::query_scalar("SELECT rev_no FROM recipes WHERE id = ?1")
        .bind(&input.recipe_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::not_found("diet.recipe.missing", "recipe not found"))?;
    let rev_no = input.rev_no.unwrap_or(current);

    sqlx::query(
        "INSERT INTO recipe_feedback \
           (id, recipe_id, rev_no, meal_log_id, rating, salt_delta, spice_delta, sweet_delta, \
            sour_delta, richness_delta, doneness_delta, comment) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
    .bind(new_id())
    .bind(&input.recipe_id)
    .bind(rev_no)
    .bind(clean_optional(input.meal_log_id).as_deref())
    .bind(input.rating)
    .bind(input.salt_delta)
    .bind(input.spice_delta)
    .bind(input.sweet_delta)
    .bind(input.sour_delta)
    .bind(input.richness_delta)
    .bind(input.doneness_delta)
    .bind(clean_optional(input.comment).as_deref())
    .execute(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
            AppError::validation("diet.recipe.feedback.meal_log", "meal log not found")
        }
        other => AppError::from(other),
    })?;
    tx.commit().await?;

    recipe_taste_summary_inner(db, &input.recipe_id, None).await
}

pub(crate) async fn recipe_taste_summary_inner(
    db: &Db,
    recipe_id: &str,
    limit: Option<i32>,
) -> Result<RecipeTasteSummary, AppError> {
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let rows = sqlx::query_as::<_, FeedbackRow>(
        "SELECT id, recipe_id, rev_no, meal_log_id, rating, salt_delta, spice_delta, sweet_delta, \
                sour_delta, richness_delta, doneness_delta, comment, created_at \
           FROM recipe_feedback WHERE recipe_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
    )
    .bind(recipe_id)
    .bind(limit)
    .fetch_all(db)
    .await?;

    // 커널은 **최신 우선** 순서를 전제로 최근 가중을 준다 — 위 ORDER BY와 계약이 맞물린다.
    let samples: Vec<diet::TasteFeedbackSample> = rows
        .iter()
        .map(|r| diet::TasteFeedbackSample {
            salt: r.salt_delta,
            spice: r.spice_delta,
            sweet: r.sweet_delta,
            sour: r.sour_delta,
            richness: r.richness_delta,
            doneness: r.doneness_delta,
        })
        .collect();
    let hints = diet::taste_hints(&samples);

    let ratings: Vec<f64> = rows
        .iter()
        .filter_map(|r| r.rating.map(f64::from))
        .collect();
    let avg_rating = if ratings.is_empty() {
        None
    } else {
        Some(ratings.iter().sum::<f64>() / ratings.len() as f64)
    };

    Ok(RecipeTasteSummary {
        sample_count: rows.len() as i32,
        avg_rating,
        hints,
        recent: rows.into_iter().map(RecipeFeedback::from).collect(),
    })
}

#[derive(Debug, sqlx::FromRow)]
struct FeedbackRow {
    id: String,
    recipe_id: String,
    rev_no: Option<i32>,
    meal_log_id: Option<String>,
    rating: Option<i32>,
    salt_delta: Option<i32>,
    spice_delta: Option<i32>,
    sweet_delta: Option<i32>,
    sour_delta: Option<i32>,
    richness_delta: Option<i32>,
    doneness_delta: Option<i32>,
    comment: Option<String>,
    created_at: String,
}

impl From<FeedbackRow> for RecipeFeedback {
    fn from(r: FeedbackRow) -> Self {
        RecipeFeedback {
            id: r.id,
            recipe_id: r.recipe_id,
            rev_no: r.rev_no,
            meal_log_id: r.meal_log_id,
            rating: r.rating,
            salt_delta: r.salt_delta,
            spice_delta: r.spice_delta,
            sweet_delta: r.sweet_delta,
            sour_delta: r.sour_delta,
            richness_delta: r.richness_delta,
            doneness_delta: r.doneness_delta,
            comment: r.comment,
            created_at: r.created_at,
        }
    }
}

// --- 스케일링 --------------------------------------------------------------

/// 식품별 가용 재고(g) 집계. 미입고 주문은 포함하지 않는다(장보기 계산과 의미 분리).
pub(crate) async fn available_by_food(
    conn: &mut SqliteConnection,
    food_ids: &[String],
) -> Result<Vec<(String, f64)>, AppError> {
    if food_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", food_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    // COALESCE 기본값은 반드시 `0.0` — `0`이면 SQLite가 INTEGER를 돌려주고 f64 디코드가 깨진다.
    let sql = format!(
        "SELECT food_id, COALESCE(SUM(remaining_qty_g), 0.0) \
           FROM pantry_lots WHERE food_id IN ({placeholders}) GROUP BY food_id"
    );
    let mut query = sqlx::query_as::<_, (String, f64)>(&sql);
    for id in food_ids {
        query = query.bind(id);
    }
    Ok(query.fetch_all(&mut *conn).await?)
}

pub(crate) async fn scaled_recipe_inner(
    db: &Db,
    recipe_id: &str,
    target_servings: Option<f64>,
) -> Result<ScaledRecipe, AppError> {
    let mut conn = db.acquire().await?;
    let recipe = load_recipe(&mut conn, recipe_id).await?;
    let target = target_servings.unwrap_or(recipe.servings);
    validate_positive(target, "diet.recipe.scale.servings")?;
    let factor = diet::scale_factor(recipe.servings, target);

    let food_ids: Vec<String> = recipe
        .ingredients
        .iter()
        .map(|i| i.food_id.clone())
        .collect();
    let available = available_by_food(&mut conn, &food_ids).await?;

    let mut ingredients = Vec::with_capacity(recipe.ingredients.len());
    let mut need_total = 0.0;
    let mut covered_total = 0.0;
    let mut missing_count = 0;
    for ing in &recipe.ingredients {
        let qty_g = ing.qty_g * factor;
        let have = available
            .iter()
            .find(|(food, _)| food == &ing.food_id)
            .map(|(_, g)| *g)
            .unwrap_or(0.0);
        let shortfall = (qty_g - have).max(0.0);
        need_total += qty_g;
        covered_total += qty_g.min(have);
        if shortfall > 0.0 {
            missing_count += 1;
        }
        ingredients.push(ScaledIngredient {
            food_id: ing.food_id.clone(),
            food_name: ing.food_name.clone(),
            qty_g,
            display: match (ing.qty, ing.unit.as_deref()) {
                (Some(qty), Some(unit)) => Some(format!("{} {}", trim_num(qty * factor), unit)),
                _ => None,
            },
            available_g: have,
            shortfall_g: shortfall,
            optional: ing.optional,
            to_taste: ing.to_taste,
        });
    }

    let total = diet::scale_macros(&recipe.total, factor);
    Ok(ScaledRecipe {
        recipe_id: recipe.id,
        name: recipe.name,
        base_servings: recipe.servings,
        target_servings: target,
        factor,
        ingredients,
        per_serving: diet::per_serving(&total, target),
        total,
        coverage_pct: if need_total <= 0.0 {
            100.0
        } else {
            covered_total / need_total * 100.0
        },
        missing_count,
    })
}

fn trim_num(v: f64) -> String {
    if (v.fract()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

// --- 단위 환산 관리 --------------------------------------------------------

pub(crate) async fn list_unit_conversions_inner(db: &Db) -> Result<Vec<UnitConversion>, AppError> {
    Ok(sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            Option<String>,
            f64,
            Option<String>,
        ),
    >(
        "SELECT uc.id, uc.unit, uc.food_id, f.name, uc.grams_per_unit, uc.note \
           FROM unit_conversions uc LEFT JOIN foods f ON f.id = uc.food_id \
          ORDER BY uc.unit, (uc.food_id IS NOT NULL), f.name",
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(
        |(id, unit, food_id, food_name, grams_per_unit, note)| UnitConversion {
            id,
            unit,
            food_id,
            food_name,
            grams_per_unit,
            note,
        },
    )
    .collect())
}

pub(crate) async fn upsert_unit_conversion_inner(
    db: &Db,
    input: UpsertUnitConversionInput,
) -> Result<Vec<UnitConversion>, AppError> {
    let unit = clean_required(&input.unit, "diet.unit_conversion.unit", "unit")?.to_lowercase();
    validate_positive(input.grams_per_unit, "diet.unit_conversion.grams")?;
    let food_id = clean_optional(input.food_id);
    let note = clean_optional(input.note);

    // 부분 유니크 인덱스가 (unit, NULL)과 (unit, food)를 각각 하나로 고정한다 —
    // ON CONFLICT 대상 인덱스를 WHERE로 지목해야 upsert가 성립한다.
    match food_id.as_deref() {
        None => {
            sqlx::query(
                "INSERT INTO unit_conversions (id, unit, food_id, grams_per_unit, note) \
                 VALUES (?1, ?2, NULL, ?3, ?4) \
                 ON CONFLICT (unit) WHERE food_id IS NULL \
                 DO UPDATE SET grams_per_unit = excluded.grams_per_unit, note = excluded.note, \
                               updated_at = datetime('now')",
            )
            .bind(new_id())
            .bind(&unit)
            .bind(input.grams_per_unit)
            .bind(note.as_deref())
            .execute(db)
            .await?;
        }
        Some(food) => {
            sqlx::query(
                "INSERT INTO unit_conversions (id, unit, food_id, grams_per_unit, note) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT (unit, food_id) WHERE food_id IS NOT NULL \
                 DO UPDATE SET grams_per_unit = excluded.grams_per_unit, note = excluded.note, \
                               updated_at = datetime('now')",
            )
            .bind(new_id())
            .bind(&unit)
            .bind(food)
            .bind(input.grams_per_unit)
            .bind(note.as_deref())
            .execute(db)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
                    AppError::validation("diet.unit_conversion.food", "food not found")
                }
                other => AppError::from(other),
            })?;
        }
    }
    list_unit_conversions_inner(db).await
}

// --- 목록 / 아카이브 -------------------------------------------------------

pub(crate) async fn list_recipes_inner(
    db: &Db,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Recipe>, AppError> {
    let query = clean_optional(query);
    let mut conn = db.acquire().await?;
    let ids: Vec<String> = match query {
        Some(q) => {
            let like = format!("%{}%", q.to_lowercase());
            sqlx::query_scalar(
                "SELECT id FROM recipes WHERE (?1 OR archived = 0) AND lower(name) LIKE ?2 \
                 ORDER BY name",
            )
            .bind(include_archived)
            .bind(&like)
            .fetch_all(&mut *conn)
            .await?
        }
        None => {
            sqlx::query_scalar("SELECT id FROM recipes WHERE (?1 OR archived = 0) ORDER BY name")
                .bind(include_archived)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    let mut recipes = Vec::with_capacity(ids.len());
    for id in ids {
        recipes.push(load_recipe(&mut conn, &id).await?);
    }
    Ok(recipes)
}

pub(crate) async fn set_recipe_archived_inner(
    db: &Db,
    id: &str,
    archived: bool,
) -> Result<Recipe, AppError> {
    let updated =
        sqlx::query("UPDATE recipes SET archived = ?2, updated_at = datetime('now') WHERE id = ?1")
            .bind(id)
            .bind(archived)
            .execute(db)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.recipe.missing",
            "recipe not found",
        ));
    }
    fetch_recipe(db, id).await
}

// --- tauri 커맨드 ----------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn create_recipe(
    db: State<'_, Db>,
    input: CreateRecipeInput,
) -> Result<Recipe, AppError> {
    create_recipe_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_recipe(
    db: State<'_, Db>,
    input: UpdateRecipeInput,
) -> Result<Recipe, AppError> {
    update_recipe_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn patch_recipe(db: State<'_, Db>, input: PatchRecipeInput) -> Result<Recipe, AppError> {
    patch_recipe_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_recipe_ingredient(
    db: State<'_, Db>,
    input: SetRecipeIngredientInput,
) -> Result<Recipe, AppError> {
    set_recipe_ingredient_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_recipe_ingredient(
    db: State<'_, Db>,
    recipe_id: String,
    ingredient_id: String,
    expected_rev_no: Option<i32>,
    change_summary: Option<String>,
) -> Result<Recipe, AppError> {
    remove_recipe_ingredient_inner(
        db.inner(),
        &recipe_id,
        &ingredient_id,
        expected_rev_no,
        change_summary,
        None,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_recipe_step(
    db: State<'_, Db>,
    input: SetRecipeStepInput,
) -> Result<Recipe, AppError> {
    set_recipe_step_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_recipe_step(
    db: State<'_, Db>,
    recipe_id: String,
    step_no: i32,
    expected_rev_no: Option<i32>,
    change_summary: Option<String>,
) -> Result<Recipe, AppError> {
    remove_recipe_step_inner(
        db.inner(),
        &recipe_id,
        step_no,
        expected_rev_no,
        change_summary,
        None,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_recipe_steps(
    db: State<'_, Db>,
    recipe_id: String,
    order: Vec<i32>,
    expected_rev_no: Option<i32>,
) -> Result<Recipe, AppError> {
    reorder_recipe_steps_inner(db.inner(), &recipe_id, &order, expected_rev_no, None, None).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_recipe_revisions(
    db: State<'_, Db>,
    recipe_id: String,
) -> Result<Vec<RecipeRevision>, AppError> {
    list_recipe_revisions_inner(db.inner(), &recipe_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_recipe_revision(
    db: State<'_, Db>,
    recipe_id: String,
    rev_no: i32,
) -> Result<RecipeRevisionDetail, AppError> {
    get_recipe_revision_inner(db.inner(), &recipe_id, rev_no).await
}

#[tauri::command]
#[specta::specta]
pub async fn revert_recipe(
    db: State<'_, Db>,
    recipe_id: String,
    rev_no: i32,
    expected_rev_no: Option<i32>,
) -> Result<Recipe, AppError> {
    revert_recipe_inner(db.inner(), &recipe_id, rev_no, expected_rev_no, None).await
}

#[tauri::command]
#[specta::specta]
pub async fn add_recipe_feedback(
    db: State<'_, Db>,
    input: AddRecipeFeedbackInput,
) -> Result<RecipeTasteSummary, AppError> {
    add_recipe_feedback_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn recipe_taste_summary(
    db: State<'_, Db>,
    recipe_id: String,
    limit: Option<i32>,
) -> Result<RecipeTasteSummary, AppError> {
    recipe_taste_summary_inner(db.inner(), &recipe_id, limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn scaled_recipe(
    db: State<'_, Db>,
    recipe_id: String,
    target_servings: Option<f64>,
) -> Result<ScaledRecipe, AppError> {
    scaled_recipe_inner(db.inner(), &recipe_id, target_servings).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_unit_conversions(db: State<'_, Db>) -> Result<Vec<UnitConversion>, AppError> {
    list_unit_conversions_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_unit_conversion(
    db: State<'_, Db>,
    input: UpsertUnitConversionInput,
) -> Result<Vec<UnitConversion>, AppError> {
    upsert_unit_conversion_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_recipe(db: State<'_, Db>, id: String) -> Result<Recipe, AppError> {
    fetch_recipe(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_recipes(
    db: State<'_, Db>,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Recipe>, AppError> {
    list_recipes_inner(db.inner(), query, include_archived).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_recipe_archived(
    db: State<'_, Db>,
    id: String,
    archived: bool,
) -> Result<Recipe, AppError> {
    set_recipe_archived_inner(db.inner(), &id, archived).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{CreateRecipeInput, RecipeIngredientInput};

    pub(crate) fn ingredient(food_id: String, qty_g: f64) -> RecipeIngredientInput {
        RecipeIngredientInput {
            food_id,
            qty_g: Some(qty_g),
            qty: None,
            unit: None,
            to_taste: false,
            optional: false,
            note: None,
        }
    }

    /// (food는 호출자가 seed.)
    pub(crate) async fn seed_recipe(
        db: &Db,
        name: &str,
        servings: f64,
        ingredients: Vec<(String, f64)>,
    ) -> String {
        super::create_recipe_inner(
            db,
            CreateRecipeInput {
                name: name.into(),
                servings,
                cook_minutes: Some(25),
                meal_tags: vec!["dinner".into()],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: ingredients
                    .into_iter()
                    .map(|(food_id, qty_g)| ingredient(food_id, qty_g))
                    .collect(),
                steps: vec![],
                changed_by: None,
            },
        )
        .await
        .expect("seed recipe")
        .id
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{ingredient, seed_recipe};
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::shared::test_support::fresh_db;
    use crate::db::Db;
    use crate::models::{
        AddRecipeFeedbackInput, CreateRecipeInput, PatchRecipeInput, RecipeClearableField,
        RecipeEditor, RecipeIngredientInput, RecipeStepInput, SetRecipeIngredientInput,
        SetRecipeStepInput, UpdateRecipeInput, UpsertUnitConversionInput,
    };

    fn step(body: &str) -> RecipeStepInput {
        RecipeStepInput {
            body: body.into(),
            duration_minutes: None,
            note: None,
        }
    }

    async fn seed_with_steps(db: &Db, food: String) -> String {
        super::create_recipe_inner(
            db,
            CreateRecipeInput {
                name: "된장찌개".into(),
                servings: 2.0,
                cook_minutes: Some(20),
                meal_tags: vec!["dinner".into()],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![ingredient(food, 100.0)],
                steps: vec![
                    step("육수를 끓인다"),
                    step("된장을 푼다"),
                    step("두부를 넣는다"),
                ],
                changed_by: None,
            },
        )
        .await
        .expect("seed")
        .id
    }

    #[tokio::test]
    async fn recipe_nutrition_is_computed_from_ingredients_at_query_time() {
        let db = fresh_db().await;
        let pasta = seed_food(&db, "파스타면", 371.0, 13.0).await;
        let oil = seed_food(&db, "올리브오일", 884.0, 0.0).await;
        let recipe_id = seed_recipe(
            &db,
            "알리오 올리오",
            2.0,
            vec![(pasta.clone(), 160.0), (oil, 20.0)],
        )
        .await;

        let recipe = super::fetch_recipe(&db, &recipe_id).await.unwrap();
        // 371×1.6 + 884×0.2 = 593.6 + 176.8 = 770.4 kcal 전체, 1인분 385.2.
        assert!((recipe.total.kcal - 770.4).abs() < 1e-9);
        assert!((recipe.per_serving.kcal - 385.2).abs() < 1e-9);
        assert_eq!(recipe.ingredients.len(), 2);
        assert_eq!(recipe.ingredients[0].food_name, "파스타면");
        assert_eq!(recipe.rev_no, 1, "생성이 rev 1");

        // food 영양 수정 → 레시피 조회값도 따라간다(저장 스냅샷 아님).
        sqlx::query("UPDATE foods SET kcal_per_100g = 400.0 WHERE id = ?1")
            .bind(&pasta)
            .execute(&db)
            .await
            .unwrap();
        let after = super::fetch_recipe(&db, &recipe_id).await.unwrap();
        assert!((after.total.kcal - (400.0 * 1.6 + 176.8)).abs() < 1e-9);
    }

    #[tokio::test]
    async fn unknown_ingredient_food_is_a_validation_error_and_rolls_back() {
        let db = fresh_db().await;
        let result = super::create_recipe_inner(
            &db,
            CreateRecipeInput {
                name: "유령 레시피".into(),
                servings: 1.0,
                cook_minutes: None,
                meal_tags: vec![],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![ingredient("ghost".into(), 100.0)],
                steps: vec![],
                changed_by: None,
            },
        )
        .await;
        assert!(result.is_err());
        let count: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM recipes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "tx 롤백 — 반쪽 레시피 없음");
    }

    #[tokio::test]
    async fn steps_are_stored_ordered_and_numbered_at_query_time() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;
        let recipe = super::fetch_recipe(&db, &id).await.unwrap();
        assert_eq!(
            recipe
                .steps
                .iter()
                .map(|s| (s.step_no, s.body.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1, "육수를 끓인다"),
                (2, "된장을 푼다"),
                (3, "두부를 넣는다")
            ]
        );
    }

    #[tokio::test]
    async fn qty_and_unit_are_converted_to_grams_with_food_specific_precedence() {
        let db = fresh_db().await;
        let salt = seed_food(&db, "소금", 0.0, 0.0).await;
        // 전역 tsp=5g가 0075 seed로 이미 있다. 소금 전용 6g을 덮어쓴다.
        super::upsert_unit_conversion_inner(
            &db,
            UpsertUnitConversionInput {
                unit: "TSP".into(), // 대문자 → 소문자 정규화
                food_id: Some(salt.clone()),
                grams_per_unit: 6.0,
                note: None,
            },
        )
        .await
        .unwrap();

        let recipe = super::create_recipe_inner(
            &db,
            CreateRecipeInput {
                name: "간 맞추기".into(),
                servings: 1.0,
                cook_minutes: None,
                meal_tags: vec![],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![RecipeIngredientInput {
                    food_id: salt,
                    qty_g: None,
                    qty: Some(2.0),
                    unit: Some("tsp".into()),
                    to_taste: true,
                    optional: false,
                    note: None,
                }],
                steps: vec![],
                changed_by: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(recipe.ingredients[0].qty_g, 12.0, "소금 전용 6g/tsp × 2");
        assert_eq!(recipe.ingredients[0].unit.as_deref(), Some("tsp"));
        assert!(recipe.ingredients[0].to_taste);
    }

    #[tokio::test]
    async fn unknown_unit_is_rejected_rather_than_silently_zeroed() {
        let db = fresh_db().await;
        let food = seed_food(&db, "무엇", 10.0, 1.0).await;
        let err = super::create_recipe_inner(
            &db,
            CreateRecipeInput {
                name: "미지의 단위".into(),
                servings: 1.0,
                cook_minutes: None,
                meal_tags: vec![],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![RecipeIngredientInput {
                    food_id: food,
                    qty_g: None,
                    qty: Some(1.0),
                    unit: Some("handful".into()),
                    to_taste: false,
                    optional: false,
                    note: None,
                }],
                steps: vec![],
                changed_by: None,
            },
        )
        .await
        .expect_err("환산 없는 단위는 거부");
        assert!(format!("{err:?}").contains("handful"));
        let count: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM recipes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn patch_touches_only_given_fields_and_clear_nulls_them() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;

        let patched = super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                name: Some("된장찌개 (싱겁게)".into()),
                notes: Some("된장 2/3만".into()),
                change_summary: Some("간 조절".into()),
                changed_by: Some(RecipeEditor::Agent),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(patched.name, "된장찌개 (싱겁게)");
        assert_eq!(patched.notes.as_deref(), Some("된장 2/3만"));
        assert_eq!(patched.cook_minutes, Some(20), "안 준 필드는 그대로");
        assert_eq!(patched.steps.len(), 3, "patch는 단계를 건드리지 않는다");
        assert_eq!(patched.rev_no, 2);

        let cleared = super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                clear: vec![
                    RecipeClearableField::CookMinutes,
                    RecipeClearableField::Notes,
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(cleared.cook_minutes, None);
        assert_eq!(cleared.notes, None);
        assert_eq!(
            cleared.name, "된장찌개 (싱겁게)",
            "clear는 다른 필드 무영향"
        );
    }

    #[tokio::test]
    async fn patch_rejects_setting_and_clearing_the_same_field() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;
        let err = super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                notes: Some("무언가".into()),
                clear: vec![RecipeClearableField::Notes],
                ..Default::default()
            },
        )
        .await
        .expect_err("값과 clear 동시 지정은 모순");
        assert!(format!("{err:?}").contains("cleared"));
        // 모순 입력은 리비전도 만들지 않는다.
        let recipe = super::fetch_recipe(&db, &id).await.unwrap();
        assert_eq!(recipe.rev_no, 1);
    }

    #[tokio::test]
    async fn expected_rev_no_mismatch_is_rejected() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;

        // 누군가 먼저 고쳐서 rev가 2가 된 상황.
        super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                name: Some("먼저 고침".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let err = super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                expected_rev_no: Some(1), // stale
                name: Some("에이전트가 덮어쓰려 함".into()),
                ..Default::default()
            },
        )
        .await
        .expect_err("stale rev는 거부");
        assert!(format!("{err:?}").contains("rev_conflict"));
        let recipe = super::fetch_recipe(&db, &id).await.unwrap();
        assert_eq!(recipe.name, "먼저 고침", "덮어쓰기가 실제로 막혔다");
    }

    #[tokio::test]
    async fn replace_all_update_cannot_skip_the_concurrency_token() {
        // critic 지적 회귀 가드: 전체 교체 경로는 토큰이 **필수**다(타입으로 강제 — Option 아님).
        // stale 전문으로 저장을 시도하면 거부되어, 그 사이의 편집이 조용히 사라지지 않는다.
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu.clone()).await;

        // A가 rev 1을 읽고 단계를 고쳐 rev 2로 만든다.
        super::set_recipe_step_inner(
            &db,
            SetRecipeStepInput {
                recipe_id: id.clone(),
                expected_rev_no: Some(1),
                step_no: Some(1),
                after_step_no: None,
                step: step("A가 고친 1단계"),
                change_summary: None,
                changed_by: Some(RecipeEditor::Agent),
            },
        )
        .await
        .unwrap();

        // B는 여전히 rev 1 스냅샷을 들고 전문 저장을 시도한다.
        let err = super::update_recipe_inner(
            &db,
            UpdateRecipeInput {
                id: id.clone(),
                expected_rev_no: 1,
                name: "B의 오래된 전문".into(),
                servings: 2.0,
                cook_minutes: None,
                meal_tags: vec![],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![ingredient(tofu, 100.0)],
                steps: vec![step("B가 들고 있던 1단계")],
                change_summary: None,
                changed_by: None,
            },
        )
        .await
        .expect_err("stale 전체 교체는 거부");
        assert!(format!("{err:?}").contains("rev_conflict"));

        let after = super::fetch_recipe(&db, &id).await.unwrap();
        assert_eq!(
            after.steps[0].body, "A가 고친 1단계",
            "A의 수정이 살아 있다"
        );
        assert_eq!(after.rev_no, 2);
    }

    #[tokio::test]
    async fn archiving_is_deliberately_outside_the_revision_contract() {
        // 보관은 내용이 아니라 라이브러리 가시성 플래그다 — 리비전을 만들지 않고, 되돌리기가
        // 보관 상태를 되살리지도 않는다(그러면 조리법만 되돌렸는데 레시피가 다시 튀어나온다).
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;

        super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                name: Some("v2".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let archived = super::set_recipe_archived_inner(&db, &id, true)
            .await
            .unwrap();
        assert!(archived.archived);
        assert_eq!(archived.rev_no, 2, "보관은 리비전을 전진시키지 않는다");
        assert_eq!(
            super::list_recipe_revisions_inner(&db, &id)
                .await
                .unwrap()
                .len(),
            2
        );

        // 내용만 rev 1로 되돌려도 보관 상태는 유지된다.
        let reverted = super::revert_recipe_inner(&db, &id, 1, None, None)
            .await
            .unwrap();
        assert_eq!(reverted.name, "된장찌개");
        assert!(reverted.archived, "되돌리기가 보관 상태를 되살리지 않는다");
    }

    #[tokio::test]
    async fn set_step_replaces_by_derived_number_and_insert_renumbers() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;

        // 3단계만 고친다 — 나머지는 그대로.
        let after = super::set_recipe_step_inner(
            &db,
            SetRecipeStepInput {
                recipe_id: id.clone(),
                expected_rev_no: Some(1),
                step_no: Some(2),
                after_step_no: None,
                step: RecipeStepInput {
                    body: "된장을 2/3만 푼다".into(),
                    duration_minutes: Some(3),
                    note: Some("짜면 더 줄이기".into()),
                },
                change_summary: Some("간장 줄임".into()),
                changed_by: Some(RecipeEditor::Agent),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            after
                .steps
                .iter()
                .map(|s| s.body.as_str())
                .collect::<Vec<_>>(),
            vec!["육수를 끓인다", "된장을 2/3만 푼다", "두부를 넣는다"]
        );
        assert_eq!(after.steps[1].duration_minutes, Some(3));

        // 1단계 뒤에 삽입 → 번호가 밀린다.
        let inserted = super::set_recipe_step_inner(
            &db,
            SetRecipeStepInput {
                recipe_id: id.clone(),
                expected_rev_no: None,
                step_no: None,
                after_step_no: Some(1),
                step: step("멸치를 건진다"),
                change_summary: None,
                changed_by: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            inserted
                .steps
                .iter()
                .map(|s| (s.step_no, s.body.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1, "육수를 끓인다"),
                (2, "멸치를 건진다"),
                (3, "된장을 2/3만 푼다"),
                (4, "두부를 넣는다"),
            ]
        );
    }

    #[tokio::test]
    async fn reorder_requires_a_complete_permutation() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;

        // 부분 목록은 단계를 조용히 지워버릴 수 있으므로 거부.
        let err = super::reorder_recipe_steps_inner(&db, &id, &[2, 1], None, None, None)
            .await
            .expect_err("부분 순열 거부");
        assert!(format!("{err:?}").contains("every step"));
        // 중복도 거부.
        assert!(
            super::reorder_recipe_steps_inner(&db, &id, &[1, 1, 2], None, None, None)
                .await
                .is_err()
        );
        assert_eq!(
            super::fetch_recipe(&db, &id).await.unwrap().steps.len(),
            3,
            "실패한 재정렬이 단계를 삭제하지 않았다"
        );

        let ok = super::reorder_recipe_steps_inner(&db, &id, &[3, 1, 2], None, None, None)
            .await
            .unwrap();
        assert_eq!(
            ok.steps.iter().map(|s| s.body.as_str()).collect::<Vec<_>>(),
            vec!["두부를 넣는다", "육수를 끓인다", "된장을 푼다"]
        );
    }

    #[tokio::test]
    async fn ingredient_upsert_replaces_one_row_and_keeps_the_others() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let paste = seed_food(&db, "된장", 190.0, 12.0).await;
        let id = seed_recipe(
            &db,
            "된장찌개",
            2.0,
            vec![(tofu, 150.0), (paste.clone(), 30.0)],
        )
        .await;

        let before = super::fetch_recipe(&db, &id).await.unwrap();
        let paste_row = before
            .ingredients
            .iter()
            .find(|i| i.food_id == paste)
            .unwrap()
            .id
            .clone();

        let after = super::set_recipe_ingredient_inner(
            &db,
            SetRecipeIngredientInput {
                recipe_id: id.clone(),
                expected_rev_no: Some(1),
                id: Some(paste_row),
                ingredient: ingredient(paste.clone(), 20.0),
                after_index: None,
                change_summary: Some("된장 30g → 20g (너무 짰음)".into()),
                changed_by: Some(RecipeEditor::Agent),
            },
        )
        .await
        .unwrap();
        assert_eq!(after.ingredients.len(), 2, "다른 재료는 그대로");
        assert_eq!(
            after
                .ingredients
                .iter()
                .find(|i| i.food_id == paste)
                .unwrap()
                .qty_g,
            20.0
        );
        // sort_rank가 0,1로 유지(구멍 없음).
        assert_eq!(
            after
                .ingredients
                .iter()
                .map(|i| i.sort_rank)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[tokio::test]
    async fn revert_reapplies_a_past_revision_as_a_new_one() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;

        super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                name: Some("실험작".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        super::remove_recipe_step_inner(&db, &id, 1, None, None, None)
            .await
            .unwrap();
        let messy = super::fetch_recipe(&db, &id).await.unwrap();
        assert_eq!(messy.steps.len(), 2);
        assert_eq!(messy.rev_no, 3);

        let reverted = super::revert_recipe_inner(&db, &id, 1, Some(3), None)
            .await
            .unwrap();
        assert_eq!(reverted.name, "된장찌개");
        assert_eq!(reverted.steps.len(), 3, "단계까지 복원");
        assert_eq!(reverted.rev_no, 4, "되돌리기도 새 rev — 이력 재작성 없음");

        // 이력이 전부 남아 있다(rev 1..4).
        let revisions = super::list_recipe_revisions_inner(&db, &id).await.unwrap();
        assert_eq!(
            revisions.iter().map(|r| r.rev_no).collect::<Vec<_>>(),
            vec![4, 3, 2, 1]
        );
        // 되돌린 rev도 다시 되돌릴 수 있다.
        let back = super::revert_recipe_inner(&db, &id, 3, None, None)
            .await
            .unwrap();
        assert_eq!(back.name, "실험작");
    }

    #[tokio::test]
    async fn revision_baseline_is_backfilled_for_recipes_without_history() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu).await;
        // 0075 이전에 만들어진 레시피를 모사: 리비전 이력을 지운다.
        sqlx::query("DELETE FROM recipe_revisions WHERE recipe_id = ?1")
            .bind(&id)
            .execute(&db)
            .await
            .unwrap();

        super::patch_recipe_inner(
            &db,
            PatchRecipeInput {
                id: id.clone(),
                name: Some("고침".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // 직전 상태가 rev 1로 채워졌으므로 되돌릴 지점이 있다.
        let revisions = super::list_recipe_revisions_inner(&db, &id).await.unwrap();
        assert_eq!(revisions.len(), 2);
        let reverted = super::revert_recipe_inner(&db, &id, 1, None, None)
            .await
            .unwrap();
        assert_eq!(reverted.name, "된장찌개", "baseline 덕에 원상 복구 가능");
    }

    #[tokio::test]
    async fn editing_a_recipe_does_not_rewrite_past_log_snapshots() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_recipe(&db, "두부조림", 1.0, vec![(tofu.clone(), 100.0)]).await;

        // 이 레시피로 한 끼를 기록(그 시점 영양이 스냅샷된다).
        let log = crate::commands::diet::logs::record_meal_log_inner(
            &db,
            crate::models::RecordMealLogInput {
                date: "2026-07-26".into(),
                at: Some("2026-07-26T12:00:00+09:00".into()),
                planned_meal_id: None,
                ratio: None,
                recipe_id: Some(id.clone()),
                servings: Some(1.0),
                food_id: None,
                qty_g: None,
                manual: None,
                description: None,
                satisfaction: None,
                fullness: None,
                note: None,
            },
        )
        .await
        .unwrap();
        let logged_kcal = log.kcal;
        assert!((logged_kcal - 80.0).abs() < 1e-9);

        // 레시피 재료를 3배로 늘린다.
        let before = super::fetch_recipe(&db, &id).await.unwrap();
        super::set_recipe_ingredient_inner(
            &db,
            SetRecipeIngredientInput {
                recipe_id: id.clone(),
                expected_rev_no: None,
                id: Some(before.ingredients[0].id.clone()),
                ingredient: ingredient(tofu, 300.0),
                after_index: None,
                change_summary: None,
                changed_by: None,
            },
        )
        .await
        .unwrap();

        let stored: (f64,) = sqlx::query_as("SELECT kcal FROM meal_logs WHERE id = ?1")
            .bind(&log.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(
            (stored.0 - logged_kcal).abs() < 1e-9,
            "과거 기록의 영양은 스냅샷 — 레시피 수정이 소급되면 안 된다"
        );
    }

    #[tokio::test]
    async fn feedback_aggregates_into_tuning_hints_with_sign_semantics() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_recipe(&db, "두부조림", 1.0, vec![(tofu, 100.0)]).await;

        let summary = super::add_recipe_feedback_inner(
            &db,
            AddRecipeFeedbackInput {
                recipe_id: id.clone(),
                rev_no: None,
                meal_log_id: None,
                rating: Some(3),
                salt_delta: Some(2),
                spice_delta: None,
                sweet_delta: None,
                sour_delta: None,
                richness_delta: None,
                doneness_delta: Some(-1),
                comment: Some("너무 짜고 덜 익었다".into()),
            },
        )
        .await
        .unwrap();

        assert_eq!(summary.sample_count, 1);
        assert_eq!(summary.avg_rating, Some(3.0));
        let salt = summary
            .hints
            .iter()
            .find(|h| matches!(h.axis, crate::models::TasteAxis::Salt))
            .expect("salt hint");
        assert!(matches!(
            salt.direction,
            crate::models::TasteDirection::Reduce
        ));
        // 미지정 rev_no는 현재 rev로 귀속된다.
        assert_eq!(summary.recent[0].rev_no, Some(1));
    }

    #[tokio::test]
    async fn feedback_rejects_out_of_range_axes() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_recipe(&db, "두부조림", 1.0, vec![(tofu, 100.0)]).await;
        let err = super::add_recipe_feedback_inner(
            &db,
            AddRecipeFeedbackInput {
                recipe_id: id,
                rev_no: None,
                meal_log_id: None,
                rating: None,
                salt_delta: Some(5),
                spice_delta: None,
                sweet_delta: None,
                sour_delta: None,
                richness_delta: None,
                doneness_delta: None,
                comment: None,
            },
        )
        .await
        .expect_err("범위 밖 델타 거부");
        assert!(format!("{err:?}").contains("-2 and 2"));
    }

    #[tokio::test]
    async fn scaling_reports_grams_stock_and_shortfall() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_recipe(&db, "두부조림", 2.0, vec![(tofu.clone(), 200.0)]).await;
        crate::commands::diet::pantry::add_pantry_lot_inner(
            &db,
            crate::models::AddPantryLotInput {
                food_id: tofu,
                location: crate::models::PantryLocation::Fridge,
                acquired_on: "2026-07-20".into(),
                expires_on: Some("2026-07-30".into()),
                initial_qty_g: 250.0,
                note: None,
            },
        )
        .await
        .unwrap();

        let scaled = super::scaled_recipe_inner(&db, &id, Some(3.0))
            .await
            .unwrap();
        assert!((scaled.factor - 1.5).abs() < 1e-9);
        assert!((scaled.ingredients[0].qty_g - 300.0).abs() < 1e-9);
        assert!((scaled.ingredients[0].available_g - 250.0).abs() < 1e-9);
        assert!((scaled.ingredients[0].shortfall_g - 50.0).abs() < 1e-9);
        assert_eq!(scaled.missing_count, 1);
        // 영양도 함께 스케일(1인분은 목표 인분 기준으로 다시 나눈다).
        assert!((scaled.total.kcal - 240.0).abs() < 1e-9);
        assert!((scaled.per_serving.kcal - 80.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn replace_all_update_still_records_a_revision() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let id = seed_with_steps(&db, tofu.clone()).await;
        let updated = super::update_recipe_inner(
            &db,
            UpdateRecipeInput {
                id: id.clone(),
                expected_rev_no: 1,
                name: "전면 개편".into(),
                servings: 4.0,
                cook_minutes: None,
                meal_tags: vec!["Dinner".into(), "dinner".into()],
                source_url: None,
                yield_g: Some(1200.0),
                notes: None,
                ingredients: vec![ingredient(tofu, 400.0)],
                steps: vec![step("한 번에 끓인다")],
                change_summary: Some("리팩터".into()),
                changed_by: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.meal_tags, vec!["dinner"], "태그 dedup+lower");
        assert_eq!(updated.steps.len(), 1);
        assert_eq!(updated.rev_no, 2);
        assert_eq!(updated.yield_g, Some(1200.0));
    }
}
