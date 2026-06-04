//! MCP 툴 라운드트립(헤드리스, 외부 호출 0): `propose_noop` → `store::enqueue` →
//! `list_pending_actions`/`action_status`에 반영됨을 in-process로 검증한다.
//!
//! rmcp client↔server 왕복 대신 핸들러 메서드를 직접 호출한다(핸들러 단위) — 툴 메서드/DTO/`WrServer`가
//! `pub`이라 integration test crate에서 접근 가능. `store::*`는 `pub(crate)`라 여기서 못 보므로 검증은
//! **공개 툴 표면**(list_pending_actions / action_status)으로만 한다 = MCP 클라이언트가 실제로 보는 계약.
//!
//! DB는 `work_radar_lib::db::init_db`(앱과 동일한 connect + `sqlx::migrate!` 경로)로 tempdir에 만든다
//! — `fresh_db`는 `#[cfg(test)]`+`pub(crate)`라 integration test에서 안 보이기 때문(앱 마이그레이션 재사용).

use work_radar_lib::db::{init_db, Db};
use work_radar_lib::mcp::{ActionIdParams, ProposeNoopParams, WrServer};

use rmcp::handler::server::wrapper::Parameters;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 고유 tempdir DB(앱 db.rs의 temp_db_path 관례 — nanos+per-call 카운터로 병렬 충돌 회피).
async fn fresh_db() -> Db {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("wr-mcp-roundtrip-{nanos}-{seq}.db"));
    init_db(&path).await.expect("init_db (migrate) failed")
}

#[tokio::test]
async fn propose_then_list_and_status() {
    let db = fresh_db().await;
    let server = WrServer { db };

    // fresh DB → 대기 큐 비어 있음(공개 read 툴로 확인).
    let before = server.list_pending_actions().await;
    assert!(
        before.0.actions.is_empty(),
        "fresh DB should have no pending actions"
    );

    // write 툴(enqueue-only) → action_id 반환, 상태 awaiting_approval. 실행은 일어나지 않는다.
    let res = server
        .propose_noop(Parameters(ProposeNoopParams {
            preview: "demo".into(),
            note: "n".into(),
        }))
        .await;
    let action_id = res.0.action_id;
    assert!(!action_id.is_empty(), "propose_noop should return an id");
    assert_eq!(res.0.status, "awaiting_approval");

    // list_pending_actions가 새 제안을 메타로 반영(payload/토큰 노출 없음 — DTO에 그 필드 자체가 없음).
    let pending = server.list_pending_actions().await;
    assert_eq!(pending.0.actions.len(), 1, "one pending action expected");
    let row = &pending.0.actions[0];
    assert_eq!(row.id, action_id);
    assert_eq!(row.kind, "noop");
    assert_eq!(row.origin, "mcp:client");
    assert_eq!(row.status, "awaiting_approval");

    // action_status가 같은 id의 상태를 반환.
    let st = server
        .action_status(Parameters(ActionIdParams {
            action_id: action_id.clone(),
        }))
        .await;
    assert_eq!(st.0.status.as_deref(), Some("awaiting_approval"));

    // 없는 id는 None(에러/패닉 아님).
    let missing = server
        .action_status(Parameters(ActionIdParams {
            action_id: "no-such-id".into(),
        }))
        .await;
    assert_eq!(missing.0.status, None);
}
