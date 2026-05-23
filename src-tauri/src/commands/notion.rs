use tauri::State;

use crate::commands::signal_store;
use crate::commands::signals::insert_promotion_draft;
use crate::db::Db;
use crate::error::AppError;
use crate::keychain;
use crate::models::{
    FlushSummary, Promotion, PromotionOutcome, PromotionStatus, PromotionTarget, TokenKind,
};
use crate::notion::{find_title_prop, HttpNotionWriter, NotionError, NotionWriter};

// ── Notion 승격 (write 레일, Phase 3 — 즉시 write) ─────────────────────────────
// INVARIANT #2: 사람이 카드 메뉴를 누르는 것이 곧 결정/accept다(자동화 출력 아님 → acceptances
//   테이블 미관여). 자동화-draft의 2단계 게이트(Phase 9)를 위해 `confirmed` 상태는 보존한다.
// INVARIANT #3: 같은 (signal,target)이 이미 created면 중복 write 없이 기존 결과를 반환하고,
//   오프라인 재시도는 같은 draft 행을 재사용한다(큐 중복 0).
// INVARIANT #5/#7: write는 notion.rs의 bounded retry/backoff/jitter를 거치고, 결과(외부 ID/URL)는
//   promotions(승격 이력 SSOT)에 기록된다. 토큰은 keychain에서만 읽혀 Rust 안에서만 쓰인다.

const PROMOTION_COLS: &str =
    "id, signal_id, target, status, draft_payload, created_external_id, created_at";

/// notion write 가능한 타깃의 signals.links 키. calendar/today는 None(이 경로 아님).
fn notion_link_key(target: PromotionTarget) -> Option<&'static str> {
    match target {
        PromotionTarget::NotionBacklog => Some("notionBacklogId"),
        PromotionTarget::NotionAgenda => Some("notionAgendaId"),
        _ => None,
    }
}

/// draft_payload(JSON)에서 문자열 필드 추출.
fn payload_str(payload: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get(key).and_then(|s| s.as_str()).map(String::from))
}

/// (signal,target)의 특정 상태 promotion 1건(최신).
async fn find_promotion(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
    status: PromotionStatus,
) -> Result<Option<Promotion>, sqlx::Error> {
    sqlx::query_as::<_, Promotion>(&format!(
        "SELECT {PROMOTION_COLS} FROM promotions \
         WHERE signal_id = ?1 AND target = ?2 AND status = ?3 \
         ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(signal_id)
    .bind(target)
    .bind(status)
    .fetch_one(db)
    .await
    .map(Some)
    .or_else(|e| match e {
        sqlx::Error::RowNotFound => Ok(None),
        other => Err(other),
    })
}

/// write 성공 반영: promotion → created(+외부ID·URL을 payload에 머지), signal → links 머지 + linked.
async fn finalize_created(
    db: &Db,
    promo_id: &str,
    signal_id: &str,
    target: PromotionTarget,
    page: &crate::notion::CreatedPage,
) -> Result<(), sqlx::Error> {
    let existing: (String,) = sqlx::query_as("SELECT draft_payload FROM promotions WHERE id = ?1")
        .bind(promo_id)
        .fetch_one(db)
        .await?;
    let mut payload: serde_json::Value =
        serde_json::from_str(&existing.0).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("pageId".into(), serde_json::json!(page.id));
        obj.insert("url".into(), serde_json::json!(page.url));
    }
    sqlx::query(
        "UPDATE promotions SET status = 'created', created_external_id = ?2, draft_payload = ?3 \
         WHERE id = ?1",
    )
    .bind(promo_id)
    .bind(&page.id)
    .bind(payload.to_string())
    .execute(db)
    .await?;

    if let Some(key) = notion_link_key(target) {
        let existing = signal_store::fetch_signal_links(db, signal_id).await?;
        let mut links: serde_json::Value = existing
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = links.as_object_mut() {
            obj.insert(key.into(), serde_json::json!(page.id));
        }
        signal_store::set_signal_links_linked(db, signal_id, &links.to_string()).await?;
    }
    Ok(())
}

/// 승격 실행을 직렬화하는 in-process 게이트. 같은 카드의 동시 승격(더블클릭, flush vs 수동)이
/// check-then-act 경합으로 중복 Notion 페이지/중복 created 행을 만드는 것을 막는다(INVARIANT #3).
/// Tauri 백엔드는 단일 프로세스라 in-process 게이트로 충분하고, 네트워크는 이미 RateLimiter로
/// paced되어 추가 지연은 무시 가능. (per-(signal,target) 분리는 향후 최적화 — 단일 사용자엔 불필요.)
/// DB 레벨 partial unique index(0003)가 구조적 2차 방어선.
static PROMOTION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 승격 실행 코어(테스트 가능 — writer를 fake로 대체). keychain/네트워크는 호출자(command)가 담당.
/// 멱등(created 재사용) → draft find-or-create → write → 상태 전이(created/draft 큐잉/failed).
async fn execute_promotion<W: NotionWriter>(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
    writer: &W,
    token: &str,
    db_id: &str,
) -> Result<PromotionOutcome, sqlx::Error> {
    // 같은 카드 동시 승격을 직렬화 — 두 번째는 아래 created 멱등 분기로 빠진다(중복 write 0).
    let _gate = PROMOTION_GATE.lock().await;

    // 멱등: 이미 created면 중복 write 없이 기존 결과 반환(INVARIANT #3).
    if let Some(done) = find_promotion(db, signal_id, target, PromotionStatus::Created).await? {
        return Ok(PromotionOutcome {
            page_url: payload_str(&done.draft_payload, "url"),
            promotion_id: done.id,
            status: PromotionStatus::Created,
            detail: "이미 등록됨".into(),
            resolved_project_id: None,
        });
    }
    // 큐 행(draft) 재사용 또는 생성. title 스냅샷은 payload에 보존된다.
    let promo = match find_promotion(db, signal_id, target, PromotionStatus::Draft).await? {
        Some(p) => p,
        None => insert_promotion_draft(db, signal_id, target).await?,
    };
    let title = payload_str(&promo.draft_payload, "title").unwrap_or_default();

    match writer.create_page(token, db_id, &title).await {
        Ok(page) => {
            finalize_created(db, &promo.id, signal_id, target, &page).await?;
            Ok(PromotionOutcome {
                promotion_id: promo.id,
                status: PromotionStatus::Created,
                page_url: Some(page.url),
                detail: "Notion 페이지 생성됨".into(),
                resolved_project_id: None,
            })
        }
        // 일시 실패: draft 유지(큐). 복구 시 flush가 재시도(INVARIANT #5: 무한 retry 아님).
        Err(NotionError::Transient(msg)) => Ok(PromotionOutcome {
            promotion_id: promo.id,
            status: PromotionStatus::Draft,
            page_url: None,
            detail: format!("오프라인/일시 오류 — 큐에 저장됨(복구 시 등록): {msg}"),
            resolved_project_id: None,
        }),
        // 영구 실패(인증/권한/검증 등): failed로 표시하고 사유 노출.
        Err(NotionError::Terminal(msg)) => {
            sqlx::query("UPDATE promotions SET status = 'failed' WHERE id = ?1")
                .bind(&promo.id)
                .execute(db)
                .await?;
            Ok(PromotionOutcome {
                promotion_id: promo.id,
                status: PromotionStatus::Failed,
                page_url: None,
                detail: msg,
                resolved_project_id: None,
            })
        }
        // DB를 찾을 수 없음 (404): ID 오류 또는 통합 미공유 — 액션 가능 메시지로 failed.
        Err(NotionError::NotFound(msg)) => {
            sqlx::query("UPDATE promotions SET status = 'failed' WHERE id = ?1")
                .bind(&promo.id)
                .execute(db)
                .await?;
            Ok(PromotionOutcome {
                promotion_id: promo.id,
                status: PromotionStatus::Failed,
                page_url: None,
                detail: msg,
                resolved_project_id: None,
            })
        }
        // 권한 없음 (403): 통합 권한 부족 — 액션 가능 메시지로 failed.
        Err(NotionError::Forbidden(msg)) => {
            sqlx::query("UPDATE promotions SET status = 'failed' WHERE id = ?1")
                .bind(&promo.id)
                .execute(db)
                .await?;
            Ok(PromotionOutcome {
                promotion_id: promo.id,
                status: PromotionStatus::Failed,
                page_url: None,
                detail: msg,
                resolved_project_id: None,
            })
        }
    }
}

/// signal → project → (Notion 토큰, 대상 DB ID, 실제 project_id) 해석.
/// `explicit_project_id`가 Some이면 그 프로젝트를 쓰고 signal.project_id에 persist한다.
/// None이면 signal.project_id를 조회하고, NULL이면 kind 매칭 프로젝트를 자동 해석한다:
///
/// - 1개 → persist + 사용 (자동 지정, 사람이 나중에 설정에서 변경 가능)
/// - >1개 → Err("프로젝트 선택 필요(여러 프로젝트)") — 프런트가 picker를 표시
/// - 0개 → Err("해당 kind의 프로젝트가 없음") — 프런트가 설정 안내
///
/// notion 타깃 아님이면 즉시 Err.
async fn resolve_notion_target(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
    explicit_project_id: Option<&str>,
) -> Result<(String, String, String), String> {
    if notion_link_key(target).is_none() {
        return Err("Notion 타깃이 아님(calendar/today는 이 경로로 승격하지 않음)".into());
    }

    // 신호 조회 (project_id + kind).
    let sig = signal_store::fetch_signal_project_kind(db, signal_id)
        .await
        .map_err(|e| e.to_string())?;
    let (existing_project_id, signal_kind) = sig.ok_or("신호를 찾을 수 없음")?;

    // 사용할 project_id 결정 + 필요 시 signal에 persist.
    let project_id: String = if let Some(pid) = explicit_project_id {
        // 명시 전달: persist onto signal (사람이 picker에서 고른 것 — INVARIANT #1).
        signal_store::set_signal_project(db, signal_id, pid)
            .await
            .map_err(|e| e.to_string())?;
        pid.to_string()
    } else if let Some(pid) = existing_project_id {
        // 이미 태깅된 경우 → 기존 동작.
        pid
    } else {
        // signal.project_id NULL → kind 매칭 프로젝트 자동 해석.
        let kind_str = signal_kind.as_deref().unwrap_or("");
        let candidates: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM projects WHERE kind = ?1 ORDER BY created_at")
                .bind(kind_str)
                .fetch_all(db)
                .await
                .map_err(|e| e.to_string())?;
        match candidates.len() {
            0 => return Err("해당 kind의 프로젝트가 없음(설정에서 프로젝트 생성 필요)".into()),
            1 => {
                let pid = candidates
                    .into_iter()
                    .next()
                    .expect("candidates.len() == 1 (matched above)")
                    .0;
                // 자동 지정: persist onto signal (INVARIANT #1 — 자동 확정이 아닌 메타데이터 태깅).
                signal_store::set_signal_project(db, signal_id, &pid)
                    .await
                    .map_err(|e| e.to_string())?;
                pid
            }
            _ => {
                // 여러 프로젝트 — 사람이 선택해야 함 (INVARIANT #1).
                return Err(
                    "프로젝트 선택 필요(여러 프로젝트) — 프런트에서 picker를 표시할 것".into(),
                );
            }
        }
    };

    let proj: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT credential_ref, notion_backlog_db_id, notion_agenda_db_id FROM projects WHERE id = ?1",
    )
    .bind(&project_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let (cref, backlog, agenda) = proj.ok_or("프로젝트를 찾을 수 없음")?;

    let db_id = match target {
        PromotionTarget::NotionBacklog => backlog,
        PromotionTarget::NotionAgenda => agenda,
        _ => None,
    }
    .ok_or("프로젝트에 Notion DB ID가 설정되지 않음(설정에서 바인딩 필요)")?;

    let token = keychain::get_token(&cref, TokenKind::Notion)
        .map_err(|e| e.to_string())?
        .ok_or("Notion 토큰이 없음(설정에서 토큰 저장 필요)")?;

    Ok((token, db_id, project_id))
}

/// 카드 → Notion 백로그/안건 즉시 승격(write). 사람이 누른 결정이므로 즉시 write한다(INVARIANT #2).
/// `project_id`: 프런트 picker에서 사람이 고른 프로젝트(Some) 또는 자동 해석 위임(None).
/// 자동 해석 결과는 outcome.resolved_project_id로 반환 — 프런트가 라벨을 표시한다(INVARIANT #1).
#[tauri::command]
#[specta::specta]
pub async fn promote_to_notion(
    db: State<'_, Db>,
    signal_id: String,
    target: PromotionTarget,
    project_id: Option<String>,
) -> Result<PromotionOutcome, AppError> {
    let (token, db_id, resolved_pid) =
        resolve_notion_target(db.inner(), &signal_id, target, project_id.as_deref())
            .await
            .map_err(|e| AppError::terminal("notion.promote_resolve", e))?;
    let writer = HttpNotionWriter::new()?;
    let mut outcome =
        execute_promotion(db.inner(), &signal_id, target, &writer, &token, &db_id).await?;
    // 자동 지정(또는 명시 전달)된 project_id를 outcome에 노출해 프런트 라벨용으로 돌려준다.
    outcome.resolved_project_id = Some(resolved_pid);
    Ok(outcome)
}

/// 오프라인 큐 flush: 토큰/DB가 갖춰진 draft notion 승격을 모두 재시도한다. 복구 시 호출.
async fn flush_inner<W: NotionWriter>(db: &Db, writer: &W) -> Result<FlushSummary, sqlx::Error> {
    let drafts = sqlx::query_as::<_, Promotion>(&format!(
        "SELECT {PROMOTION_COLS} FROM promotions \
         WHERE status = 'draft' AND target IN ('notion_backlog','notion_agenda') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await?;

    let mut summary = FlushSummary {
        created: 0,
        queued: 0,
        failed: 0,
    };
    for promo in drafts {
        // 토큰/DB 미설정이면 큐 유지(복구 대상). 네트워크/일시 오류도 draft로 남는다.
        // flush 경로: explicit_project_id 없음(자동 해석). 여전히 미설정이면 큐 유지.
        let Ok((token, db_id, _pid)) =
            resolve_notion_target(db, &promo.signal_id, promo.target, None).await
        else {
            summary.queued += 1;
            continue;
        };
        // 한 건의 DB 오류가 배치 전체를 멈추지 않게 — 해당 건은 큐 유지하고 계속(복구 다음 회차에 재시도).
        match execute_promotion(db, &promo.signal_id, promo.target, writer, &token, &db_id).await {
            Ok(outcome) => match outcome.status {
                PromotionStatus::Created => summary.created += 1,
                PromotionStatus::Failed => summary.failed += 1,
                _ => summary.queued += 1,
            },
            Err(_) => summary.queued += 1,
        }
    }
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn flush_promotions(db: State<'_, Db>) -> Result<FlushSummary, AppError> {
    let writer = HttpNotionWriter::new()?;
    Ok(flush_inner(db.inner(), &writer).await?)
}

/// 프로젝트의 Notion DB 연결을 테스트한다. token은 keychain에서 Rust 안에서만 읽고 반환하지 않는다.
/// 성공: DB title 속성명을 포함한 짧은 확인 메시지. 실패: 액션 가능 에러 메시지.
#[tauri::command]
#[specta::specta]
pub async fn test_notion_connection(
    db: State<'_, Db>,
    project_id: String,
    target: PromotionTarget,
) -> Result<String, AppError> {
    // 프로젝트에서 credential_ref + DB ID 조회.
    let proj: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT credential_ref, notion_backlog_db_id, notion_agenda_db_id FROM projects WHERE id = ?1",
    )
    .bind(&project_id)
    .fetch_optional(db.inner())
    .await?;
    let (cref, backlog, agenda) = proj.ok_or_else(|| {
        AppError::not_found("notion.project_not_found", "프로젝트를 찾을 수 없음")
    })?;

    let db_id = match target {
        PromotionTarget::NotionBacklog => backlog,
        PromotionTarget::NotionAgenda => agenda,
        _ => {
            return Err(AppError::validation(
                "notion.invalid_target",
                "Notion 타깃이 아님",
            ))
        }
    }
    .ok_or_else(|| {
        AppError::not_found(
            "notion.db_id_missing",
            "프로젝트에 Notion DB ID가 설정되지 않음(설정에서 바인딩 필요)",
        )
    })?;

    // 토큰 keychain에서만 — 반환하지 않는다(INVARIANT).
    let token = keychain::get_token(&cref, TokenKind::Notion)?.ok_or_else(|| {
        AppError::not_found(
            "notion.token_missing",
            "Notion 토큰이 없음(설정에서 토큰 저장 필요)",
        )
    })?;

    // GET /databases/{id} — HttpNotionWriter의 rate limiter를 거치지 않고 직접 호출한다
    // (테스트 단발이므로 pacing 불필요). reqwest 클라이언트를 최소 구성으로 직접 사용한다.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let resp = client
        .get(format!("https://api.notion.com/v1/databases/{db_id}"))
        .bearer_auth(&token)
        .header("Notion-Version", crate::notion::NOTION_VERSION)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        let err = crate::notion::classify_http_pub(status, &body);
        return Err(AppError::from(err));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::terminal("notion.parse_error", format!("응답 파싱 실패: {e}")))?;
    let title_prop = find_title_prop(&json).unwrap_or_else(|| "(title 속성 없음)".into());
    Ok(format!("연결됨 — DB title 속성: {title_prop}"))
}

/// 승격 이력(undo/audit). signal_id가 있으면 그 신호만, 없으면 전체(최신순).
#[tauri::command]
#[specta::specta]
pub async fn list_promotions(
    db: State<'_, Db>,
    signal_id: Option<String>,
) -> Result<Vec<Promotion>, AppError> {
    let rows = if let Some(sid) = signal_id {
        sqlx::query_as::<_, Promotion>(&format!(
            "SELECT {PROMOTION_COLS} FROM promotions WHERE signal_id = ?1 ORDER BY created_at DESC"
        ))
        .bind(sid)
        .fetch_all(db.inner())
        .await
    } else {
        sqlx::query_as::<_, Promotion>(&format!(
            "SELECT {PROMOTION_COLS} FROM promotions ORDER BY created_at DESC"
        ))
        .fetch_all(db.inner())
        .await
    };
    Ok(rows?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::insert_signal;
    use crate::models::Kind;
    use crate::notion::CreatedPage;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 테스트용 fake Notion writer — 정해진 결과를 돌려주고 호출 횟수를 센다(실 네트워크 없음).
    /// `delay_ms`로 write 임계 구간을 넓혀 동시 승격 경합을 재현한다.
    struct CountingWriter {
        result: Result<CreatedPage, NotionError>,
        calls: AtomicU32,
        delay_ms: u64,
    }
    impl CountingWriter {
        fn ok(id: &str, url: &str) -> Self {
            Self {
                result: Ok(CreatedPage {
                    id: id.into(),
                    url: url.into(),
                }),
                calls: AtomicU32::new(0),
                delay_ms: 0,
            }
        }
        fn err(e: NotionError) -> Self {
            Self {
                result: Err(e),
                calls: AtomicU32::new(0),
                delay_ms: 0,
            }
        }
        fn slow_ok(id: &str, url: &str, delay_ms: u64) -> Self {
            let mut w = Self::ok(id, url);
            w.delay_ms = delay_ms;
            w
        }
    }
    impl NotionWriter for CountingWriter {
        async fn create_page(
            &self,
            _token: &str,
            _db_id: &str,
            _title: &str,
        ) -> Result<CreatedPage, NotionError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            }
            self.result.clone()
        }
    }
    // ── Phase 3: Notion 승격(write) 코어 ──────────────────────────────────────

    async fn promo_status(db: &Db, signal_id: &str) -> String {
        let r: (String,) = sqlx::query_as("SELECT status FROM promotions WHERE signal_id = ?1")
            .bind(signal_id)
            .fetch_one(db)
            .await
            .unwrap();
        r.0
    }

    /// 성공: promotion=created(+외부ID), signal=linked(+links), page_url 반환.
    #[tokio::test]
    async fn promote_creates_page_logs_and_links_signal() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("백로그 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::ok("page-1", "https://www.notion.so/page-1");

        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "tok",
            "db",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Created));
        assert_eq!(
            outcome.page_url.as_deref(),
            Some("https://www.notion.so/page-1")
        );

        // promotions: 외부 ID가 로컬에 기록됨(undo/audit 데이터, INVARIANT #7).
        let p: (String, Option<String>) = sqlx::query_as(
            "SELECT status, created_external_id FROM promotions WHERE signal_id = ?1",
        )
        .bind(&sig.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(p.0, "created");
        assert_eq!(p.1.as_deref(), Some("page-1"));

        // signal: linked + links 미러.
        let s: (String, Option<String>) =
            sqlx::query_as("SELECT status, links FROM signals WHERE id = ?1")
                .bind(&sig.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(s.0, "linked");
        assert!(s.1.unwrap_or_default().contains("notionBacklogId"));
    }

    /// 일시 실패: draft 유지(오프라인 큐). status=draft, 외부 ID 없음.
    #[tokio::test]
    async fn promote_transient_keeps_draft_queued() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("일시 오류 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::err(NotionError::Transient("connection refused".into()));

        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Draft));
        assert_eq!(promo_status(&db, &sig.id).await, "draft", "큐에 남아야 함");
    }

    /// 영구 실패: failed로 표시.
    #[tokio::test]
    async fn promote_terminal_marks_failed() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("권한 오류 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::err(NotionError::Terminal("HTTP 401".into()));

        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Failed));
        assert_eq!(promo_status(&db, &sig.id).await, "failed");
    }

    /// 멱등(INVARIANT #3): 이미 created면 재승격이 중복 write/행 없이 기존 결과를 반환.
    #[tokio::test]
    async fn promote_is_idempotent_when_already_created() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("중복 클릭 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::ok("p1", "https://www.notion.so/p1");

        execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        let again = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(again.status, PromotionStatus::Created));
        assert_eq!(
            writer.calls.load(Ordering::Relaxed),
            1,
            "두 번째 클릭은 write를 다시 호출하지 않음"
        );
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM promotions WHERE signal_id = ?1 AND target = 'notion_backlog'",
        )
        .bind(&sig.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count.0, 1, "promotion 행은 하나");
    }

    /// 복구 flush 전이: 큐(draft)에 있던 행을 재사용해 created로 전이(같은 행).
    #[tokio::test]
    async fn queued_draft_flushes_to_created() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("큐 후보", Some(Kind::Work)))
            .await
            .unwrap();
        // 오프라인에 쌓인 draft를 모사.
        let draft = insert_promotion_draft(&db, &sig.id, PromotionTarget::NotionBacklog)
            .await
            .unwrap();
        assert!(matches!(draft.status, PromotionStatus::Draft));

        let writer = CountingWriter::ok("p9", "https://www.notion.so/p9");
        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Created));
        assert_eq!(outcome.promotion_id, draft.id, "같은 draft 행을 재사용");
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM promotions WHERE signal_id = ?1")
            .bind(&sig.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "새 행을 만들지 않음");
    }

    /// 타깃 가드: calendar/today는 Notion write 경로로 승격 불가(Err).
    #[tokio::test]
    async fn resolve_rejects_non_notion_target() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("일정 후보", None)).await.unwrap();
        assert!(
            resolve_notion_target(&db, &sig.id, PromotionTarget::Calendar, None)
                .await
                .is_err()
        );
        assert!(
            resolve_notion_target(&db, &sig.id, PromotionTarget::Today, None)
                .await
                .is_err()
        );
    }

    /// 프로젝트 미지정 신호: kind가 없고 프로젝트도 없으면 Err.
    #[tokio::test]
    async fn resolve_errors_without_project() {
        let db = fresh_db().await;
        // kind=None → kind 매칭 프로젝트 0개 → "해당 kind의 프로젝트가 없음".
        let sig = insert_signal(&db, &input("미태깅 후보", None))
            .await
            .unwrap();
        let r = resolve_notion_target(&db, &sig.id, PromotionTarget::NotionBacklog, None).await;
        assert!(r.is_err(), "프로젝트 없으면 승격 불가");
    }

    /// NULL-project 신호 + 정확히 1개 kind 매칭 프로젝트 → 자동 지정.
    /// resolved_project_id = 그 프로젝트, signal.project_id도 persist(INVARIANT #1).
    #[tokio::test]
    async fn promote_null_project_signal_auto_assigns_single_project() {
        use crate::commands::projects::insert_project;
        use crate::models::{CreateProjectInput, ProjectKind};

        let db = fresh_db().await;
        // kind=Work 프로젝트 1개 생성 (Notion DB ID + credential_ref 포함).
        let proj = insert_project(
            &db,
            &CreateProjectInput {
                name: "테스트워크".into(),
                kind: ProjectKind::Work,
                notion_backlog_db_id: Some("1234567890abcdef1234567890abcdef".into()),
                notion_agenda_db_id: None,
                ticket_key_pattern: None,
            },
        )
        .await
        .unwrap();

        // 신호: kind=Work, project_id=NULL.
        let sig = insert_signal(&db, &input("자동 지정 후보", Some(Kind::Work)))
            .await
            .unwrap();
        assert!(sig.project_id.is_none(), "신호 생성 시 project_id=NULL");

        // fake writer로 승격 실행.
        let writer = CountingWriter::ok("auto-page-1", "https://www.notion.so/auto-page-1");

        // resolve_notion_target: keychain에 토큰 없어 Err가 날 수 있으므로
        // execute_promotion 직전 단계(resolve)와 persist만 검증한다.
        // project_id 자동 persist 확인: resolve를 직접 호출.
        let resolve_result =
            resolve_notion_target(&db, &sig.id, PromotionTarget::NotionBacklog, None).await;

        // keychain 없으면 "Notion 토큰이 없음" Err → 그 직전까지 project_id가 persist됐는지 확인.
        // (테스트 환경에서 keychain이 없으므로 토큰 조회 전까지의 동작만 검증)
        // project_id가 persist됐는지는 두 경우 모두 확인 가능.
        let persisted: (Option<String>,) =
            sqlx::query_as("SELECT project_id FROM signals WHERE id = ?1")
                .bind(&sig.id)
                .fetch_one(&db)
                .await
                .unwrap();

        // resolve가 성공했든 keychain Err로 실패했든, project_id는 persist돼야 한다.
        // (project_id persist는 keychain 조회 전에 일어남)
        assert_eq!(
            persisted.0.as_deref(),
            Some(proj.id.as_str()),
            "자동 지정: signal.project_id가 matching project로 persist돼야 함"
        );

        // resolve가 keychain 없이 성공한 경우(unlikely in test), outcome도 확인.
        if let Ok((_token, _db_id, resolved_pid)) = resolve_result {
            assert_eq!(
                resolved_pid, proj.id,
                "resolved_project_id = matching project"
            );
            // execute_promotion으로 end-to-end 검증.
            let outcome = execute_promotion(
                &db,
                &sig.id,
                PromotionTarget::NotionBacklog,
                &writer,
                "tok",
                "1234567890abcdef1234567890abcdef",
            )
            .await
            .unwrap();
            assert!(matches!(outcome.status, PromotionStatus::Created));
        }
    }

    /// NULL-project 신호 + 같은 kind의 프로젝트 2개 → Err("프로젝트 선택 필요").
    #[tokio::test]
    async fn resolve_errors_with_multiple_projects() {
        use crate::commands::projects::insert_project;
        use crate::models::{CreateProjectInput, ProjectKind};

        let db = fresh_db().await;
        for name in ["워크A", "워크B"] {
            insert_project(
                &db,
                &CreateProjectInput {
                    name: name.into(),
                    kind: ProjectKind::Work,
                    notion_backlog_db_id: Some("abcdef1234567890abcdef1234567890".into()),
                    notion_agenda_db_id: None,
                    ticket_key_pattern: None,
                },
            )
            .await
            .unwrap();
        }
        let sig = insert_signal(&db, &input("다중 프로젝트 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let r = resolve_notion_target(&db, &sig.id, PromotionTarget::NotionBacklog, None).await;
        assert!(r.is_err());
        let msg = r.unwrap_err();
        assert!(
            msg.contains("프로젝트 선택 필요"),
            "다중 프로젝트 Err 메시지: {msg}"
        );
    }

    /// INVARIANT #3(동시성): 같은 카드를 동시에 두 번 승격해도 write는 1회·created 행은 1개.
    /// (게이트 없으면 둘 다 created 없음을 보고 write를 2번 호출 → 중복 Notion 페이지.)
    #[tokio::test]
    async fn concurrent_promote_writes_once() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("동시 클릭 후보", Some(Kind::Work)))
            .await
            .unwrap();
        // write 임계 구간을 넓혀 두 호출이 확실히 겹치게 한다.
        let writer = CountingWriter::slow_ok("p1", "https://www.notion.so/p1", 30);

        let (a, b) = tokio::join!(
            execute_promotion(
                &db,
                &sig.id,
                PromotionTarget::NotionBacklog,
                &writer,
                "t",
                "d"
            ),
            execute_promotion(
                &db,
                &sig.id,
                PromotionTarget::NotionBacklog,
                &writer,
                "t",
                "d"
            ),
        );
        a.unwrap();
        b.unwrap();

        assert_eq!(
            writer.calls.load(Ordering::Relaxed),
            1,
            "동시 승격이라도 외부 write는 한 번만"
        );
        let created: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM promotions WHERE signal_id = ?1 AND status = 'created'",
        )
        .bind(&sig.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(created.0, 1, "created 행은 하나");
    }

    /// 구조적 2차 방어선(0003): (signal,target)당 created는 DB가 1개로 강제한다.
    #[tokio::test]
    async fn partial_unique_index_blocks_second_created() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("유니크 후보", None))
            .await
            .unwrap();
        let first = sqlx::query(
            "INSERT INTO promotions (id, signal_id, target, status, draft_payload) \
             VALUES ('p1', ?1, 'notion_backlog', 'created', '{}')",
        )
        .bind(&sig.id)
        .execute(&db)
        .await;
        assert!(first.is_ok(), "첫 created는 성공");
        let dup = sqlx::query(
            "INSERT INTO promotions (id, signal_id, target, status, draft_payload) \
             VALUES ('p2', ?1, 'notion_backlog', 'created', '{}')",
        )
        .bind(&sig.id)
        .execute(&db)
        .await;
        assert!(
            dup.is_err(),
            "같은 (signal,target)의 두 번째 created는 partial unique index가 거부"
        );
    }

    // ── Phase 4: PR Radar (버킷/escalate/dedup/auto-resolve) ──────────────────
}
