//! 스킬 라이브러리 백업/복원(G1.5-PR2, ADR-0006 가역성 레일) — skills-library 트리의 버전드
//! 온디스크 스냅샷. 네트워크/토큰/잡 비취급(파일 복사 + DB 화해뿐 — #1/#2 자명하게 유지). 복원은
//! **사전 안전 스냅샷**을 먼저 떠서 그 자체로 가역. 모든 쓰기는 audit(레일 ①). 경로만 기록(비밀 금지).
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::AppError;
use crate::skills::audit_log::audit;
use crate::skills::central_repo::{
    central_skill_dir, copy_dir_shallow, list_managed_dirs, sanitize_segment,
};
use crate::skills::source::{all_skill_source_keys, delete_skill_source};

/// 백업 스냅샷 1건의 메타. specta는 i64(BigInt) export 금지 → 개수는 i32, 바이트는 f64
/// (JS number — 2^53까지 정수 정확, 스킬 텍스트 트리엔 충분). id = 스냅샷 디렉터리명(UTC 타임스탬프).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    pub id: String,
    pub created_at: String, // ISO8601 UTC (= id에서 파생, 표시용)
    pub skill_count: i32,
    pub bytes: f64,
}

/// 디렉터리 트리의 총 바이트(파일 크기 합). 부재/읽기불가 엔트리는 0으로 무시(메타용 best-effort).
fn dir_size_bytes(root: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue; // 스냅샷은 심링크를 따르지 않으므로 크기에도 넣지 않는다.
        } else if ft.is_dir() {
            total += dir_size_bytes(&entry.path());
        } else if ft.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}

/// `id`에서 ISO8601 표시 문자열 파생(폴백: id 그대로). `20260601T123045Z` → `2026-06-01T12:30:45Z`.
fn created_at_from_id(id: &str) -> String {
    let b = id.as_bytes();
    if id.len() == 16 && id.ends_with('Z') && b[8] == b'T' {
        format!(
            "{}-{}-{}T{}:{}:{}Z",
            &id[0..4],
            &id[4..6],
            &id[6..8],
            &id[9..11],
            &id[11..13],
            &id[13..15],
        )
    } else {
        id.to_string()
    }
}

/// 한 스냅샷 dir → 메타(개수 = SKILL.md 가진 dir 수, 바이트 = 트리 합).
fn meta_for_snapshot(snapshot_root: &Path, id: &str) -> BackupMeta {
    let skill_count = list_managed_dirs(snapshot_root).len() as i32;
    BackupMeta {
        id: id.to_string(),
        created_at: created_at_from_id(id),
        skill_count,
        bytes: dir_size_bytes(snapshot_root) as f64,
    }
}

/// 중앙 라이브러리 트리를 `<backups_root>/<id>/`로 복사한다. central 부재면 빈 스냅샷 dir만 만든다.
/// 심링크는 따르지 않는다(central_repo::copy_dir_shallow 계약 — 스냅샷이 트리 밖으로 새지 않음).
fn snapshot_into(central_root: &Path, backups_root: &Path, id: &str) -> Result<PathBuf, AppError> {
    let seg = sanitize_segment(id); // id는 코드 생성이지만 경로 세그먼트 안전 보장(방어적).
    let dest = backups_root.join(&seg);
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?; // 같은 초에 두 번 호출돼도 멱등.
    }
    std::fs::create_dir_all(&dest)?;
    if central_root.is_dir() {
        copy_dir_shallow(central_root, &dest)?;
    }
    Ok(dest)
}

/// core: 스냅샷 + audit. 테스트 가능(앱 핸들 비의존). `id`는 호출자(커맨드)가 UTC로 생성해 주입한다
/// (installer가 installed_commit을 주입하는 것과 동일 — 결정성/hermetic 테스트).
pub(crate) async fn backup_library_core(
    pool: &SqlitePool,
    central_root: &Path,
    backups_root: &Path,
    id: &str,
) -> Result<BackupMeta, AppError> {
    let dest = snapshot_into(central_root, backups_root, id)?;
    let meta = meta_for_snapshot(&dest, id);
    let detail = format!("skills={}", meta.skill_count); // 비밀-free: 개수만.
    audit(
        pool,
        "backup",
        "skill_library",
        &dest.to_string_lossy(),
        None,
        Some(&detail),
    )
    .await?;
    Ok(meta)
}

/// `<backups_root>` 하위 스냅샷들의 메타(최신 먼저 — id가 정렬 가능한 타임스탬프). 부재 root = 빈 vec.
pub(crate) fn list_backups_core(backups_root: &Path) -> Result<Vec<BackupMeta>, AppError> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(backups_root) else {
        return Ok(out); // 백업 디렉터리 부재 → 0건(no-op).
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            let id = entry.file_name().to_string_lossy().into_owned();
            out.push(meta_for_snapshot(&entry.path(), &id));
        }
    }
    out.sort_by(|a, b| b.id.cmp(&a.id)); // 최신(큰 타임스탬프) 먼저.
    Ok(out)
}

/// core: 가역 복원. 순서가 가역성의 핵심이다 —
/// 1) 요청 스냅샷 존재 검증(없으면 central 무변경으로 NotFound),
/// 2) **사전 안전 스냅샷**(복원 직전 central 상태)을 떠서 복원 자체를 undo 가능하게,
/// 3) central 트리를 스냅샷 내용으로 교체,
/// 4) provenance 행 화해(복원으로 사라진 managed 스킬의 고아 행 prune — 콘텐츠-without-row는 그대로),
/// 5) audit(레일 ①, 경로/개수만).
pub(crate) async fn restore_library_core(
    pool: &SqlitePool,
    central_root: &Path,
    backups_root: &Path,
    snapshot_id: &str,
    safety_id: &str,
) -> Result<(), AppError> {
    let snap_seg = sanitize_segment(snapshot_id);
    let snapshot = backups_root.join(&snap_seg);
    if !snapshot.is_dir() {
        return Err(AppError::not_found(
            "skills.restore.snapshot_missing",
            "요청한 백업 스냅샷을 찾을 수 없습니다.".to_string(),
        ));
    }

    // 2) 사전 안전 스냅샷(복원 직전 상태). 이게 있어야 복원이 그 자체로 가역.
    snapshot_into(central_root, backups_root, safety_id)?;

    // 3) central 교체: 기존 트리 제거 후 스냅샷 내용 복사.
    if central_root.exists() {
        std::fs::remove_dir_all(central_root)?;
    }
    std::fs::create_dir_all(central_root)?;
    copy_dir_shallow(&snapshot, central_root)?;

    // 4) provenance 화해: SKILL.md가 사라진 (provider,name) 행은 고아 → 삭제.
    let mut pruned = 0usize;
    for (provider, name) in all_skill_source_keys(pool).await? {
        let dir = central_skill_dir(central_root, &provider, &name);
        if !dir.join("SKILL.md").is_file() {
            delete_skill_source(pool, &provider, &name).await?;
            pruned += 1;
        }
    }

    // 5) audit. detail은 비밀-free: 스냅샷 id + 안전 스냅샷 id + prune 수.
    let detail = format!("from={snapshot_id},safety={safety_id},pruned={pruned}");
    audit(
        pool,
        "restore",
        "skill_library",
        &central_root.to_string_lossy(),
        Some(snapshot_id),
        Some(&detail),
    )
    .await?;
    Ok(())
}

/// 앱 데이터 경로 아래 중앙 라이브러리 루트(`app_data_dir/skills-library`). import/installer와 동일.
fn central_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| {
            AppError::terminal(
                "skills.app_data_dir",
                format!("앱 데이터 경로 해석 실패: {e}"),
            )
        })?
        .join("skills-library"))
}

/// 백업 루트(`app_data_dir/skills-backups`). skills-library와 형제(중첩 아님 → 백업이 자기 자신을 안 먹는다).
/// G3-PR2c push_divergence가 중앙 덮어쓰기 전 사전 스냅샷에 재사용 → pub(crate).
pub(crate) fn backups_root(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| {
            AppError::terminal(
                "skills.app_data_dir",
                format!("앱 데이터 경로 해석 실패: {e}"),
            )
        })?
        .join("skills-backups"))
}

/// 스냅샷 dir 이름용 UTC 타임스탬프 id: `YYYYMMDDThhmmssZ`(정렬 가능·fs 안전). chrono clock 사용.
/// G3-PR2c push_divergence가 사전 스냅샷 id 생성에 재사용 → pub(crate).
pub(crate) fn new_snapshot_id() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

#[tauri::command]
#[specta::specta]
pub async fn backup_skill_library(
    db: State<'_, Db>,
    app: tauri::AppHandle,
) -> Result<BackupMeta, AppError> {
    let central = central_root(&app)?;
    let backups = backups_root(&app)?;
    backup_library_core(&db, &central, &backups, &new_snapshot_id()).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_skill_backups(app: tauri::AppHandle) -> Result<Vec<BackupMeta>, AppError> {
    list_backups_core(&backups_root(&app)?)
}

#[tauri::command]
#[specta::specta]
pub async fn restore_skill_library(
    db: State<'_, Db>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), AppError> {
    let central = central_root(&app)?;
    let backups = backups_root(&app)?;
    // 안전 스냅샷 id는 복원 시각으로 새로 생성(요청 스냅샷 id와 다른 타임스탬프).
    restore_library_core(&db, &central, &backups, &id, &new_snapshot_id()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    /// tempdir에 가짜 중앙 라이브러리(`<central>/<provider>/<name>/SKILL.md`)를 만든다.
    fn make_managed(central: &Path, provider: &str, name: &str, body: &str) {
        let d = central.join(provider).join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), body).unwrap();
    }

    #[tokio::test]
    async fn backup_snapshots_tree_and_lists_meta() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let backups = tmp.path().join("skills-backups");
        make_managed(&central, "claude", "foo", "---\nname: foo\n---\nA");
        make_managed(&central, "codex", "bar", "---\nname: bar\n---\nBB");

        let meta = backup_library_core(&pool, &central, &backups, "20260601T000000Z")
            .await
            .expect("backup");
        assert_eq!(meta.id, "20260601T000000Z");
        assert_eq!(meta.skill_count, 2);
        assert!(meta.bytes > 0.0);
        // 스냅샷 디스크 존재 + 원본 트리 무손상.
        assert!(backups
            .join("20260601T000000Z/claude/foo/SKILL.md")
            .exists());
        assert!(central.join("claude/foo/SKILL.md").exists());

        // list는 메타를 돌려준다(개수 정확). backup 1건이 audit된다.
        let listed = list_backups_core(&backups).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].skill_count, 2);
        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert_eq!(log[0].action, "backup");
    }

    #[tokio::test]
    async fn backup_with_no_central_yields_empty_snapshot() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library"); // 존재하지 않음(managed 0개)
        let backups = tmp.path().join("skills-backups");
        let meta = backup_library_core(&pool, &central, &backups, "20260601T010000Z")
            .await
            .expect("backup empty");
        assert_eq!(meta.skill_count, 0);
        assert!(backups.join("20260601T010000Z").is_dir());
    }

    #[tokio::test]
    async fn restore_replaces_tree_takes_safety_snapshot_and_prunes_orphans() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let backups = tmp.path().join("skills-backups");

        // 초기 상태: foo만. provenance 행도 foo만(설치된 것으로 가정).
        make_managed(&central, "claude", "foo", "---\nname: foo\n---\nFOO");
        crate::skills::source::upsert_skill_source(
            &pool,
            crate::skills::source::NewSkillSource {
                provider: "claude",
                name: "foo",
                source_url: "github.com/o/foo",
                source_ref: None,
                subpath: None,
                installed_commit: "abc",
            },
        )
        .await
        .unwrap();
        backup_library_core(&pool, &central, &backups, "20260601T000000Z")
            .await
            .unwrap();

        // 그 뒤 foo를 지우고 bar를 추가 + bar provenance 행(스냅샷엔 없는 스킬).
        std::fs::remove_dir_all(central.join("claude/foo")).unwrap();
        make_managed(&central, "claude", "bar", "---\nname: bar\n---\nBAR");
        crate::skills::source::upsert_skill_source(
            &pool,
            crate::skills::source::NewSkillSource {
                provider: "claude",
                name: "bar",
                source_url: "github.com/o/bar",
                source_ref: None,
                subpath: None,
                installed_commit: "def",
            },
        )
        .await
        .unwrap();

        // 스냅샷(foo만)으로 복원. safety id는 주입.
        restore_library_core(
            &pool,
            &central,
            &backups,
            "20260601T000000Z",
            "20260601T020000Z",
        )
        .await
        .expect("restore");

        // foo 복귀, bar 제거(스냅샷 상태로 교체).
        assert!(central.join("claude/foo/SKILL.md").exists());
        assert!(!central.join("claude/bar").exists());
        // 사전 안전 스냅샷이 bar(복원 직전 상태)를 보존 → 복원 자체가 가역.
        assert!(backups
            .join("20260601T020000Z/claude/bar/SKILL.md")
            .exists());
        // provenance 화해: bar 행은 고아라 삭제, foo 행은 유지.
        let keys = crate::skills::source::all_skill_source_keys(&pool)
            .await
            .unwrap();
        assert_eq!(keys, vec![("claude".to_string(), "foo".to_string())]);
        // restore가 audit된다(최신 먼저).
        let log = crate::skills::audit_log::list_skill_audit_core(&pool)
            .await
            .unwrap();
        assert_eq!(log[0].action, "restore");
    }

    #[tokio::test]
    async fn restore_missing_snapshot_errors_before_touching_central() {
        let pool = fresh_db().await;
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join("skills-library");
        let backups = tmp.path().join("skills-backups");
        make_managed(&central, "claude", "foo", "---\nname: foo\n---\nFOO");

        let err = restore_library_core(
            &pool,
            &central,
            &backups,
            "does-not-exist",
            "20260601T030000Z",
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::NotFound);
        // central은 그대로(존재하지 않는 스냅샷으로 덮어쓰지 않는다).
        assert!(central.join("claude/foo/SKILL.md").exists());
    }
}
