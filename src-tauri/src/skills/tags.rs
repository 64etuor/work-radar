//! 스킬 태그(Phase 3 #12, G1-PR1 분할, 무행동변경). 통합 Skill.id 키별 태그 set/정규화.
//! 외부 스킬 태깅도 로컬 SQLite만 바꾼다(디스크 SKILL.md 무변경, #7). 로직 불변 — 그대로 이동.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use std::collections::HashSet;

/// 통합 Skill.id 키의 태그를 통째로 교체한다(set 의미). 인앱(행 id)·외부(`ext:`+경로) 모두 키잉
/// 가능하며 **외부도 태그할 수 있다 — 로컬 SQLite만 바뀌고 디스크 SKILL.md는 절대 쓰지 않는다**
/// (외부 읽기 전용 불변, #7). 태그는 trim·비어있지 않음·dedup으로 정규화하고 길이를 제한한다. 사람
/// 태깅 전용(#1 — 자동 분류 경로 없음). 빈 키는 거부한다.
#[tauri::command]
#[specta::specta]
pub async fn set_skill_tags(
    db: State<'_, Db>,
    skill_key: String,
    tags: Vec<String>,
) -> Result<(), AppError> {
    set_skill_tags_core(db.inner(), &skill_key, tags).await
}

/// 사용자 태그 라벨 최대 길이(문자 수). 과도한 라벨(붙여넣기 사고 등)을 거부하는 가드.
pub(crate) const MAX_TAG_LEN: usize = 64;

/// 태그 정규화: trim → 빈 값 제거 → 길이 가드 → dedup(입력 순서 보존). 검증 실패는 AppError.
#[allow(clippy::result_large_err)] // 단일 AppError envelope(레포 전역 규약).
fn normalize_tags(tags: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > MAX_TAG_LEN {
            return Err(AppError::validation(
                "skills.tag_too_long",
                format!("태그가 너무 깁니다(최대 {MAX_TAG_LEN}자)."),
            ));
        }
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    Ok(out)
}

/// `set_skill_tags`의 코어(State 래퍼 없이 직접 호출 — hermetic 테스트). 기존 태그를 전부 지우고
/// 정규화된 태그를 다시 넣는다(트랜잭션). 빈 태그 목록이면 그 키의 태그를 모두 제거한다.
pub(crate) async fn set_skill_tags_core(
    db: &Db,
    skill_key: &str,
    tags: Vec<String>,
) -> Result<(), AppError> {
    let key = skill_key.trim();
    if key.is_empty() {
        return Err(AppError::validation(
            "skills.tag_key_empty",
            "스킬 키가 비었습니다.",
        ));
    }
    let cleaned = normalize_tags(tags)?;
    let mut tx = db.begin().await.map_err(AppError::from)?;
    sqlx::query("DELETE FROM skill_tags WHERE skill_key = ?1")
        .bind(key)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
    for tag in &cleaned {
        sqlx::query("INSERT INTO skill_tags (skill_key, tag) VALUES (?1, ?2)")
            .bind(key)
            .bind(tag)
            .execute(&mut *tx)
            .await
            .map_err(AppError::from)?;
    }
    tx.commit().await.map_err(AppError::from)?;
    // no-PII(C7): 키/태그 본문은 로그 금지 — 개수만.
    tracing::debug!(target: "skills.tags", count = cleaned.len(), "set skill tags");
    Ok(())
}
