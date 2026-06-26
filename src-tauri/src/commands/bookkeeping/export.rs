//! 가계부 거래 CSV/QIF/OFX 내보내기.

use std::path::Path;

use tauri::State;

use crate::bookkeeping_export::{export_csv, export_ofx, export_qif, BookkeepingExportRow};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingExportFormat, BookkeepingTransaction, ExportBookkeepingInput,
    WriteBookkeepingExportInput,
};

use super::*;

#[tauri::command]
#[specta::specta]
pub async fn export_bookkeeping_csv(
    db: State<'_, Db>,
    input: ExportBookkeepingInput,
) -> Result<String, AppError> {
    let rows = export_bookkeeping_rows(db.inner(), input).await?;
    Ok(export_csv(&rows))
}

#[tauri::command]
#[specta::specta]
pub async fn export_bookkeeping_qif(
    db: State<'_, Db>,
    input: ExportBookkeepingInput,
) -> Result<String, AppError> {
    let rows = export_bookkeeping_rows(db.inner(), input).await?;
    Ok(export_qif(&rows))
}

#[tauri::command]
#[specta::specta]
pub async fn export_bookkeeping_ofx(
    db: State<'_, Db>,
    input: ExportBookkeepingInput,
) -> Result<String, AppError> {
    let rows = export_bookkeeping_rows(db.inner(), input).await?;
    Ok(export_ofx(&rows))
}

#[tauri::command]
#[specta::specta]
pub async fn write_bookkeeping_export(
    db: State<'_, Db>,
    input: WriteBookkeepingExportInput,
) -> Result<(), AppError> {
    write_bookkeeping_export_inner(db.inner(), input).await
}

pub(crate) async fn export_bookkeeping_rows(
    db: &Db,
    input: ExportBookkeepingInput,
) -> Result<Vec<BookkeepingExportRow>, AppError> {
    let project_id = clean_optional(input.project_id.as_deref());
    let from_date = clean_optional(input.from_date.as_deref());
    let to_date = clean_optional(input.to_date.as_deref());
    let sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} \
         FROM bookkeeping_transactions \
         WHERE deleted_at IS NULL \
           AND review_status != 'ignored' \
           AND (?1 IS NULL OR project_id = ?1) \
           AND (?2 IS NULL OR spent_at >= ?2) \
           AND (?3 IS NULL OR spent_at <= ?3) \
         ORDER BY spent_at ASC, COALESCE(spent_at_time, '') ASC, id ASC \
         LIMIT 5000"
    );
    let transactions = sqlx::query_as::<_, BookkeepingTransaction>(&sql)
        .bind(project_id.as_deref())
        .bind(from_date.as_deref())
        .bind(to_date.as_deref())
        .fetch_all(db)
        .await?;
    let mut rows = Vec::with_capacity(transactions.len());
    for transaction in transactions {
        let line_items = list_bookkeeping_line_items_inner(db, &transaction.id).await?;
        rows.push(BookkeepingExportRow {
            transaction,
            line_items,
        });
    }
    Ok(rows)
}

pub(crate) async fn write_bookkeeping_export_inner(
    db: &Db,
    input: WriteBookkeepingExportInput,
) -> Result<(), AppError> {
    let path = clean_required(&input.path, "bookkeeping.export.path")?;
    let path = Path::new(&path);
    if path.file_name().is_none() {
        return Err(AppError::validation(
            "bookkeeping.export.path",
            "저장할 파일 경로를 확인하세요",
        ));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::validation(
                "bookkeeping.export.path",
                "저장 폴더를 찾을 수 없습니다",
            ));
        }
    }

    let rows = export_bookkeeping_rows(db, input.export).await?;
    let payload = match input.format {
        BookkeepingExportFormat::Csv => export_csv(&rows),
        BookkeepingExportFormat::Qif => export_qif(&rows),
        BookkeepingExportFormat::Ofx => export_ofx(&rows),
    };

    tokio::fs::write(path, payload)
        .await
        .map_err(|_| AppError::terminal("bookkeeping.export.write", "export 파일 저장 실패"))?;
    Ok(())
}
