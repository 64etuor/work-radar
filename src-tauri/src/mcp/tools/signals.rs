//! Braindump/신호 툴 — 캡처 레인.
//!
//! `wr_create_signal`은 `signal_store::insert_signal_reporting_dedup`을 부른다. 그 SQL이
//! `quadrant='unclassified'`를 하드코딩하고 `dedup_key = braindump:normalize(title)`로 upsert하므로,
//! **에이전트는 카드를 만들 수는 있어도 분류할 수는 없다**(INVARIANT #1) — 자동 dedup(#3)도 공짜다.
//!
//! 분류/승격/상태확정(`classify_signal`·`promote_today`·`set_signal_status`·`snooze_signal`·
//! `delete_signal`)은 표면에 **없다** — `surface_tests::decision_rail_writes_never_reach_the_mcp_surface`.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::signal_store;
use crate::error::AppError;
use crate::mcp::{enum_wire_string, mcp_tool_error, truncate_preview, WrServer};
use crate::models::{CreateSignalInput, Kind, Quadrant, WorkSignal};

/// 본문 미리보기 상한(§6 — 장문 echo 금지).
const BODY_PREVIEW_CHARS: usize = 280;
/// 제목 상한(§2 — 자유 문자열은 길이를 좁힌다).
const TITLE_MAX_CHARS: usize = 160;
/// FTS 질의 상한.
const QUERY_MAX_CHARS: usize = 200;

/// MCP 표면 전용 사분면 enum. 도메인 `Quadrant`에 `schemars::JsonSchema`를 달아 models가 schemars에
/// 결합되는 걸 피한다(§2: 닫힌 enum을 표면에서 직접 정의).
#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum QuadrantParam {
    Q1DoNow,
    Q2Schedule,
    Q3QuickContain,
    Q4Drop,
    Unclassified,
}

impl From<QuadrantParam> for Quadrant {
    fn from(q: QuadrantParam) -> Self {
        match q {
            QuadrantParam::Q1DoNow => Quadrant::Q1DoNow,
            QuadrantParam::Q2Schedule => Quadrant::Q2Schedule,
            QuadrantParam::Q3QuickContain => Quadrant::Q3QuickContain,
            QuadrantParam::Q4Drop => Quadrant::Q4Drop,
            QuadrantParam::Unclassified => Quadrant::Unclassified,
        }
    }
}

/// 개인/업무 힌트(결정 레일 아님 — 메타데이터).
#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum KindParam {
    Personal,
    Work,
}

impl From<KindParam> for Kind {
    fn from(k: KindParam) -> Self {
        match k {
            KindParam::Personal => Kind::Personal,
            KindParam::Work => Kind::Work,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListSignalsParams {
    /// FTS 전문 검색어. 있으면 보관/완료 카드까지 포함한 **전체**에서 찾고, 없으면 활성
    /// 매트릭스/미분류(Today 미승격, done/archived/snoozed 제외)만 반환한다.
    pub query: Option<String>,
    /// 사분면 필터.
    pub quadrant: Option<QuadrantParam>,
    /// 개인/업무 필터.
    pub kind: Option<KindParam>,
    /// 프로젝트 필터.
    pub project_id: Option<String>,
    /// 결과 상한(서버가 1..=100으로 clamp; 기본 25).
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSignalParams {
    /// 카드 제목(1..=160자). dedup 키가 여기서 정규화 파생된다.
    pub title: String,
    /// 개인/업무 힌트(선택).
    pub kind: Option<KindParam>,
    /// 소속 프로젝트(선택 — 없으면 나중에 reconcile).
    pub project_id: Option<String>,
}

/// Sanitized signal row. 본문은 preview로 잘린다(§6).
#[derive(Serialize, JsonSchema)]
pub struct SignalDto {
    pub id: String,
    pub title: String,
    /// 본문 앞부분(≤280자, 잘리면 말줄임표). 원문 전체는 표면에 없다.
    pub body_preview: Option<String>,
    pub source: String,
    pub signal_type: String,
    /// 사람 결정값. `wr_create_signal`로 만든 카드는 항상 "unclassified".
    pub quadrant: String,
    pub kind: Option<String>,
    pub area: Option<String>,
    pub status: String,
    /// Today 레일에 올라간 날(YYYY-MM-DD) 또는 null.
    pub today_for_date: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, JsonSchema)]
pub struct SignalListDto {
    pub signals: Vec<SignalDto>,
    /// limit 적용 전 필터링 결과 수.
    pub total: u32,
    /// `signals`가 limit에 잘렸는지.
    pub truncated: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct CreateSignalResult {
    pub id: String,
    pub title: String,
    /// 항상 "unclassified" — 분류는 사람만 한다(INVARIANT #1).
    pub quadrant: String,
    /// 같은 정규화 제목의 기존 카드에 합쳐졌으면 true(새 행 없음, INVARIANT #3).
    pub deduped: bool,
}

fn to_signal_dto(s: WorkSignal) -> SignalDto {
    SignalDto {
        id: s.id,
        title: s.title,
        body_preview: s
            .body
            .as_deref()
            .map(|b| truncate_preview(b, BODY_PREVIEW_CHARS)),
        source: enum_wire_string(&s.source),
        signal_type: enum_wire_string(&s.signal_type),
        quadrant: enum_wire_string(&s.quadrant),
        kind: s.kind.map(|k| enum_wire_string(&k)),
        area: s.area.map(|a| enum_wire_string(&a)),
        status: enum_wire_string(&s.status),
        today_for_date: s.today_for_date,
        project_id: s.project_id,
        created_at: s.created_at,
    }
}

#[allow(clippy::result_large_err)]
fn clean_title(raw: &str) -> Result<String, rmcp::ErrorData> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(rmcp::ErrorData::invalid_params(
            "title must not be empty",
            None,
        ));
    }
    if title.chars().count() > TITLE_MAX_CHARS {
        return Err(rmcp::ErrorData::invalid_params(
            format!("title exceeds {TITLE_MAX_CHARS} characters"),
            None,
        ));
    }
    Ok(title.to_string())
}

#[tool_router(router = tool_router_signals, vis = "pub(crate)")]
impl WrServer {
    /// 신호(카드) 조회. 로컬 SQLite read — 모든 caller 개방.
    #[tool(
        name = "wr_list_signals",
        description = "List capture-board signals (cards). Without `query` returns the active matrix + unclassified cards; with `query` runs full-text search across all cards. Body is truncated to a preview. Read-only."
    )]
    pub async fn list_signals(
        &self,
        Parameters(p): Parameters<ListSignalsParams>,
    ) -> Result<Json<SignalListDto>, rmcp::ErrorData> {
        self.list_signals_inner(p).await
    }

    pub(crate) async fn list_signals_inner(
        &self,
        p: ListSignalsParams,
    ) -> Result<Json<SignalListDto>, rmcp::ErrorData> {
        let limit = p.limit.unwrap_or(25).clamp(1, 100);

        let rows = match p.query.as_deref().map(str::trim) {
            Some(q) if !q.is_empty() => {
                if q.chars().count() > QUERY_MAX_CHARS {
                    return Err(rmcp::ErrorData::invalid_params(
                        format!("query exceeds {QUERY_MAX_CHARS} characters"),
                        None,
                    ));
                }
                signal_store::search_signals(&self.db, q).await
            }
            _ => signal_store::fetch_signals(&self.db).await,
        }
        .map_err(|e| mcp_tool_error("wr_list_signals", &AppError::from(e)))?;

        let quadrant = p.quadrant.map(Quadrant::from);
        let kind = p.kind.map(Kind::from);
        let filtered: Vec<WorkSignal> = rows
            .into_iter()
            .filter(|s| quadrant.is_none_or(|q| s.quadrant == q))
            .filter(|s| kind.is_none_or(|k| s.kind == Some(k)))
            .filter(|s| match p.project_id.as_deref() {
                Some(pid) => s.project_id.as_deref() == Some(pid),
                None => true,
            })
            .collect();

        let total = filtered.len() as u32;
        let truncated = total as usize > limit as usize;
        let signals = filtered
            .into_iter()
            .take(limit as usize)
            .map(to_signal_dto)
            .collect();
        Ok(Json(SignalListDto {
            signals,
            total,
            truncated,
        }))
    }

    /// 한 줄 braindump 캡처. **항상 `unclassified`로 진입**하고 같은 정규화 제목은 기존 카드에
    /// 합쳐진다 — 둘 다 `insert_signal_reporting_dedup`의 SQL이 강제한다(#1/#3).
    #[tool(
        name = "wr_create_signal",
        description = "Capture a one-line thought as a capture-board card. The card always enters as `unclassified` — this tool cannot classify, promote, or set status. Identical normalized titles merge into the existing card (returns deduped=true)."
    )]
    pub async fn create_signal(
        &self,
        Parameters(p): Parameters<CreateSignalParams>,
    ) -> Result<Json<CreateSignalResult>, rmcp::ErrorData> {
        self.create_signal_inner(p).await
    }

    pub(crate) async fn create_signal_inner(
        &self,
        p: CreateSignalParams,
    ) -> Result<Json<CreateSignalResult>, rmcp::ErrorData> {
        let title = clean_title(&p.title)?;
        let input = CreateSignalInput {
            title,
            kind: p.kind.map(Kind::from),
            project_id: p.project_id,
        };
        let (signal, deduped) = signal_store::insert_signal_reporting_dedup(&self.db, &input)
            .await
            .map_err(|e| mcp_tool_error("wr_create_signal", &AppError::from(e)))?;
        Ok(Json(CreateSignalResult {
            id: signal.id,
            title: signal.title,
            quadrant: enum_wire_string(&signal.quadrant),
            deduped,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{CreateSignalParams, KindParam, ListSignalsParams, QuadrantParam, SignalDto};
    use crate::commands::shared::test_support::fresh_db;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;

    fn capture(title: &str) -> CreateSignalParams {
        CreateSignalParams {
            title: title.into(),
            kind: None,
            project_id: None,
        }
    }

    /// INVARIANT #1: MCP로 만든 카드는 항상 미분류로 진입한다.
    /// INVARIANT #3: 같은 정규화 제목은 새 행을 만들지 않고 합쳐진다.
    #[tokio::test]
    async fn create_signal_enters_unclassified_and_dedups() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        let first = server
            .create_signal_inner(capture("  전기요금  납부   확인 "))
            .await
            .expect("capture")
            .0;
        assert_eq!(first.quadrant, "unclassified");
        assert!(!first.deduped, "첫 캡처는 새 카드");
        assert_eq!(
            first.title, "전기요금  납부   확인",
            "trim만, 내부 공백 보존"
        );

        // 정규화(소문자 + 공백 축약)가 같으면 같은 카드로 합쳐진다.
        let second = server
            .create_signal_inner(capture("전기요금 납부 확인"))
            .await
            .expect("dedup capture")
            .0;
        assert_eq!(second.id, first.id, "같은 dedup_key → 같은 카드");
        assert!(second.deduped, "합쳐졌음을 caller에게 알린다");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM signals")
            .fetch_one(&db)
            .await
            .expect("count");
        assert_eq!(count, 1, "append 아님 — upsert");
    }

    #[tokio::test]
    async fn create_signal_rejects_empty_and_overlong_titles() {
        let db = fresh_db().await;
        let server = WrServer { db };

        assert!(server.create_signal_inner(capture("   ")).await.is_err());
        let long = "가".repeat(161);
        assert!(server.create_signal_inner(capture(&long)).await.is_err());
        // 상한 경계는 통과한다.
        let exact = "나".repeat(160);
        assert!(server.create_signal_inner(capture(&exact)).await.is_ok());
    }

    #[tokio::test]
    async fn list_signals_filters_and_reports_truncation() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        for i in 0..3 {
            server
                .create_signal_inner(CreateSignalParams {
                    title: format!("업무 카드 {i}"),
                    kind: Some(KindParam::Work),
                    project_id: None,
                })
                .await
                .expect("work capture");
        }
        server
            .create_signal_inner(CreateSignalParams {
                title: "개인 카드".into(),
                kind: Some(KindParam::Personal),
                project_id: None,
            })
            .await
            .expect("personal capture");

        let all = server
            .list_signals_inner(ListSignalsParams {
                query: None,
                quadrant: None,
                kind: None,
                project_id: None,
                limit: None,
            })
            .await
            .expect("list")
            .0;
        assert_eq!(all.total, 4);
        assert!(!all.truncated);
        assert!(all.signals.iter().all(|s| s.quadrant == "unclassified"));
        assert!(all.signals.iter().all(|s| s.source == "braindump"));

        // kind 필터.
        let work = server
            .list_signals_inner(ListSignalsParams {
                query: None,
                quadrant: None,
                kind: Some(KindParam::Work),
                project_id: None,
                limit: None,
            })
            .await
            .expect("list work")
            .0;
        assert_eq!(work.total, 3);

        // limit → truncated 신호(무신호 절단 금지).
        let capped = server
            .list_signals_inner(ListSignalsParams {
                query: None,
                quadrant: None,
                kind: None,
                project_id: None,
                limit: Some(2),
            })
            .await
            .expect("list capped")
            .0;
        assert_eq!(capped.signals.len(), 2);
        assert_eq!(capped.total, 4, "total은 절단 전 개수");
        assert!(capped.truncated);

        // 새 카드는 전부 unclassified라 q1 필터는 0건.
        let q1 = server
            .list_signals_inner(ListSignalsParams {
                query: None,
                quadrant: Some(QuadrantParam::Q1DoNow),
                kind: None,
                project_id: None,
                limit: None,
            })
            .await
            .expect("list q1")
            .0;
        assert_eq!(q1.total, 0);
    }

    #[tokio::test]
    async fn list_signals_full_text_search_finds_captured_card() {
        let db = fresh_db().await;
        let server = WrServer { db };
        server
            .create_signal_inner(capture("분기 예산 재검토"))
            .await
            .expect("capture");
        server
            .create_signal_inner(capture("치과 예약"))
            .await
            .expect("capture");

        let hits = server
            .list_signals_inner(ListSignalsParams {
                query: Some("예산".into()),
                quadrant: None,
                kind: None,
                project_id: None,
                limit: None,
            })
            .await
            .expect("search")
            .0;
        assert_eq!(hits.total, 1);
        assert_eq!(hits.signals[0].title, "분기 예산 재검토");
    }

    #[test]
    fn signal_params_schemas_are_closed_and_stable() {
        let create = serde_json::to_value(schemars::schema_for!(CreateSignalParams)).unwrap();
        assert_eq!(create["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&create),
            expect(&["title", "kind", "project_id"])
        );
        assert_eq!(required_fields(&create), expect(&["title"]));
        // 캡처 툴은 분류/상태를 받지 않는다 — 결정 레일이 스키마에 존재하지 않는다(#1).
        for forbidden in ["quadrant", "status", "area", "today_for_date"] {
            assert!(
                !prop_names(&create).contains(forbidden),
                "capture tool must not accept `{forbidden}`"
            );
        }

        let list = serde_json::to_value(schemars::schema_for!(ListSignalsParams)).unwrap();
        assert_eq!(list["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&list),
            expect(&["query", "quadrant", "kind", "project_id", "limit"])
        );
        for forbidden in ["raw_sql", "url", "command", "token", "credential_ref"] {
            assert!(!prop_names(&list).contains(forbidden));
        }
    }

    #[test]
    fn signal_dto_surface_is_locked() {
        let v = serde_json::to_value(schemars::schema_for!(SignalDto)).unwrap();
        assert_eq!(
            prop_names(&v),
            expect(&[
                "id",
                "title",
                "body_preview",
                "source",
                "signal_type",
                "quadrant",
                "kind",
                "area",
                "status",
                "today_for_date",
                "project_id",
                "created_at",
            ])
        );
        // 원문 body 전체는 표면에 없다(preview만) — §6 장문 echo 금지.
        assert!(!prop_names(&v).contains("body"));
        assert!(!prop_names(&v).contains("dedup_key"));
    }
}
