//! work-radar 앱 내장 stdio MCP 서버(External Action Gate Phase 1, **proposal-only**).
//!
//! 외부 AI 에이전트(Claude Code / Codex / Hermes)가 `work-radar --mcp-stdio`로 spawn해 등록한다.
//! - read 툴  = DB 조회(메타만 — 토큰/payload 본문 미노출).
//! - write 툴 = `store::enqueue`만 호출(제안 생성). 커넥터 `execute`/`Acceptance::mint` 경로 **없음**
//!   — 모듈 경계 + Task 1.0 토큰 type-wall(`pub(in crate::external_actions)`)로 컴파일 강제.
//!
//! 승인/실행은 work-radar GUI(같은 DB의 승인 패널)와 Rust 커넥터(Phase 2~5)가 담당한다.
//! 이 모듈은 실 외부 호출을 **하지 않는다**(Phase 1 외부 호출 0).

pub mod run;

use crate::db::Db;
use crate::external_actions::store;
use rmcp::handler::server::wrapper::Json;
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::Serialize;

/// MCP 서버 상태 — 앱과 동일한 SQLite 풀을 보유(별도 DB 아님).
#[derive(Clone)]
pub struct WrServer {
    pub db: Db,
}

/// 승인 대기 액션 1건(메타만). payload/result/토큰은 노출하지 않는다.
#[derive(Serialize, JsonSchema)]
pub struct PendingActionDto {
    pub id: String,
    pub kind: String,
    pub origin: String,
    pub status: String,
}

/// `wr_list_pending_actions` 반환 — 승인 대기 큐(메타 목록).
#[derive(Serialize, JsonSchema)]
pub struct PendingList {
    pub actions: Vec<PendingActionDto>,
}

#[tool_router(server_handler)]
impl WrServer {
    /// 승인 대기 외부 액션 목록(메타만). 토큰/payload 본문 미노출.
    /// DB 에러는 빈 목록으로 graceful degrade(MCP 툴은 패닉 금지).
    #[tool(
        name = "wr_list_pending_actions",
        description = "List external actions awaiting user approval (metadata only). Does NOT expose payloads or tokens."
    )]
    pub async fn list_pending_actions(&self) -> Json<PendingList> {
        let rows = store::list_pending(&self.db).await.unwrap_or_default();
        Json(PendingList {
            actions: rows
                .into_iter()
                .map(|a| PendingActionDto {
                    id: a.id,
                    kind: a.kind,
                    origin: a.origin,
                    status: a.status,
                })
                .collect(),
        })
    }
}
