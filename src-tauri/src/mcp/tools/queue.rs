//! 승인 큐 · 프로젝트 조회 · Noop 제안 데모 — 서비스 무관 메타 표면.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::projects;
use crate::error::AppError;
use crate::external_actions::{store, ExternalAction};
use crate::mcp::{mcp_tool_error, project_kind_str, WrServer};

/// 승인 대기 액션 1건(메타만). payload/result/토큰은 노출하지 않는다.
#[derive(Serialize, JsonSchema)]
pub struct PendingActionDto {
    pub id: String,
    pub kind: String,
    pub origin: String,
    pub status: String,
}

/// `wr_list_pending_actions` 반환 — 승인 대기 큐(메타 목록). `total`/`truncated`로 상한(LIMIT) 절단을
/// **명시 신호**한다(#7): FIFO 정렬이라 절단되는 건 가장 최근 제안이므로, 폴링 에이전트가 `truncated`로
/// "더 있음"을 알고 처리/재조회할 수 있다(무신호 truncation 방지).
#[derive(Serialize, JsonSchema)]
pub struct PendingList {
    pub actions: Vec<PendingActionDto>,
    /// 상한 적용 전 전체 대기 건수.
    pub total: u32,
    /// `actions`가 상한에 잘렸는지(`total > actions.len()`).
    pub truncated: bool,
}

/// 프로젝트 1건(메타만 — credential_ref/토큰 미노출). write 툴이 어떤 project_id로 행위할지 고를 때 쓴다.
#[derive(Serialize, JsonSchema)]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    /// "personal" | "work" — 개인/업무 identity 구분(승인 패널과 동일 라벨 기반).
    pub kind: String,
}

/// `wr_list_projects` 반환 — 프로젝트 목록(메타만).
#[derive(Serialize, JsonSchema)]
pub struct ProjectList {
    pub projects: Vec<ProjectDto>,
}

/// 제안 생성 파라미터(`wr_propose_noop`). preview=승인 패널 표시용 사람-친화 요약.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct ProposeNoopParams {
    /// 사람-친화 미리보기(승인 패널 표시용).
    pub preview: String,
    /// 임의 메모(Noop payload).
    pub note: String,
}

/// 제안 생성 결과 — action_id + 초기 상태(awaiting_approval). **실행 안 함**.
/// 외부 서비스 write 툴(GitHub/Notion/Calendar/Gmail)이 공유하는 반환 타입이기도 하다.
#[derive(Serialize, JsonSchema)]
pub struct ProposeResult {
    pub action_id: String,
    pub status: String,
}

/// 단건 상태 조회 파라미터(`wr_action_status`).
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)] // unknown-field 거부 = JSON Schema additionalProperties:false (mcp-server-conventions §2)
pub struct ActionIdParams {
    pub action_id: String,
}

/// 단건 상태 조회 결과. 없으면 status=None.
#[derive(Serialize, JsonSchema)]
pub struct ActionStatus {
    pub status: Option<String>,
}

#[tool_router(router = tool_router_queue, vis = "pub(crate)")]
impl WrServer {
    /// 승인 대기 외부 액션 목록(메타만). 토큰/payload 본문 미노출.
    /// DB 에러는 **빈 목록으로 삼키지 않고** rmcp internal-error로 surface한다 — 폴링하는
    /// 에이전트가 "실패"와 "비어 있음"을 구분할 수 있게(읽기 툴 비대칭 수정). 패닉은 여전히 금지.
    /// surface/로그는 PII-free하게 AppError.code만 쓴다(message/payload 본문 금지).
    #[tool(
        name = "wr_list_pending_actions",
        description = "List external actions awaiting user approval (metadata only). Does NOT expose payloads or tokens."
    )]
    pub async fn list_pending_actions(&self) -> Result<Json<PendingList>, rmcp::ErrorData> {
        let (rows, total) = store::list_pending_with_total(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_list_pending_actions", &e))?;
        let truncated = total as usize > rows.len();
        Ok(Json(PendingList {
            actions: rows
                .into_iter()
                .map(|a| PendingActionDto {
                    id: a.id,
                    kind: a.kind,
                    origin: a.origin,
                    status: a.status,
                })
                .collect(),
            total,
            truncated,
        }))
    }

    /// 프로젝트 목록(메타만 — credential_ref/토큰 미노출). write 툴이 어떤 identity(project_id)로
    /// 행위할지 고를 때 쓴다. DB 에러는 빈 목록으로 삼키지 않고 rmcp internal-error로 surface한다.
    #[tool(
        name = "wr_list_projects",
        description = "List projects (id, name, kind) to choose a target for write tools. Does NOT expose credentials or tokens."
    )]
    pub async fn list_projects(&self) -> Result<Json<ProjectList>, rmcp::ErrorData> {
        let rows = projects::fetch_projects(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_list_projects", &AppError::from(e)))?;
        Ok(Json(ProjectList {
            projects: rows
                .into_iter()
                .map(|p| ProjectDto {
                    id: p.id,
                    name: p.name,
                    kind: project_kind_str(p.kind).to_string(),
                })
                .collect(),
        }))
    }

    /// 제안만 생성한다 — **실행 안 함**. 사용자 승인 후 Rust 커넥터가 실행(Phase 0 게이트).
    /// `store::enqueue`만 호출한다(execute/mint 경로 없음 — Task 1.0 type-wall로 컴파일 강제).
    /// DB 에러는 action_id="" + status="error"로 surface(패닉 금지).
    #[tool(
        name = "wr_propose_noop",
        description = "Propose a no-op external action (Phase 1 proposal-path demo). Returns an action_id awaiting user approval; does NOT execute."
    )]
    pub async fn propose_noop(
        &self,
        Parameters(p): Parameters<ProposeNoopParams>,
    ) -> Json<ProposeResult> {
        let action = ExternalAction::Noop { note: p.note };
        match store::enqueue(&self.db, &action, None, Some(&p.preview), "mcp:client").await {
            Ok(id) => Json(ProposeResult {
                action_id: id,
                status: "awaiting_approval".into(),
            }),
            Err(e) => {
                // 기존 계약(status:"error" + 빈 id) 유지(비회귀)하되, 삼킨 에러가 완전히 안 보이는
                // 일이 없게 stderr에 PII-free 코드만 남긴다(stdout은 MCP 전용).
                eprintln!(
                    "[work-radar mcp-stdio] wr_propose_noop db error: code={} trace_id={}",
                    e.code, e.trace_id
                );
                Json(ProposeResult {
                    action_id: String::new(),
                    status: "error".into(),
                })
            }
        }
    }

    /// 액션 승인/실행 상태 폴링(단건 — terminal 도달 시 종료는 클라이언트 책임, 무한 폴링 없음).
    /// 없는 id는 status=None(정상). DB 에러는 **None으로 삼키지 않고** rmcp internal-error로
    /// surface — 폴링 에이전트가 "조회 실패"와 "행 없음/미결정"을 구분할 수 있게(읽기 툴 비대칭 수정).
    /// surface/로그는 PII-free하게 AppError.code만 쓴다.
    #[tool(
        name = "wr_action_status",
        description = "Poll the status of a proposed action by id (awaiting_approval | succeeded | failed | rejected)."
    )]
    pub async fn action_status(
        &self,
        Parameters(p): Parameters<ActionIdParams>,
    ) -> Result<Json<ActionStatus>, rmcp::ErrorData> {
        let status = store::status(&self.db, &p.action_id)
            .await
            .map_err(|e| mcp_tool_error("wr_action_status", &e))?;
        Ok(Json(ActionStatus { status }))
    }
}

#[cfg(test)]
mod schema_tests {
    use super::{ActionIdParams, ProposeNoopParams};
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};

    #[test]
    fn propose_noop_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(ProposeNoopParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "ProposeNoopParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(prop_names(&v), expect(&["note", "preview"]));
        assert_eq!(required_fields(&v), expect(&["note", "preview"]));
    }

    #[test]
    fn action_id_params_schema_is_closed_and_stable() {
        let v = serde_json::to_value(schemars::schema_for!(ActionIdParams)).unwrap();
        assert_eq!(
            v["additionalProperties"],
            serde_json::json!(false),
            "ActionIdParams must be a closed schema (deny_unknown_fields)"
        );
        assert_eq!(prop_names(&v), expect(&["action_id"]));
        assert_eq!(required_fields(&v), expect(&["action_id"]));
    }
}
