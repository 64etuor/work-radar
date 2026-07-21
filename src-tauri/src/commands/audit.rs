//! 연결 점검(Connection Audit). 전 프로젝트의 외부 연결을 한 번에 bounded 검증하고 중복/환경 문제를
//! 한 구조체로 집계한다(읽기 전용). INVARIANT: 외부 호출·토큰은 Rust 내부, `detail`/식별자에 토큰
//! 본문 없음; 각 ping은 단일샷(retry 0); 병렬은 상한(`AUDIT_CONCURRENCY`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;

use tauri::State;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::api;
use crate::commands::calendar::load_calendar_creds;
use crate::commands::projects::{fetch_all_repos, fetch_projects};
use crate::db::Db;
use crate::error::AppError;
use crate::github::parse_owner_repo;
use crate::keychain;
use crate::models::{
    AccountDuplicate, AuditProjectRef, ConnCheck, ConnectionAudit, DuplicateGroup,
    DuplicateWarnings, EnvWarning, Project, ProjectConnectionStatus, ProjectKind, Provider, Repo,
    TokenKind,
};
use crate::platform;

/// 동시 검증 상한 — 무상한 fan-out 금지(INVARIANT #5 정신). 각 ping은 자체 timeout·retry 0.
const AUDIT_CONCURRENCY: usize = 6;

/// gh/ntn 알려진 설치 경로(tokens.rs resolve 후보와 동치). 다중 설치 감지에만 쓴다.
const GH_PATHS: [&str; 2] = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const NTN_PATHS: [&str; 3] = [
    "/opt/homebrew/bin/ntn",
    "/usr/local/bin/ntn",
    "~/.local/bin/ntn",
];

/// 한 프로젝트에서 추출한 외부 계정 식별자(계정 중복 판정 입력). 토큰 본문 아님.
pub(crate) struct ServiceIdentities {
    project: AuditProjectRef,
    github_login: Option<String>,
    notion_bot: Option<String>,
}

// ── 커맨드 ──────────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn run_connection_audit(db: State<'_, Db>) -> Result<ConnectionAudit, AppError> {
    let pool = db.inner();
    let projects = fetch_projects(pool).await?;
    let repos = fetch_all_repos(pool).await?;

    // 상한 병렬: 프로젝트를 AUDIT_CONCURRENCY 청크로 나눠 각 청크를 동시 검증(무상한 fan-out 방지).
    // 각 태스크는 pool/Project를 owned 복제로 받아 'static을 충족하고, 인덱스로 원래 순서를 복원한다.
    // 상한 병렬: 단일 JoinSet + Semaphore(permit AUDIT_CONCURRENCY)로 동시성만 제한한다 — 청크 배리어가
    // 없어 느린 ping이 다음 묶음을 막지 않는다(무상한 fan-out도 방지). 인덱스로 원래 순서를 복원한다.
    let sem = Arc::new(Semaphore::new(AUDIT_CONCURRENCY));
    let mut set: JoinSet<(usize, ProjectConnectionStatus, ServiceIdentities)> = JoinSet::new();
    for (idx, proj) in projects.iter().cloned().enumerate() {
        let pool = pool.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let (status, idents) = audit_project(&pool, &proj).await;
            (idx, status, idents)
        });
    }
    let mut results: Vec<Option<(ProjectConnectionStatus, ServiceIdentities)>> =
        (0..projects.len()).map(|_| None).collect();
    while let Some(res) = set.join_next().await {
        // 태스크 패닉/취소(JoinError)는 best-effort로 그 프로젝트만 누락(audit_project은 패닉 경로 없음).
        if let Ok((idx, status, idents)) = res {
            results[idx] = Some((status, idents));
        }
    }

    let mut statuses = Vec::with_capacity(projects.len());
    let mut idents = Vec::with_capacity(projects.len());
    for r in results.into_iter().flatten() {
        statuses.push(r.0);
        idents.push(r.1);
    }

    let duplicates = DuplicateWarnings {
        repos: find_repo_duplicates(&repos, &projects),
        notion_dbs: find_notion_db_duplicates(&projects),
        accounts: find_account_duplicates(&idents),
    };

    let mut environment = Vec::new();
    if let Some(w) =
        multi_install_warning("gh", "cli.gh_multiple_installs", &existing_files(&GH_PATHS))
    {
        environment.push(w);
    }
    if let Some(w) = multi_install_warning(
        "ntn",
        "cli.ntn_multiple_installs",
        &existing_files(&NTN_PATHS),
    ) {
        environment.push(w);
    }

    Ok(ConnectionAudit {
        projects: statuses,
        duplicates,
        environment,
    })
}

// ── 프로젝트별 헬스체크(네트워크) ──────────────────────────────────────────────

async fn audit_project(pool: &Db, p: &Project) -> (ProjectConnectionStatus, ServiceIdentities) {
    let cref = p.credential_ref.as_str();

    let (github, github_login) = match keychain::get_token(cref, TokenKind::Github) {
        Ok(Some(tok)) => {
            let p = api::probe_github(&tok).await;
            (conn_from_probe(&p), p.identity)
        }
        Ok(None) => (ConnCheck::not_configured(), None),
        Err(e) => (ConnCheck::failed(format!("keychain: {e}")), None),
    };

    let (notion, notion_bot, notion_token) = match keychain::get_token(cref, TokenKind::Notion) {
        Ok(Some(tok)) => {
            let p = api::probe_notion(&tok).await;
            (conn_from_probe(&p), p.identity, Some(tok))
        }
        Ok(None) => (ConnCheck::not_configured(), None, None),
        Err(e) => (ConnCheck::failed(format!("keychain: {e}")), None, None),
    };

    let notion_backlog_db =
        audit_notion_db(notion_token.as_deref(), p.notion_backlog_db_id.as_deref()).await;
    let notion_agenda_db =
        audit_notion_db(notion_token.as_deref(), p.notion_agenda_db_id.as_deref()).await;

    let google_calendar = match load_calendar_creds(pool, &p.id).await {
        Ok(c) => oauth_check(c.map(|c| {
            (
                !c.client_id.is_empty() && !c.client_secret.is_empty(),
                c.has_refresh(),
            )
        })),
        Err(e) => ConnCheck::failed(format!("creds load: {e}")),
    };

    let project = AuditProjectRef {
        id: p.id.clone(),
        name: p.name.clone(),
        kind: p.kind,
    };
    (
        ProjectConnectionStatus {
            project_id: p.id.clone(),
            name: p.name.clone(),
            kind: p.kind,
            github,
            notion,
            notion_backlog_db,
            notion_agenda_db,
            google_calendar,
        },
        ServiceIdentities {
            project,
            github_login,
            notion_bot,
        },
    )
}

/// Probe 결과를 점검 화면용 ConnCheck로. Valid→Ok, Invalid/Unreachable→Failed(확인 불가 포함, detail에 사유).
fn conn_from_probe(p: &api::Probe) -> ConnCheck {
    if p.outcome == api::ProbeOutcome::Valid {
        ConnCheck::ok(p.detail.clone())
    } else {
        ConnCheck::failed(p.detail.clone())
    }
}

/// 바인딩된 Notion DB id를 검증한다. id 없으면 NotConfigured, id는 있는데 토큰이 없으면 Failed,
/// 둘 다 있으면 라이브 probe(단일샷).
async fn audit_notion_db(token: Option<&str>, db_id: Option<&str>) -> ConnCheck {
    let Some(db_id) = db_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return ConnCheck::not_configured();
    };
    let Some(token) = token else {
        return ConnCheck::failed("Notion 토큰 없음 — 먼저 토큰을 저장하세요");
    };
    match crate::notion::probe_database(token, db_id).await {
        Ok(title) => ConnCheck::ok(format!("DB: {title}")),
        Err(e) => ConnCheck::failed(e.to_string()),
    }
}

/// OAuth(Google/Gmail) 연결 상태를 (has_client, connected)에서 도출(네트워크 불필요).
fn oauth_check(creds: Option<(bool, bool)>) -> ConnCheck {
    match creds {
        Some((_, true)) => ConnCheck::ok("연결됨"),
        Some((true, false)) => ConnCheck::failed("client만 입력됨 — 미연결"),
        _ => ConnCheck::not_configured(),
    }
}

// ── 순수 분석(네트워크 불필요 — 단위 테스트) ──────────────────────────────────

fn project_lookup(projects: &[Project]) -> HashMap<String, AuditProjectRef> {
    projects
        .iter()
        .map(|p| {
            (
                p.id.clone(),
                AuditProjectRef {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    kind: p.kind,
                },
            )
        })
        .collect()
}

/// 레포의 중복 비교 identity. github=정규화 "owner/repo"(소문자), local=trim 경로. 그 외 None.
fn repo_identity(r: &Repo) -> Option<String> {
    match r.provider {
        Provider::Github => {
            let (owner, repo) = parse_owner_repo(r.remote_url.as_deref()?)?;
            Some(format!("{owner}/{repo}").to_lowercase())
        }
        Provider::Local => {
            // 후행 슬래시를 정규화해 "/a/b" 와 "/a/b/"를 같은 레포로 본다(중복 누락 방지).
            let p = r.local_path.as_deref()?.trim().trim_end_matches('/');
            (!p.is_empty()).then(|| p.to_string())
        }
    }
}

/// identity → 등장 순서 유지 distinct 프로젝트 id. 2+ 프로젝트인 것만 그룹으로.
fn dedup_groups(
    map: BTreeMap<String, Vec<String>>,
    lookup: &HashMap<String, AuditProjectRef>,
) -> Vec<DuplicateGroup> {
    map.into_iter()
        .filter_map(|(identity, pids)| {
            let projects: Vec<AuditProjectRef> = pids
                .iter()
                .filter_map(|id| lookup.get(id).cloned())
                .collect();
            (projects.len() >= 2).then_some(DuplicateGroup { identity, projects })
        })
        .collect()
}

pub(crate) fn find_repo_duplicates(repos: &[Repo], projects: &[Project]) -> Vec<DuplicateGroup> {
    let lookup = project_lookup(projects);
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in repos {
        let Some(identity) = repo_identity(r) else {
            continue;
        };
        let entry = map.entry(identity).or_default();
        if !entry.contains(&r.project_id) {
            entry.push(r.project_id.clone());
        }
    }
    dedup_groups(map, &lookup)
}

pub(crate) fn find_notion_db_duplicates(projects: &[Project]) -> Vec<DuplicateGroup> {
    let lookup = project_lookup(projects);
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for p in projects {
        // 같은 프로젝트가 backlog==agenda로 동일 id를 쓰면 그 프로젝트는 1회만 센다(자기 중복 아님).
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for id in [
            p.notion_backlog_db_id.as_deref(),
            p.notion_agenda_db_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let id = id.trim();
            if id.is_empty() || !seen.insert(id) {
                continue;
            }
            let entry = map.entry(id.to_string()).or_default();
            if !entry.contains(&p.id) {
                entry.push(p.id.clone());
            }
        }
    }
    dedup_groups(map, &lookup)
}

pub(crate) fn find_account_duplicates(idents: &[ServiceIdentities]) -> Vec<AccountDuplicate> {
    // 키는 소문자 정규화 — 대소문자 차이로 같은 계정이 분리되어 개인/업무 분리 위반을 놓치지 않도록
    // (repo_identity와 동일 정책). 표시용 identity는 최초 관측 원본을 보존한다.
    // (login 변경/표시명 우연 일치 등 더 깊은 식별 정확도는 stable id가 필요 — 알려진 한계.)
    let mut map: BTreeMap<(String, String), (String, Vec<AuditProjectRef>)> = BTreeMap::new();
    for si in idents {
        if let Some(login) = &si.github_login {
            map.entry(("github".to_string(), login.to_lowercase()))
                .or_insert_with(|| (login.clone(), Vec::new()))
                .1
                .push(si.project.clone());
        }
        if let Some(bot) = &si.notion_bot {
            map.entry(("notion".to_string(), bot.to_lowercase()))
                .or_insert_with(|| (bot.clone(), Vec::new()))
                .1
                .push(si.project.clone());
        }
    }
    map.into_iter()
        .filter(|(_, (_, ps))| ps.len() >= 2)
        .map(|((service, _), (identity, projects))| {
            // 개인/업무 분리 핵심: 한 계정이 개인·업무 프로젝트에 모두 걸치면 강조 경고.
            let cross_kind = projects.iter().any(|p| p.kind == ProjectKind::Personal)
                && projects.iter().any(|p| p.kind == ProjectKind::Work);
            AccountDuplicate {
                service,
                identity,
                projects,
                cross_kind,
            }
        })
        .collect()
}

/// 같은 CLI가 2곳 이상 존재하면 우선순위 모호 경고.
pub(crate) fn multi_install_warning(
    label: &str,
    code: &str,
    existing_paths: &[String],
) -> Option<EnvWarning> {
    (existing_paths.len() >= 2).then(|| EnvWarning {
        code: code.to_string(),
        message: format!(
            "{label} CLI가 여러 경로에 설치되어 우선순위가 모호합니다: {}",
            existing_paths.join(", ")
        ),
    })
}

fn expand_home(p: &str) -> String {
    platform::expand_home(Path::new(p), platform::home_dir().as_deref())
        .to_string_lossy()
        .into_owned()
}

fn existing_files(candidates: &[&str]) -> Vec<String> {
    candidates
        .iter()
        .map(|c| expand_home(c))
        .filter(|p| Path::new(p).is_file())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(
        id: &str,
        name: &str,
        kind: ProjectKind,
        backlog: Option<&str>,
        agenda: Option<&str>,
    ) -> Project {
        Project {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            notion_backlog_db_id: backlog.map(str::to_string),
            notion_agenda_db_id: agenda.map(str::to_string),
            google_calendar_ids: None,
            calendar_color: None,
            default_write_calendar_id: None,
            credential_ref: format!("cref-{id}"),
            created_at: "2026-06-07T00:00:00Z".to_string(),
            updated_at: "2026-06-07T00:00:00Z".to_string(),
        }
    }

    fn gh_repo(project_id: &str, url: &str) -> Repo {
        Repo {
            id: format!("repo-{project_id}-{url}"),
            project_id: project_id.to_string(),
            provider: Provider::Github,
            remote_url: Some(url.to_string()),
            local_path: None,
            default_branch: "main".to_string(),
            enabled: true,
            created_at: "2026-06-07T00:00:00Z".to_string(),
        }
    }

    fn local_repo(project_id: &str, path: &str) -> Repo {
        Repo {
            id: format!("repo-{project_id}-local"),
            project_id: project_id.to_string(),
            provider: Provider::Local,
            remote_url: None,
            local_path: Some(path.to_string()),
            default_branch: "main".to_string(),
            enabled: true,
            created_at: "2026-06-07T00:00:00Z".to_string(),
        }
    }

    fn pref(id: &str, name: &str, kind: ProjectKind) -> AuditProjectRef {
        AuditProjectRef {
            id: id.to_string(),
            name: name.to_string(),
            kind,
        }
    }

    #[test]
    fn repo_duplicates_match_normalized_owner_repo_across_projects() {
        let projects = vec![
            project("p1", "개인", ProjectKind::Personal, None, None),
            project("p2", "업무", ProjectKind::Work, None, None),
        ];
        let repos = vec![
            // 같은 레포(URL 형식·대소문자 차이) → 정규화 후 동일 identity.
            gh_repo("p1", "https://github.com/Acme/Repo"),
            gh_repo("p2", "acme/repo"),
            // 한 프로젝트에만 있는 레포는 중복 아님.
            gh_repo("p1", "https://github.com/solo/only"),
        ];
        let groups = find_repo_duplicates(&repos, &projects);
        assert_eq!(groups.len(), 1, "한 그룹(acme/repo)만 중복");
        assert_eq!(groups[0].identity, "acme/repo");
        assert_eq!(groups[0].projects.len(), 2);
    }

    #[test]
    fn repo_duplicates_normalize_local_trailing_slash() {
        let projects = vec![
            project("p1", "개인", ProjectKind::Personal, None, None),
            project("p2", "업무", ProjectKind::Work, None, None),
        ];
        // 같은 로컬 경로(후행 슬래시 차이) → 정규화 후 동일 identity로 중복 검출.
        let repos = vec![
            local_repo("p1", "/home/me/proj"),
            local_repo("p2", "/home/me/proj/"),
        ];
        let groups = find_repo_duplicates(&repos, &projects);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].identity, "/home/me/proj");
        assert_eq!(groups[0].projects.len(), 2);
    }

    #[test]
    fn notion_db_duplicates_dedupe_within_project() {
        let projects = vec![
            // 같은 프로젝트가 backlog==agenda 동일 id → 자기 중복은 그룹 아님.
            project(
                "p1",
                "개인",
                ProjectKind::Personal,
                Some("dbA"),
                Some("dbA"),
            ),
            project("p2", "업무", ProjectKind::Work, Some("dbA"), None),
            project("p3", "기타", ProjectKind::Work, Some("dbB"), None),
        ];
        let groups = find_notion_db_duplicates(&projects);
        assert_eq!(groups.len(), 1, "dbA만 2개 프로젝트 중복");
        assert_eq!(groups[0].identity, "dbA");
        assert_eq!(groups[0].projects.len(), 2);
    }

    #[test]
    fn account_duplicates_flag_cross_kind() {
        let idents = vec![
            ServiceIdentities {
                project: pref("p1", "개인", ProjectKind::Personal),
                github_login: Some("octocat".into()),
                notion_bot: None,
            },
            ServiceIdentities {
                project: pref("p2", "업무", ProjectKind::Work),
                github_login: Some("octocat".into()),
                notion_bot: None,
            },
            ServiceIdentities {
                project: pref("p3", "업무2", ProjectKind::Work),
                github_login: Some("workbot".into()),
                notion_bot: None,
            },
            ServiceIdentities {
                project: pref("p4", "업무3", ProjectKind::Work),
                github_login: Some("workbot".into()),
                notion_bot: None,
            },
        ];
        let mut dups = find_account_duplicates(&idents);
        dups.sort_by(|a, b| a.identity.cmp(&b.identity));
        assert_eq!(dups.len(), 2);
        // octocat: 개인+업무 → cross_kind 강조.
        let octocat = dups.iter().find(|d| d.identity == "octocat").unwrap();
        assert!(octocat.cross_kind, "개인+업무 걸침");
        // workbot: 업무+업무 → 동종, cross_kind 아님(정보성).
        let workbot = dups.iter().find(|d| d.identity == "workbot").unwrap();
        assert!(!workbot.cross_kind);
    }

    #[test]
    fn account_duplicates_ignore_singletons() {
        let idents = vec![ServiceIdentities {
            project: pref("p1", "개인", ProjectKind::Personal),
            github_login: Some("solo".into()),
            notion_bot: None,
        }];
        assert!(find_account_duplicates(&idents).is_empty());
    }

    #[test]
    fn multi_install_warning_only_when_two_or_more() {
        assert!(multi_install_warning("gh", "cli.gh_multiple_installs", &[]).is_none());
        assert!(multi_install_warning(
            "gh",
            "cli.gh_multiple_installs",
            &["/opt/homebrew/bin/gh".to_string()]
        )
        .is_none());
        let w = multi_install_warning(
            "gh",
            "cli.gh_multiple_installs",
            &[
                "/opt/homebrew/bin/gh".to_string(),
                "/usr/local/bin/gh".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(w.code, "cli.gh_multiple_installs");
        assert!(w.message.contains("/usr/local/bin/gh"));
    }
}
