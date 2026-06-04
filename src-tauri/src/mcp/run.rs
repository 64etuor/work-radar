//! `--mcp-stdio` 진입점: GUI 부팅 없이 앱과 **동일한** SQLite DB를 열고 stdio MCP 서버를 구동한다.
//!
//! ⚠️ stdout은 **MCP 프로토콜 프레이밍 전용**이다. 이 경로는 `logging::init_tracing`(stdout 레이어
//!    포함)을 호출하지 않으며, 진단은 전부 `eprintln!`(stderr)로만 낸다 — stdout에 한 바이트라도
//!    새면 JSON-RPC 프레이밍이 깨진다.
//!
//! DB 경로 해석은 앱과 단일 진실원(`crate::resolve_db_path`)을 공유한다(하드코딩 금지). 마이그레이션
//! 적용도 앱과 동일 함수(`crate::db::init_db` = connect + `sqlx::migrate!`)를 재사용한다 — 앱이 이미
//! 적용했어도 idempotent라 안전(단독 실행 대비).

use crate::mcp::WrServer;
use rmcp::service::serve_server;
use rmcp::transport::io::stdio;
use std::path::PathBuf;

/// 앱과 동일한 DB 파일 경로를 GUI 부팅 없이 해석한다.
///
/// 앱(`lib.rs` setup)은 `app.path().app_data_dir()`로 release 경로를 얻지만, 그건 tauri AppHandle을
/// 요구한다. tauri 2의 `app_data_dir()`는 의미상 `dirs::data_dir()/<bundle identifier>`이므로 헤드리스로
/// 동일 경로를 재현한다. dev override(`WORK_RADAR_DEV_DB`)·temp dev DB·release SSOT 분기 로직 자체는
/// 앱과 같은 `crate::resolve_db_path`로 위임한다(단일 진실원).
fn resolve_app_db_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let is_dev = cfg!(debug_assertions);
    let dev_override = std::env::var("WORK_RADAR_DEV_DB").ok();
    // tauri app_data_dir() 동치: dirs::data_dir()/<identifier>. release 경로에서만 실제 사용되지만
    // (dev 경로는 temp 또는 override) 항상 계산해 resolve_db_path에 넘긴다.
    let app_data = dirs::data_dir()
        .ok_or("could not resolve OS data dir (app_data_dir equivalent)")?
        .join(crate::APP_BUNDLE_IDENTIFIER);
    Ok(crate::resolve_db_path(
        is_dev,
        dev_override.as_deref(),
        &std::env::temp_dir(),
        &app_data,
    ))
}

/// `--mcp-stdio` 모드 본체. 앱과 동일 DB를 열고 stdio MCP 서버를 구동하며, 트랜스포트가 닫힐
/// 때까지(클라이언트 종료/취소) 블로킹한다. 반환 = 서버 루프 종료 사유.
pub async fn run_mcp_stdio() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = resolve_app_db_path()?;
    eprintln!("[work-radar mcp-stdio] opening DB at {}", db_path.display());

    // 앱과 동일한 connect + 마이그레이션 함수(idempotent).
    let db = crate::db::init_db(&db_path).await?;

    // External Action Gate crash-orphan 회수(#8): reaper는 GUI Tauri setup 클로저에서만 돌았는데,
    // 이 mcp-stdio 경로는 그 전에 반환하므로 GUI 크래시가 남긴 좀비 'executing' 행이 idempotency_key를
    // 영구 잠가 MCP 제안자가 dedup으로 막힐 수 있다. 여기서도 idempotent하게 한 번 돌린다. lease 가드가
    // 동시 형제(live GUI 인스턴스)의 액션은 건드리지 않는다(store::recover_interrupted_actions, GOAL 2).
    match crate::external_actions::store::recover_interrupted_actions(&db).await {
        Ok(n) if n > 0 => {
            eprintln!("[work-radar mcp-stdio] recovered {n} interrupted external action(s)")
        }
        Ok(_) => {}
        Err(e) => eprintln!(
            "[work-radar mcp-stdio] external-action reaper error: code={}",
            e.code
        ),
    }

    let server = WrServer { db };

    // stdio() = (Stdin, Stdout). stdout은 MCP 전용 — 위 모듈 doc 참조.
    let running = serve_server(server, stdio()).await?;
    let quit_reason = running.waiting().await?;
    eprintln!("[work-radar mcp-stdio] server stopped: {quit_reason:?}");
    Ok(())
}
