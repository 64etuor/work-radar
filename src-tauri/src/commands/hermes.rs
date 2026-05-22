//! Hermes 메신저 브리지 커맨드 (Phase 20 #15). 외부 Hermes 에이전트를 Telegram Bot API류
//! 메신저 브리지로 제어한다 — work-radar가 명령을 보내고(sendMessage) 응답을 받는다(getUpdates).
//!
//! INVARIANT:
//!  - 봇 토큰은 keychain(TokenKind::HermesBridge)만 — IPC 인자로만 들어와 즉시 keychain으로 가고
//!    절대 반환·DB·렌더러로 새지 않는다(set_project_token / Google client 선례).
//!  - 앱 레벨 단일 브리지(외부 Hermes 하나)라 keychain credential_ref·DB row 모두 고정 키.
//!  - 수신은 **bounded 단발** getUpdates(무한 long-poll 루프 금지 — #5). cadence는 사용자/스케줄러.
//!  - chat_id·offset·메시지 로그는 로컬 SQLite SSOT(hermes_bridge/hermes_messages, #7).
//!  - 외부 호출은 Rust(reqwest)·bounded retry·graceful terminal failure. 미설정 graceful degrade.

use tauri::State;

use crate::db::Db;
use crate::keychain;
use crate::messenger;
use crate::models::{HermesBridgeStatus, HermesFetchResult, HermesMessage, TokenKind};

/// 앱 레벨 단일 브리지의 keychain 분리 키(project별 토큰과 충돌 안 나는 고정 ref). Hermes는 외부
/// 에이전트 하나라 project 단위가 아니다. account = `{this}:hermes_bridge`.
const HERMES_CREDENTIAL_REF: &str = "__hermes_bridge__";
/// hermes_bridge 단일 행 id.
const SINGLETON_ID: &str = "singleton";

/// 봇 토큰을 keychain에서 읽는다(없으면 None). 본문은 호출 내부에서만 쓰이고 반환되지 않는다.
fn load_bot_token() -> Result<Option<String>, String> {
    keychain::get_token(HERMES_CREDENTIAL_REF, TokenKind::HermesBridge).map_err(|e| e.to_string())
}

/// 저장된 (chat_id, last_offset)을 읽는다(미설정이면 None). chat_id는 비밀 아님.
async fn load_bridge_row(db: &Db) -> Result<Option<(String, i64)>, String> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT chat_id, last_offset FROM hermes_bridge WHERE id = ?1")
            .bind(SINGLETON_ID)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    Ok(row)
}

/// 브리지 설정: 봇 토큰 → keychain(반환 없음), chat_id → hermes_bridge 단일 행. 토큰 본문은 IPC
/// 인자로만 들어와 즉시 keychain으로 가고 절대 반환되지 않는다(INVARIANT). offset은 보존(재설정 시
/// 같은 봇이면 이미 소비한 update를 다시 받지 않게 — 새 행이면 0).
#[tauri::command]
#[specta::specta]
pub async fn set_hermes_bridge(
    db: State<'_, Db>,
    bot_token: String,
    chat_id: String,
) -> Result<(), String> {
    let bot_token = bot_token.trim();
    let chat_id = chat_id.trim();
    if bot_token.is_empty() {
        return Err("봇 토큰이 비었습니다".into());
    }
    if chat_id.is_empty() {
        return Err("chat_id가 비었습니다".into());
    }
    keychain::set_token(HERMES_CREDENTIAL_REF, TokenKind::HermesBridge, bot_token)
        .map_err(|e| e.to_string())?;
    // chat_id upsert(단일 행). last_offset은 기존 값 보존(없으면 0).
    sqlx::query(
        "INSERT INTO hermes_bridge (id, chat_id) VALUES (?1, ?2) \
         ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, updated_at = datetime('now')",
    )
    .bind(SINGLETON_ID)
    .bind(chat_id)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
    // bot_token은 여기서 drop — 어디에도 보관/반환되지 않는다.
}

/// 브리지 연결 상태(토큰 keychain 보유 + chat_id 설정). 봇 토큰 본문은 절대 미노출(INVARIANT).
#[tauri::command]
#[specta::specta]
pub async fn hermes_bridge_status(db: State<'_, Db>) -> Result<HermesBridgeStatus, String> {
    let has_token = load_bot_token()?.is_some();
    let row = load_bridge_row(db.inner()).await?;
    let chat_id = row.map(|(c, _)| c).filter(|c| !c.is_empty());
    let configured = has_token && chat_id.is_some();
    let detail = if configured {
        "연결됨 — 메시지 송수신 가능".into()
    } else if has_token {
        "봇 토큰 있음 / chat_id 미설정".into()
    } else if chat_id.is_some() {
        "chat_id 있음 / 봇 토큰 미설정".into()
    } else {
        "미설정 — 봇 토큰 + chat_id를 입력하세요".into()
    };
    Ok(HermesBridgeStatus {
        configured,
        chat_id,
        detail,
    })
}

/// 연결 해제: keychain 봇 토큰 삭제 + hermes_bridge 행 삭제(메시지 로그는 보존 — 열람 가치). 멱등.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_hermes(db: State<'_, Db>) -> Result<(), String> {
    keychain::delete_token(HERMES_CREDENTIAL_REF, TokenKind::HermesBridge)
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM hermes_bridge WHERE id = ?1")
        .bind(SINGLETON_ID)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hermes에게 메시지 전송(Telegram sendMessage). bounded retry·graceful terminal failure. 송신
/// 로그를 hermes_messages에 기록한다(제어 surface). 미설정이면 Err(graceful degrade). 봇 토큰 미노출.
#[tauri::command]
#[specta::specta]
pub async fn send_hermes_message(db: State<'_, Db>, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("빈 메시지는 보낼 수 없습니다".into());
    }
    let bot_token = load_bot_token()?.ok_or("미설정 — 먼저 봇 토큰을 설정하세요")?;
    let (chat_id, _offset) = load_bridge_row(db.inner())
        .await?
        .filter(|(c, _)| !c.is_empty())
        .ok_or("미설정 — 먼저 chat_id를 설정하세요")?;

    let provider = messenger::HttpMessengerProvider::new().map_err(|e| e.to_string())?;
    messenger::send_core(&provider, &bot_token, &chat_id, text)
        .await
        .map_err(|e| e.to_string())?;

    // 송신 성공 시 로그 기록(외부 write가 성공한 뒤에만 — 거짓 로그 방지).
    sqlx::query(
        "INSERT INTO hermes_messages (id, direction, text) \
         VALUES (lower(hex(randomblob(16))), 'sent', ?1)",
    )
    .bind(text)
    .execute(db.inner())
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hermes로부터 새 메시지를 **bounded 단발**로 수신(Telegram getUpdates). 무한 long-poll 아님 —
/// 한 호출 = 한 왕복(#5). 저장된 offset 이후 update를 받아 새 메시지를 hermes_messages에 기록하고
/// (update_id UNIQUE로 멱등) offset을 전진 영속한다. 미설정이면 Err(graceful degrade). 봇 토큰 미노출.
#[tauri::command]
#[specta::specta]
pub async fn fetch_hermes_messages(db: State<'_, Db>) -> Result<HermesFetchResult, String> {
    let bot_token = load_bot_token()?.ok_or("미설정 — 먼저 봇 토큰을 설정하세요")?;
    let (_chat_id, offset) = load_bridge_row(db.inner())
        .await?
        .ok_or("미설정 — 먼저 봇 토큰 + chat_id를 설정하세요")?;

    let provider = messenger::HttpMessengerProvider::new().map_err(|e| e.to_string())?;
    let (msgs, next_offset) = messenger::fetch_core(&provider, &bot_token, offset)
        .await
        .map_err(|e| e.to_string())?;

    // 새 메시지 기록(text 있는 것만 로그). update_id UNIQUE 인덱스로 중복 fetch는 멱등(무시).
    let mut received = 0u32;
    for m in &msgs {
        if m.text.is_empty() {
            continue;
        }
        let res = sqlx::query(
            "INSERT OR IGNORE INTO hermes_messages (id, direction, text, update_id) \
             VALUES (lower(hex(randomblob(16))), 'received', ?1, ?2)",
        )
        .bind(&m.text)
        .bind(m.update_id)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
        received += res.rows_affected() as u32;
    }

    // offset 전진 영속(다음 호출이 이미 받은 update를 다시 안 받게 — 멱등 소비).
    if next_offset != offset {
        sqlx::query(
            "UPDATE hermes_bridge SET last_offset = ?2, updated_at = datetime('now') WHERE id = ?1",
        )
        .bind(SINGLETON_ID)
        .bind(next_offset)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(HermesFetchResult { received })
}

/// 제어 surface용 메시지 로그(최신순, bounded). 송·수신 합쳐 최근 `limit`건. 봇 토큰 미포함.
#[tauri::command]
#[specta::specta]
pub async fn list_hermes_messages(
    db: State<'_, Db>,
    limit: u32,
) -> Result<Vec<HermesMessage>, String> {
    // bound: 과도한 행 로드 방지(기본 상한). 0이면 기본 200.
    let cap = if limit == 0 { 200 } else { limit.min(500) } as i64;
    let rows: Vec<HermesMessage> = sqlx::query_as(
        "SELECT id, direction, text, created_at FROM hermes_messages \
         ORDER BY created_at DESC, id DESC LIMIT ?1",
    )
    .bind(cap)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())?;
    // UI는 오래된→최신(채팅 흐름)으로 보여주기 좋게 뒤집어 반환.
    Ok(rows.into_iter().rev().collect())
}
