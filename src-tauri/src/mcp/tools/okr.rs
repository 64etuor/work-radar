//! Mission / OKR 툴 — read 3개 + 관측 기록 write 1개.
//!
//! **왜 check-in만 write인가.** `upsert_check_in_inner`는 KR의 현재 `progress`를 `value_snapshot`에
//! 스냅샷하고 주간 confidence + 노트를 남길 뿐, 진행률을 *설정하지* 않는다. 진행률은
//! `current_value`(또는 연결된 루틴의 완료)에서 파생된다. 반면 `update_key_result`는
//! `current_value`를 바꿔 progress → 보드 OKR 배지로 흘러들므로 결정 레일이다.
//!
//! 따라서 objective/key-result CRUD와 `set_key_result_routine`은 표면에 **없다**
//! (`surface_tests::decision_rail_writes_never_reach_the_mcp_surface`가 이름으로 강제).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::okr as okr_commands;
use crate::mcp::{enum_wire_string, mcp_tool_error, truncate_preview, WrServer};
use crate::models::OkrConfidence;

/// 설명/노트 미리보기 상한(§6 — 장문 echo 금지).
const TEXT_PREVIEW_CHARS: usize = 280;
/// check-in 노트 입력 상한(§2).
const NOTE_MAX_CHARS: usize = 1000;

/// 주간 confidence. **KR progress를 구동하지 않는다** — 순수 로그값.
#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum OkrConfidenceParam {
    OnTrack,
    AtRisk,
    OffTrack,
}

impl From<OkrConfidenceParam> for OkrConfidence {
    fn from(c: OkrConfidenceParam) -> Self {
        match c {
            OkrConfidenceParam::OnTrack => OkrConfidence::OnTrack,
            OkrConfidenceParam::AtRisk => OkrConfidence::AtRisk,
            OkrConfidenceParam::OffTrack => OkrConfidence::OffTrack,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OkrQuarterParams {
    /// 분기 키 "YYYY-Qn" (예: "2026-Q3").
    pub quarter: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OkrUpsertCheckInParams {
    /// 대상 key result id(`wr_okr_list_objectives`로 조회).
    pub key_result_id: String,
    /// 주 시작일 YYYY-MM-DD. 같은 (key_result, week_start)는 덮어쓴다(멱등).
    pub week_start: String,
    /// 주간 자기평가. 진행률에 영향을 주지 않는다.
    pub confidence: OkrConfidenceParam,
    /// 짧은 메모(≤1000자, 선택).
    pub note: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct MissionDto {
    pub statement: String,
    pub note_preview: Option<String>,
    pub updated_at: String,
}

/// 미션은 미설정일 수 있다. MCP output schema root는 object여야 하므로 감싼다.
#[derive(Serialize, JsonSchema)]
pub struct MissionResultDto {
    pub mission: Option<MissionDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct KeyResultDto {
    pub id: String,
    pub title: String,
    /// "metric" | "milestone".
    pub kind: String,
    pub target_value: Option<f64>,
    pub current_value: Option<f64>,
    pub unit: Option<String>,
    /// 0.0..=1.0 파생 진행률(`current_value` 또는 연결 루틴에서). check-in은 여기에 영향 없음.
    pub progress: f64,
    /// 루틴에 연결돼 진행이 자동 집계되는지. 루틴 id 자체는 표면에 없다.
    pub routine_linked: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct ObjectiveDto {
    pub id: String,
    pub quarter: String,
    pub title: String,
    pub description_preview: Option<String>,
    /// "active" | "closed".
    pub status: String,
    pub linked_area_keys: Vec<String>,
    pub linked_project_ids: Vec<String>,
    pub key_results: Vec<KeyResultDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct ObjectiveListDto {
    pub objectives: Vec<ObjectiveDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct CheckInDto {
    pub id: String,
    pub key_result_id: String,
    pub week_start: String,
    /// 기록 시점의 KR 진행률 스냅샷(check-in이 만든 값이 아니라 그때의 파생값).
    pub value_snapshot: f64,
    /// "on_track" | "at_risk" | "off_track".
    pub confidence: String,
    pub note_preview: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, JsonSchema)]
pub struct CheckInListDto {
    pub check_ins: Vec<CheckInDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct UpsertCheckInResult {
    pub id: String,
    pub key_result_id: String,
    pub week_start: String,
    pub confidence: String,
}

/// "YYYY-Qn" 형식을 핸들러 진입에서 강제한다(§2 — 자유 문자열을 좁힌다).
/// `list_objectives_inner`는 trim만 하므로 잘못된 분기는 조용히 빈 목록이 된다 — 그건 caller에게
/// "그 분기에 목표가 없다"로 읽혀 오해를 부른다.
#[allow(clippy::result_large_err)]
fn clean_quarter(raw: &str) -> Result<String, rmcp::ErrorData> {
    let q = raw.trim();
    let valid = q.len() == 7
        && q.as_bytes()[4] == b'-'
        && q.as_bytes()[5] == b'Q'
        && q[..4].bytes().all(|b| b.is_ascii_digit())
        && matches!(q.as_bytes()[6], b'1'..=b'4');
    if !valid {
        return Err(rmcp::ErrorData::invalid_params(
            format!("quarter must look like YYYY-Qn (got: {q})"),
            None,
        ));
    }
    Ok(q.to_string())
}

fn to_key_result_dto(kr: crate::models::KeyResult) -> KeyResultDto {
    KeyResultDto {
        id: kr.id,
        title: kr.title,
        kind: enum_wire_string(&kr.kind),
        target_value: kr.target_value,
        current_value: kr.current_value,
        unit: kr.unit,
        progress: kr.progress,
        routine_linked: kr.routine_id.is_some(),
    }
}

fn to_objective_dto(o: crate::models::Objective) -> ObjectiveDto {
    ObjectiveDto {
        id: o.id,
        quarter: o.quarter,
        title: o.title,
        description_preview: o
            .description
            .as_deref()
            .map(|d| truncate_preview(d, TEXT_PREVIEW_CHARS)),
        status: enum_wire_string(&o.status),
        linked_area_keys: o.linked_area_keys,
        linked_project_ids: o.linked_project_ids,
        key_results: o.key_results.into_iter().map(to_key_result_dto).collect(),
    }
}

fn to_check_in_dto(c: crate::models::OkrCheckIn) -> CheckInDto {
    CheckInDto {
        id: c.id,
        key_result_id: c.key_result_id,
        week_start: c.week_start,
        value_snapshot: c.value_snapshot,
        confidence: enum_wire_string(&c.confidence),
        note_preview: c
            .note
            .as_deref()
            .map(|n| truncate_preview(n, TEXT_PREVIEW_CHARS)),
        created_at: c.created_at,
    }
}

#[tool_router(router = tool_router_okr, vis = "pub(crate)")]
impl WrServer {
    #[tool(
        name = "wr_okr_get_mission",
        description = "Return the user's mission statement (or null if unset). Read-only."
    )]
    pub async fn okr_get_mission(&self) -> Result<Json<MissionResultDto>, rmcp::ErrorData> {
        let mission = okr_commands::get_mission_inner(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_okr_get_mission", &e))?;
        Ok(Json(MissionResultDto {
            mission: mission.map(|m| MissionDto {
                statement: m.statement,
                note_preview: m
                    .note
                    .as_deref()
                    .map(|n| truncate_preview(n, TEXT_PREVIEW_CHARS)),
                updated_at: m.updated_at,
            }),
        }))
    }

    #[tool(
        name = "wr_okr_list_objectives",
        description = "List objectives for a quarter (YYYY-Qn) with their key results and derived progress. Read-only."
    )]
    pub async fn okr_list_objectives(
        &self,
        Parameters(p): Parameters<OkrQuarterParams>,
    ) -> Result<Json<ObjectiveListDto>, rmcp::ErrorData> {
        self.okr_list_objectives_inner(p).await
    }

    pub(crate) async fn okr_list_objectives_inner(
        &self,
        p: OkrQuarterParams,
    ) -> Result<Json<ObjectiveListDto>, rmcp::ErrorData> {
        let quarter = clean_quarter(&p.quarter)?;
        let rows = okr_commands::list_objectives_inner(&self.db, &quarter)
            .await
            .map_err(|e| mcp_tool_error("wr_okr_list_objectives", &e))?;
        Ok(Json(ObjectiveListDto {
            objectives: rows.into_iter().map(to_objective_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_okr_list_check_ins",
        description = "List weekly OKR check-ins for a quarter (YYYY-Qn). Read-only."
    )]
    pub async fn okr_list_check_ins(
        &self,
        Parameters(p): Parameters<OkrQuarterParams>,
    ) -> Result<Json<CheckInListDto>, rmcp::ErrorData> {
        self.okr_list_check_ins_inner(p).await
    }

    pub(crate) async fn okr_list_check_ins_inner(
        &self,
        p: OkrQuarterParams,
    ) -> Result<Json<CheckInListDto>, rmcp::ErrorData> {
        let quarter = clean_quarter(&p.quarter)?;
        let rows = okr_commands::list_check_ins_inner(&self.db, &quarter)
            .await
            .map_err(|e| mcp_tool_error("wr_okr_list_check_ins", &e))?;
        Ok(Json(CheckInListDto {
            check_ins: rows.into_iter().map(to_check_in_dto).collect(),
        }))
    }

    /// 주간 confidence 로그. 진행률(`current_value`)은 바꾸지 못한다 — 그건 결정 레일이라 표면에 없다.
    #[tool(
        name = "wr_okr_upsert_check_in",
        description = "Record (or overwrite) the weekly check-in for a key result: a confidence rating plus an optional note. This does NOT change the key result's target or current value, and does not affect its progress."
    )]
    pub async fn okr_upsert_check_in(
        &self,
        Parameters(p): Parameters<OkrUpsertCheckInParams>,
    ) -> Result<Json<UpsertCheckInResult>, rmcp::ErrorData> {
        self.okr_upsert_check_in_inner(p).await
    }

    pub(crate) async fn okr_upsert_check_in_inner(
        &self,
        p: OkrUpsertCheckInParams,
    ) -> Result<Json<UpsertCheckInResult>, rmcp::ErrorData> {
        if let Some(note) = p.note.as_deref() {
            if note.chars().count() > NOTE_MAX_CHARS {
                return Err(rmcp::ErrorData::invalid_params(
                    format!("note exceeds {NOTE_MAX_CHARS} characters"),
                    None,
                ));
            }
        }
        let row = okr_commands::upsert_check_in_inner(
            &self.db,
            &p.key_result_id,
            &p.week_start,
            p.confidence.into(),
            p.note,
        )
        .await
        .map_err(|e| mcp_tool_error("wr_okr_upsert_check_in", &e))?;
        Ok(Json(UpsertCheckInResult {
            id: row.id,
            key_result_id: row.key_result_id,
            week_start: row.week_start,
            confidence: enum_wire_string(&row.confidence),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        KeyResultDto, OkrConfidenceParam, OkrQuarterParams, OkrUpsertCheckInParams,
        UpsertCheckInResult,
    };
    use crate::commands::okr as okr_commands;
    use crate::commands::shared::test_support::fresh_db;
    use crate::db::Db;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::{CreateKeyResultInput, CreateObjectiveInput, KeyResultKind};

    async fn seed_objective_with_kr(db: &Db) -> (String, String) {
        let objective = okr_commands::create_objective_inner(
            db,
            CreateObjectiveInput {
                quarter: "2026-Q3".into(),
                title: "매출 2배".into(),
                description: Some("설명".into()),
                sort_rank: 0,
                linked_area_keys: vec![],
                linked_project_ids: vec![],
            },
        )
        .await
        .expect("objective");
        let kr = okr_commands::create_key_result_inner(
            db,
            CreateKeyResultInput {
                objective_id: objective.id.clone(),
                title: "MRR 1억".into(),
                kind: KeyResultKind::Metric,
                target_value: Some(100.0),
                current_value: Some(25.0),
                unit: Some("백만원".into()),
                milestones: vec![],
                sort_rank: 0,
            },
        )
        .await
        .expect("key result");
        (objective.id, kr.id)
    }

    #[tokio::test]
    async fn list_objectives_returns_nested_key_results_with_progress() {
        let db = fresh_db().await;
        let (objective_id, kr_id) = seed_objective_with_kr(&db).await;
        let server = WrServer { db };

        let out = server
            .okr_list_objectives_inner(OkrQuarterParams {
                quarter: "2026-Q3".into(),
            })
            .await
            .expect("list")
            .0;
        assert_eq!(out.objectives.len(), 1);
        let o = &out.objectives[0];
        assert_eq!(o.id, objective_id);
        assert_eq!(o.status, "active");
        assert_eq!(o.key_results.len(), 1);
        let kr = &o.key_results[0];
        assert_eq!(kr.id, kr_id);
        assert_eq!(kr.kind, "metric");
        assert_eq!(kr.current_value, Some(25.0));
        assert!((kr.progress - 0.25).abs() < 1e-9, "25/100 = 0.25");
        assert!(!kr.routine_linked);

        // 다른 분기는 비어 있다.
        let empty = server
            .okr_list_objectives_inner(OkrQuarterParams {
                quarter: "2026-Q4".into(),
            })
            .await
            .expect("list q4")
            .0;
        assert!(empty.objectives.is_empty());
    }

    #[tokio::test]
    async fn quarter_param_is_validated_not_silently_empty() {
        let db = fresh_db().await;
        let server = WrServer { db };
        for bad in ["2026-Q5", "2026Q3", "26-Q3", "2026-q3", "", "  "] {
            let res = server
                .okr_list_objectives_inner(OkrQuarterParams {
                    quarter: bad.into(),
                })
                .await;
            assert!(res.is_err(), "malformed quarter must be rejected: {bad:?}");
        }
    }

    /// check-in은 **관측 기록**이다 — KR의 target/current/progress를 건드리지 않는다.
    /// 같은 (kr, week_start) 재호출은 덮어쓴다(멱등).
    #[tokio::test]
    async fn check_in_is_idempotent_and_never_moves_key_result_progress() {
        let db = fresh_db().await;
        let (_, kr_id) = seed_objective_with_kr(&db).await;
        let server = WrServer { db: db.clone() };

        let params = |confidence, note: Option<&str>| OkrUpsertCheckInParams {
            key_result_id: kr_id.clone(),
            week_start: "2026-07-06".into(),
            confidence,
            note: note.map(str::to_string),
        };

        let first: UpsertCheckInResult = server
            .okr_upsert_check_in_inner(params(OkrConfidenceParam::AtRisk, Some("벤더 지연")))
            .await
            .expect("check in")
            .0;
        assert_eq!(first.confidence, "at_risk");

        let second = server
            .okr_upsert_check_in_inner(params(OkrConfidenceParam::OnTrack, None))
            .await
            .expect("overwrite check in")
            .0;
        assert_eq!(second.id, first.id, "같은 주 = 같은 행(upsert)");
        assert_eq!(second.confidence, "on_track");

        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM okr_check_ins")
            .fetch_one(&db)
            .await
            .expect("count");
        assert_eq!(rows, 1);

        // KR은 그대로 — confidence는 어떤 파생값도 구동하지 않는다.
        let objectives = server
            .okr_list_objectives_inner(OkrQuarterParams {
                quarter: "2026-Q3".into(),
            })
            .await
            .expect("list")
            .0;
        let kr = &objectives.objectives[0].key_results[0];
        assert_eq!(kr.current_value, Some(25.0));
        assert!((kr.progress - 0.25).abs() < 1e-9);

        // check-in 목록은 그 주의 진행률 스냅샷을 싣는다.
        let check_ins = server
            .okr_list_check_ins_inner(OkrQuarterParams {
                quarter: "2026-Q3".into(),
            })
            .await
            .expect("list check ins")
            .0;
        assert_eq!(check_ins.check_ins.len(), 1);
        assert!((check_ins.check_ins[0].value_snapshot - 0.25).abs() < 1e-9);
        assert_eq!(
            check_ins.check_ins[0].note_preview, None,
            "덮어쓰며 노트 제거"
        );
    }

    #[tokio::test]
    async fn check_in_rejects_unknown_key_result_and_overlong_note() {
        let db = fresh_db().await;
        let (_, kr_id) = seed_objective_with_kr(&db).await;
        let server = WrServer { db };

        let unknown = server
            .okr_upsert_check_in_inner(OkrUpsertCheckInParams {
                key_result_id: "no-such-kr".into(),
                week_start: "2026-07-06".into(),
                confidence: OkrConfidenceParam::OnTrack,
                note: None,
            })
            .await;
        assert!(unknown.is_err(), "unknown key_result_id는 거부");

        let overlong = server
            .okr_upsert_check_in_inner(OkrUpsertCheckInParams {
                key_result_id: kr_id.clone(),
                week_start: "2026-07-06".into(),
                confidence: OkrConfidenceParam::OnTrack,
                note: Some("가".repeat(1001)),
            })
            .await;
        assert!(overlong.is_err(), "노트 상한 초과는 거부");

        let bad_date = server
            .okr_upsert_check_in_inner(OkrUpsertCheckInParams {
                key_result_id: kr_id,
                week_start: "2026/07/06".into(),
                confidence: OkrConfidenceParam::OnTrack,
                note: None,
            })
            .await;
        assert!(bad_date.is_err(), "week_start는 YYYY-MM-DD");
    }

    #[tokio::test]
    async fn get_mission_returns_null_when_unset() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let out = server.okr_get_mission().await.expect("mission").0;
        assert!(out.mission.is_none());

        okr_commands::set_mission_inner(&db, "북극성", Some("메모".into()))
            .await
            .expect("set mission");
        let out = server.okr_get_mission().await.expect("mission").0;
        let m = out.mission.expect("set");
        assert_eq!(m.statement, "북극성");
        assert_eq!(m.note_preview.as_deref(), Some("메모"));
    }

    #[test]
    fn okr_params_schemas_are_closed_and_stable() {
        let quarter = serde_json::to_value(schemars::schema_for!(OkrQuarterParams)).unwrap();
        assert_eq!(quarter["additionalProperties"], serde_json::json!(false));
        assert_eq!(prop_names(&quarter), expect(&["quarter"]));
        assert_eq!(required_fields(&quarter), expect(&["quarter"]));

        let check_in = serde_json::to_value(schemars::schema_for!(OkrUpsertCheckInParams)).unwrap();
        assert_eq!(check_in["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&check_in),
            expect(&["key_result_id", "week_start", "confidence", "note"])
        );
        assert_eq!(
            required_fields(&check_in),
            expect(&["key_result_id", "week_start", "confidence"])
        );
        // check-in은 진행률을 못 바꾼다 — 결정 레일 필드가 스키마에 존재하지 않는다.
        for forbidden in [
            "current_value",
            "target_value",
            "progress",
            "value_snapshot",
        ] {
            assert!(
                !prop_names(&check_in).contains(forbidden),
                "check-in must not accept `{forbidden}`"
            );
        }
    }

    #[test]
    fn key_result_dto_hides_routine_id() {
        let v = serde_json::to_value(schemars::schema_for!(KeyResultDto)).unwrap();
        assert_eq!(
            prop_names(&v),
            expect(&[
                "id",
                "title",
                "kind",
                "target_value",
                "current_value",
                "unit",
                "progress",
                "routine_linked",
            ])
        );
        assert!(!prop_names(&v).contains("routine_id"));
        assert!(!prop_names(&v).contains("milestones"));
    }
}
