use tauri::State;

use crate::db::Db;
use crate::git::{summarize_status, CliGitProvider, GitProvider};
use crate::models::{DiffFileSummary, DiffMode, Worktree};

// ── Worktree & Branch Diff (Phase 5, read-only) ──────────────────────────────────
// INVARIANT #6: Diff Viewer는 워킹트리/브랜치를 변경하지 않는다(git.rs는 read 서브커맨드만).
// ambient — DB 영속 없이 매 호출마다 git에서 fresh 도출(PR Radar 선례). git 접근은 Rust에.

/// worktree 도출 대상 로컬 레포 (local_path 보유 + enabled).
struct LocalRepoRef {
    repo_id: String,
    project_id: String,
    /// 표시 라벨 (remote owner/repo 또는 local_path basename).
    label: String,
    local_path: String,
    default_branch: String,
}

/// 경로 마지막 세그먼트 (local 레포 라벨 fallback).
fn path_basename(p: &str) -> String {
    p.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(p)
        .to_string()
}

/// enabled + local_path 보유 레포 로드 (project_id=None이면 전체 — 멀티 repo 동시 표시).
async fn fetch_local_repo_refs(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<LocalRepoRef>, String> {
    let rows: Vec<(String, String, Option<String>, String, String)> = if let Some(pid) = project_id
    {
        sqlx::query_as(
            "SELECT id, project_id, remote_url, local_path, default_branch FROM repos \
             WHERE enabled = 1 AND local_path IS NOT NULL AND local_path != '' AND project_id = ?1 \
             ORDER BY created_at",
        )
        .bind(pid)
        .fetch_all(db)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, project_id, remote_url, local_path, default_branch FROM repos \
             WHERE enabled = 1 AND local_path IS NOT NULL AND local_path != '' \
             ORDER BY created_at",
        )
        .fetch_all(db)
        .await
    }
    .map_err(|e| e.to_string())?;

    let mut refs = Vec::new();
    for (repo_id, pid, remote_url, local_path, default_branch) in rows {
        let label = remote_url
            .as_deref()
            .and_then(crate::github::parse_owner_repo)
            .map(|(o, r)| format!("{o}/{r}"))
            .unwrap_or_else(|| path_basename(&local_path));
        refs.push(LocalRepoRef {
            repo_id,
            project_id: pid,
            label,
            local_path,
            default_branch,
        });
    }
    Ok(refs)
}

/// worktree 도출 코어(테스트 가능 — provider를 fake로 대체). repo별 실패는 격리(그 repo만 건너뜀),
/// 전부 실패면 Err로 노출(삼키지 않음). bare 워킹트리/상태 조회 실패 worktree는 제외한다.
async fn collect_worktrees<G: GitProvider>(
    provider: &G,
    repos: &[LocalRepoRef],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<Worktree>, String> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut ok_any = false;
    let stamp = now.to_rfc3339(); // ambient — 이 도출 cycle의 단일 시각.

    for repo in repos {
        let raws = match provider.list_worktrees(&repo.local_path).await {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{}: {e}", repo.label));
                continue;
            }
        };
        ok_any = true;
        for raw in raws {
            if raw.bare {
                continue; // bare는 diff 대상 아님.
            }
            let st = match provider.status(&raw.path).await {
                Ok(s) => s,
                Err(e) => {
                    // 상태를 못 읽으면 "clean"으로 거짓 표기하지 않고 제외 + 기록.
                    errors.push(format!("{} status: {e}", raw.path));
                    continue;
                }
            };
            out.push(Worktree {
                id: format!("{}:{}", repo.repo_id, raw.path),
                repo_id: repo.repo_id.clone(),
                project_id: repo.project_id.clone(),
                repo_label: repo.label.clone(),
                path: raw.path,
                branch: raw.branch,
                head: raw.head,
                base_branch: repo.default_branch.clone(),
                is_primary: raw.is_primary,
                status: summarize_status(st),
                dirty: st.dirty,
                ahead: st.ahead,
                behind: st.behind,
                last_fetched_at: stamp.clone(),
            });
        }
    }

    if !ok_any && !repos.is_empty() {
        return Err(format!(
            "모든 레포 worktree 조회 실패 — {}",
            errors.join("; ")
        ));
    }
    Ok(out)
}

/// repo별 worktree를 상태 배지(ahead/behind/dirty)와 함께 나열한다. project_id=None이면 멀티 repo 전체.
/// ambient — 매 호출 git에서 fresh 도출(영속 없음). read-only(INVARIANT #6).
#[tauri::command]
#[specta::specta]
pub async fn list_worktrees(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<Worktree>, String> {
    let repos = fetch_local_repo_refs(db.inner(), project_id.as_deref()).await?;
    if repos.is_empty() {
        return Ok(Vec::new());
    }
    collect_worktrees(&CliGitProvider, &repos, chrono::Utc::now()).await
}

/// worktree의 로컬+원격추적 브랜치 (branch↔branch 비교 picker용).
#[tauri::command]
#[specta::specta]
pub async fn list_worktree_branches(worktree_path: String) -> Result<Vec<String>, String> {
    CliGitProvider
        .branches(&worktree_path)
        .await
        .map_err(|e| e.to_string())
}

/// 비교 모드의 파일 목록(통계만 — hunk는 지연 로드). 대용량 diff 비차단의 1단계.
#[tauri::command]
#[specta::specta]
pub async fn worktree_diff_files(
    worktree_path: String,
    mode: DiffMode,
    base_ref: Option<String>,
    head_ref: Option<String>,
) -> Result<Vec<DiffFileSummary>, String> {
    CliGitProvider
        .diff_files(
            &worktree_path,
            mode,
            base_ref.as_deref(),
            head_ref.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())
}

/// 한 파일의 unified diff 텍스트(프런트 구문강조용). 선택한 파일만 지연 로드(비차단 2단계).
#[tauri::command]
#[specta::specta]
pub async fn worktree_file_diff(
    worktree_path: String,
    mode: DiffMode,
    base_ref: Option<String>,
    head_ref: Option<String>,
    path: String,
) -> Result<String, String> {
    CliGitProvider
        .file_diff(
            &worktree_path,
            mode,
            base_ref.as_deref(),
            head_ref.as_deref(),
            &path,
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::projects::{insert_project, insert_repo};
    use crate::commands::shared::test_support::*;
    use crate::models::CreateRepoInput;
    use crate::models::{ProjectKind, Provider};

    // ── Phase 5: Worktree & Branch Diff ─────────────────────────────────────────

    use crate::git::{GitError, RawStatus, RawWorktree};

    /// fake GitProvider — repo_path별 worktree 목록 + worktree_path별 상태를 미리 심는다(실 git 없음).
    struct FakeGit {
        worktrees: std::collections::HashMap<String, Result<Vec<RawWorktree>, GitError>>,
        statuses: std::collections::HashMap<String, RawStatus>,
    }
    impl GitProvider for FakeGit {
        async fn list_worktrees(&self, repo_path: &str) -> Result<Vec<RawWorktree>, GitError> {
            self.worktrees
                .get(repo_path)
                .cloned()
                .unwrap_or_else(|| Ok(vec![]))
        }
        async fn status(&self, worktree_path: &str) -> Result<RawStatus, GitError> {
            Ok(self
                .statuses
                .get(worktree_path)
                .copied()
                .unwrap_or_default())
        }
        async fn branches(&self, _repo_path: &str) -> Result<Vec<String>, GitError> {
            Ok(vec![])
        }
        async fn diff_files(
            &self,
            _wt: &str,
            _mode: DiffMode,
            _base: Option<&str>,
            _head: Option<&str>,
        ) -> Result<Vec<DiffFileSummary>, GitError> {
            Ok(vec![])
        }
        async fn file_diff(
            &self,
            _wt: &str,
            _mode: DiffMode,
            _base: Option<&str>,
            _head: Option<&str>,
            _path: &str,
        ) -> Result<String, GitError> {
            Ok(String::new())
        }
    }

    fn raw_wt(path: &str, branch: Option<&str>, primary: bool, bare: bool) -> RawWorktree {
        RawWorktree {
            path: path.to_string(),
            branch: branch.map(|b| b.to_string()),
            head: "deadbeef".to_string(),
            is_primary: primary,
            bare,
        }
    }

    fn local_repo(repo_id: &str, project_id: &str, path: &str) -> LocalRepoRef {
        LocalRepoRef {
            repo_id: repo_id.to_string(),
            project_id: project_id.to_string(),
            label: format!("label-{repo_id}"),
            local_path: path.to_string(),
            default_branch: "dev".to_string(),
        }
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    /// 멀티 repo의 worktree가 상태 배지(ahead/behind/dirty)와 함께 도출되고 bare는 제외된다.
    #[tokio::test]
    async fn collect_worktrees_multi_repo_with_status() {
        let mut worktrees = std::collections::HashMap::new();
        worktrees.insert(
            "/repoA".to_string(),
            Ok(vec![
                raw_wt("/repoA/main", Some("dev"), true, false),
                raw_wt("/repoA/feat", Some("feature"), false, false),
                raw_wt("/repoA/bare", None, false, true), // 제외 대상
            ]),
        );
        worktrees.insert(
            "/repoB".to_string(),
            Ok(vec![raw_wt("/repoB/main", None, true, false)]), // detached
        );
        let mut statuses = std::collections::HashMap::new();
        statuses.insert(
            "/repoA/main".to_string(),
            RawStatus {
                dirty: true,
                ahead: 0,
                behind: 0,
            },
        );
        statuses.insert(
            "/repoA/feat".to_string(),
            RawStatus {
                dirty: false,
                ahead: 2,
                behind: 1,
            },
        );
        // /repoB/main 상태 미지정 → default(clean).
        let provider = FakeGit {
            worktrees,
            statuses,
        };
        let repos = vec![
            local_repo("ra", "p1", "/repoA"),
            local_repo("rb", "p2", "/repoB"),
        ];

        let wts = collect_worktrees(&provider, &repos, now()).await.unwrap();
        // bare 제외 → A 2 + B 1 = 3.
        assert_eq!(wts.len(), 3);

        let main = wts.iter().find(|w| w.path == "/repoA/main").unwrap();
        assert_eq!(main.id, "ra:/repoA/main");
        assert_eq!(main.project_id, "p1");
        assert_eq!(main.branch.as_deref(), Some("dev"));
        assert!(main.is_primary);
        assert!(main.dirty);
        assert!(matches!(main.status, crate::models::WorktreeStatus::Dirty));
        assert_eq!(main.base_branch, "dev");

        let feat = wts.iter().find(|w| w.path == "/repoA/feat").unwrap();
        assert_eq!((feat.ahead, feat.behind), (2, 1));
        assert!(matches!(
            feat.status,
            crate::models::WorktreeStatus::Diverged
        ));

        let b = wts.iter().find(|w| w.path == "/repoB/main").unwrap();
        assert_eq!(b.branch, None, "detached → branch None");
        assert!(matches!(b.status, crate::models::WorktreeStatus::Clean));
        assert!(wts.iter().all(|w| w.path != "/repoA/bare"), "bare 제외");
    }

    /// 일부 repo 실패는 그 repo만 건너뛰고 나머지는 도출(격리). 전부 실패면 Err.
    #[tokio::test]
    async fn collect_worktrees_isolates_and_surfaces_failure() {
        let mut worktrees = std::collections::HashMap::new();
        worktrees.insert(
            "/bad".to_string(),
            Err(GitError("not a git repo".to_string())),
        );
        worktrees.insert(
            "/good".to_string(),
            Ok(vec![raw_wt("/good/main", Some("dev"), true, false)]),
        );
        let provider = FakeGit {
            worktrees,
            statuses: std::collections::HashMap::new(),
        };

        // 하나 실패 + 하나 성공 → 성공분만 반환(Err 아님).
        let mixed = vec![
            local_repo("bad", "p1", "/bad"),
            local_repo("good", "p1", "/good"),
        ];
        let wts = collect_worktrees(&provider, &mixed, now()).await.unwrap();
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/good/main");

        // 전부 실패 → terminal failure 노출(삼키지 않음).
        let all_bad = vec![local_repo("bad", "p1", "/bad")];
        assert!(collect_worktrees(&provider, &all_bad, now()).await.is_err());
    }

    /// fetch_local_repo_refs: enabled + local_path 보유만, project 필터, 라벨 도출(remote→owner/repo).
    #[tokio::test]
    async fn fetch_local_repo_refs_filters_and_labels() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        // remote+local 보유 → owner/repo 라벨.
        insert_repo(
            &db,
            &CreateRepoInput {
                project_id: proj.id.clone(),
                provider: Provider::Github,
                remote_url: Some("https://github.com/64etuor/work-radar".into()),
                local_path: Some("/work/work-radar".into()),
                default_branch: Some("dev".into()),
                ticket_key_pattern: None,
            },
        )
        .await
        .unwrap();
        // local_path 없는 레포 → 제외.
        insert_repo(
            &db,
            &CreateRepoInput {
                project_id: proj.id.clone(),
                provider: Provider::Github,
                remote_url: Some("https://github.com/64etuor/other".into()),
                local_path: None,
                default_branch: None,
                ticket_key_pattern: None,
            },
        )
        .await
        .unwrap();

        let refs = fetch_local_repo_refs(&db, Some(&proj.id)).await.unwrap();
        assert_eq!(refs.len(), 1, "local_path 보유 레포만");
        assert_eq!(refs[0].label, "64etuor/work-radar");
        assert_eq!(refs[0].local_path, "/work/work-radar");

        // 다른 프로젝트로 필터하면 0건.
        let other = insert_project(&db, &project_input("개인", ProjectKind::Personal))
            .await
            .unwrap();
        assert!(fetch_local_repo_refs(&db, Some(&other.id))
            .await
            .unwrap()
            .is_empty());
        // None이면 전체(이 DB엔 1건).
        assert_eq!(fetch_local_repo_refs(&db, None).await.unwrap().len(), 1);
    }

    // ── Phase 8: PR self-check Proposal / Acceptance 게이트 ───────────────────────────
}
