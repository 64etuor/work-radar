//! Git worktree & branch diff (read-only, Phase 5). INVARIANT #6: Diff Viewer는 워킹트리/브랜치를
//! 절대 변경하지 않는다 — read 서브커맨드(worktree list / status / for-each-ref / diff / rev-list)만
//! 호출하고 checkout/reset/commit 등 mutating 커맨드는 쓰지 않는다.
//!
//! 핵심 규칙:
//!  - git 접근은 Rust에(렌더러 아님). 셸아웃은 `git` CLI(architecture §8 "git2 우선"을 read-only
//!    diff 뷰어 한정으로 의도적으로 벗어남 — decisions.md Phase 5).
//!  - bounded(INVARIANT #5 해석): 로컬 git은 결정적이라 재시도 무의미 → 각 호출을 `timeout`(20s)으로
//!    bound하고 실패는 terminal로 노출(무한 루프 없음). github.rs의 원격 retry와 달리 모듈 분리.
//!  - 테스트 가능 seam: 코어(commands.rs)는 `GitProvider` 트레잇에만 의존. 단위 테스트는 fake provider +
//!    순수 파싱 함수로 검증(실 git 셸아웃 없음 — git이 테스트 PATH에 없을 수 있음).

use std::time::Duration;

use tokio::process::Command;

use crate::models::{DiffFileSummary, DiffMode, FileChange, WorktreeStatus};

/// 한 git 서브프로세스 호출 상한 (INVARIANT #5: 무한 대기 금지).
const CMD_TIMEOUT: Duration = Duration::from_secs(20);

/// git 접근 실패. 로컬·결정적이라 재시도 구분 없이 terminal로 노출한다(삼키지 않음).
#[derive(Debug, Clone)]
pub struct GitError(pub String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for GitError {}

/// `git worktree list --porcelain`이 주는 raw worktree (status는 별도 호출로 채운다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawWorktree {
    pub path: String,
    /// 브랜치 (detached면 None).
    pub branch: Option<String>,
    pub head: String,
    pub is_primary: bool,
    /// bare 워킹트리 (diff 대상 아님 — 코어가 거른다).
    pub bare: bool,
}

/// `git status --porcelain=v2 --branch`에서 도출한 동기화/더티 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RawStatus {
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
}

/// 코어가 의존하는 유일한 git read 계약. 테스트는 fake로 대체한다.
/// (RPITIT — async fn in trait. async_trait 의존성 없이 제네릭으로만 소비, PrProvider 패턴.)
pub trait GitProvider {
    /// repo의 모든 worktree 나열 (primary 포함).
    fn list_worktrees(
        &self,
        repo_path: &str,
    ) -> impl std::future::Future<Output = Result<Vec<RawWorktree>, GitError>> + Send;

    /// 한 worktree의 더티/ahead/behind 상태.
    fn status(
        &self,
        worktree_path: &str,
    ) -> impl std::future::Future<Output = Result<RawStatus, GitError>> + Send;

    /// 로컬 + 원격추적 브랜치 (branch↔branch 비교 picker용).
    fn branches(
        &self,
        repo_path: &str,
    ) -> impl std::future::Future<Output = Result<Vec<String>, GitError>> + Send;

    /// 비교 모드의 파일 목록(통계). 파일별 hunk는 `file_diff`로 지연 로드.
    fn diff_files(
        &self,
        worktree_path: &str,
        mode: DiffMode,
        base: Option<&str>,
        head: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Vec<DiffFileSummary>, GitError>> + Send;

    /// 한 파일의 unified diff 텍스트(프런트 구문강조용 raw).
    fn file_diff(
        &self,
        worktree_path: &str,
        mode: DiffMode,
        base: Option<&str>,
        head: Option<&str>,
        path: &str,
    ) -> impl std::future::Future<Output = Result<String, GitError>> + Send;
}

// ── 순수 헬퍼 (git 비의존, 단위 테스트 대상) ────────────────────────────────────

/// 더티/ahead/behind → 상태 요약. 우선순위: Diverged > Dirty > Ahead > Behind > Clean.
pub(crate) fn summarize_status(s: RawStatus) -> WorktreeStatus {
    if s.ahead > 0 && s.behind > 0 {
        WorktreeStatus::Diverged
    } else if s.dirty {
        WorktreeStatus::Dirty
    } else if s.ahead > 0 {
        WorktreeStatus::Ahead
    } else if s.behind > 0 {
        WorktreeStatus::Behind
    } else {
        WorktreeStatus::Clean
    }
}

/// diff 모드 → `git diff` 범위 인자. ref는 `-`로 시작 못함(arg injection 가드).
/// vs_base: 3-dot(merge-base), head 기본 HEAD. branch↔branch: 두 ref 직접 비교.
pub(crate) fn diff_range_args(
    mode: DiffMode,
    base: Option<&str>,
    head: Option<&str>,
) -> Result<Vec<String>, GitError> {
    let safe = |r: &str| -> Result<String, GitError> {
        let r = r.trim();
        if r.is_empty() || r.starts_with('-') {
            return Err(GitError(format!("잘못된 ref: {r:?}")));
        }
        Ok(r.to_string())
    };
    match mode {
        DiffMode::Working => Ok(vec![]),
        DiffMode::Staged => Ok(vec!["--cached".to_string()]),
        DiffMode::VsBase => {
            let base = safe(base.ok_or_else(|| GitError("vs_base는 base ref가 필요".into()))?)?;
            let head = match head {
                Some(h) => safe(h)?,
                None => "HEAD".to_string(),
            };
            Ok(vec![format!("{base}...{head}")])
        }
        DiffMode::BranchBranch => {
            let base =
                safe(base.ok_or_else(|| GitError("branch↔branch는 base ref가 필요".into()))?)?;
            let head =
                safe(head.ok_or_else(|| GitError("branch↔branch는 head ref가 필요".into()))?)?;
            Ok(vec![base, head])
        }
    }
}

/// `git worktree list --porcelain` 파싱. 빈 줄로 분리된 블록, 첫 블록 = primary.
pub(crate) fn parse_worktree_list(out: &str) -> Vec<RawWorktree> {
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Option<String> = None;
    let mut bare = false;
    let mut first = true;

    let mut flush = |path: &mut Option<String>,
                     head: &mut String,
                     branch: &mut Option<String>,
                     bare: &mut bool,
                     first: &mut bool| {
        if let Some(p) = path.take() {
            result.push(RawWorktree {
                path: p,
                branch: branch.take(),
                head: std::mem::take(head),
                is_primary: *first,
                bare: *bare,
            });
            *first = false;
            *bare = false;
        }
    };

    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut path, &mut head, &mut branch, &mut bare, &mut first);
            continue;
        }
        if let Some(p) = line.strip_prefix("worktree ") {
            // 새 블록 시작 — 누적분 flush 후 시작.
            flush(&mut path, &mut head, &mut branch, &mut bare, &mut first);
            path = Some(p.to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            // refs/heads/foo → foo
            branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" {
            bare = true;
        }
        // "detached", "locked", "prunable" 등은 branch=None 유지 / 무시.
    }
    flush(&mut path, &mut head, &mut branch, &mut bare, &mut first);
    result
}

/// `git worktree list --porcelain`에서 "prunable" 표시된 worktree 경로만 추출(Phase 12d).
/// 한 블록은 `worktree <path>` ... `prunable <reason>` 라인을 가질 수 있다.
pub(crate) fn parse_prunable_worktrees(out: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut prunable = false;
    let flush = |path: &mut Option<String>, prunable: &mut bool, result: &mut Vec<String>| {
        if let Some(p) = path.take() {
            if *prunable {
                result.push(p);
            }
        }
        *prunable = false;
    };
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut path, &mut prunable, &mut result);
        } else if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut prunable, &mut result);
            path = Some(p.to_string());
        } else if line == "prunable" || line.starts_with("prunable ") {
            prunable = true;
        }
    }
    flush(&mut path, &mut prunable, &mut result);
    result
}

/// `git status --porcelain=v2 --branch` 파싱 → 더티/ahead/behind.
/// 더티 = '#' 외 라인(추적 변경 1/2/u, untracked ?) 존재. ahead/behind = `# branch.ab +A -B`.
pub(crate) fn parse_status_v2(out: &str) -> RawStatus {
    let mut s = RawStatus::default();
    for line in out.lines() {
        if let Some(ab) = line.strip_prefix("# branch.ab ") {
            // "+2 -1"
            for tok in ab.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            // 1/2(추적 변경), u(unmerged), ?(untracked), !(ignored — porcelain 기본 미출력)
            s.dirty = true;
        }
    }
    s
}

/// `--numstat` (라인 기반) 파싱 → (adds, dels, binary, path). binary는 '-' 필드.
/// rename은 numstat이 `adds\tdels\told => new` 또는 `{a => b}/c` 형태 → new 경로 추출.
pub(crate) fn parse_numstat(out: &str) -> Vec<(u32, u32, bool, String)> {
    let mut rows = Vec::new();
    for line in out.lines() {
        let mut it = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let binary = a == "-" || d == "-";
        let adds = a.parse().unwrap_or(0);
        let dels = d.parse().unwrap_or(0);
        rows.push((adds, dels, binary, numstat_new_path(p)));
    }
    rows
}

/// numstat 경로 필드에서 (rename이면) new 경로를 뽑는다. `old => new` / `pre/{a => b}/post`.
fn numstat_new_path(field: &str) -> String {
    let field = field.trim();
    if let Some((pre, rest)) = field.split_once('{') {
        // pre{a => b}post → pre + b + post
        if let Some((mid, post)) = rest.split_once('}') {
            let new_mid = mid.split("=>").nth(1).unwrap_or(mid).trim();
            return format!("{}{}{}", pre, new_mid, post);
        }
    }
    if let Some((_, new)) = field.split_once("=>") {
        return new.trim().to_string();
    }
    field.to_string()
}

/// `--name-status` 파싱 → (status_char, new_path, old_path?). rename `R###\told\tnew` →
/// ('R', new, Some(old)). 비-rename `M\tpath` → ('M', path, None).
pub(crate) fn parse_name_status(out: &str) -> Vec<(char, String, Option<String>)> {
    let mut rows = Vec::new();
    for line in out.lines() {
        let mut it = line.split('\t');
        let Some(code) = it.next() else { continue };
        let Some(first) = it.next() else { continue };
        let ch = code.chars().next().unwrap_or('M');
        // rename/copy(R/C)는 first=old, 다음=new. 그 외는 first가 곧 경로.
        match it.next() {
            Some(new) => rows.push((ch, new.to_string(), Some(first.to_string()))),
            None => rows.push((ch, first.to_string(), None)),
        }
    }
    rows
}

/// status_char → FileChange. C(copy)는 A로, 알 수 없는 건 M로 매핑.
fn file_change_of(ch: char) -> FileChange {
    match ch {
        'A' | 'C' => FileChange::Added,
        'D' => FileChange::Deleted,
        'R' => FileChange::Renamed,
        _ => FileChange::Modified,
    }
}

/// numstat + name-status 머지 → DiffFileSummary 목록. new 경로 기준 조인,
/// numstat에 없는(예: 순수 rename) 항목도 name-status로 보강한다.
pub(crate) fn merge_diff_summary(
    numstat: Vec<(u32, u32, bool, String)>,
    name_status: Vec<(char, String, Option<String>)>,
) -> Vec<DiffFileSummary> {
    use std::collections::HashMap;
    let mut stat: HashMap<String, (u32, u32, bool)> = HashMap::new();
    for (a, d, b, p) in numstat {
        stat.insert(p, (a, d, b));
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (ch, path, old_path) in name_status {
        let (adds, dels, binary) = stat.get(&path).copied().unwrap_or((0, 0, false));
        seen.insert(path.clone());
        out.push(DiffFileSummary {
            path,
            status: file_change_of(ch),
            adds,
            dels,
            old_path,
            binary,
        });
    }
    // name-status가 비었지만 numstat만 있는 경우(이론상 드묾)도 흘리지 않는다.
    for (p, (adds, dels, binary)) in stat {
        if !seen.contains(&p) {
            out.push(DiffFileSummary {
                path: p,
                status: FileChange::Modified,
                adds,
                dels,
                old_path: None,
                binary,
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// 브랜치 목록 파싱 (`for-each-ref --format=%(refname:short)`). `*/HEAD`(예: origin/HEAD) 제외.
pub(crate) fn parse_branches(out: &str) -> Vec<String> {
    out.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .map(|l| l.to_string())
        .collect()
}

/// `for-each-ref` `%(refname:short)\t%(committerdate:iso-strict)` 파싱 → 브랜치명 → 커밋 시각.
/// 파싱 불가 날짜 행은 건너뛴다(stale 판정에서 그 브랜치는 stale=false로 보수적 처리).
pub(crate) fn parse_branch_dates(
    out: &str,
) -> std::collections::HashMap<String, chrono::DateTime<chrono::Utc>> {
    let mut map = std::collections::HashMap::new();
    for line in out.lines() {
        let Some((name, date)) = line.split_once('\t') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(date.trim()) {
            map.insert(name.to_string(), dt.with_timezone(&chrono::Utc));
        }
    }
    map
}

// ── 12c: 활성 변경 활동 (파일 mtime 윈도) ────────────────────────────────────────

/// "지금 작업 중"으로 볼 최근 변경 윈도 (이 안에 변경된 파일이 있으면 active_change=true).
pub(crate) const ACTIVE_CHANGE_WINDOW: chrono::Duration = chrono::Duration::minutes(5);

/// mtime 스캔 시 건너뛸 디렉터리명(빌드 산출물/메타라 "작업 활동"이 아님).
const SKIP_DIRS: &[&str] = &[".git", "target", "node_modules", "dist", ".next"];

/// worktree 디렉터리 트리에서 가장 최근 파일 mtime을 찾는다(SKIP_DIRS 제외, 깊이 상한).
/// 비-git·순수 fs 조회라 GitProvider 밖. 에러(권한/미존재)는 None으로 degrade(표시는 부가정보).
pub(crate) fn newest_mtime_under(root: &std::path::Path) -> Option<std::time::SystemTime> {
    /// 무한/과도 walk 방지(INVARIANT #5 정신) — worktree 표층만 본다.
    const MAX_DEPTH: usize = 8;
    fn walk(dir: &std::path::Path, depth: usize, best: &mut Option<std::time::SystemTime>) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                walk(&entry.path(), depth + 1, best);
            } else if ft.is_file() {
                if let Ok(mt) = entry.metadata().and_then(|m| m.modified()) {
                    if best.is_none_or(|b| mt > b) {
                        *best = Some(mt);
                    }
                }
            }
        }
    }
    let mut best = None;
    walk(root, 0, &mut best);
    best
}

/// 최근 변경 윈도 안에서 변경됐는지(active_change). newest 없으면 false.
pub(crate) fn is_active_change(
    newest: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    match newest {
        Some(t) => now.signed_duration_since(t) <= ACTIVE_CHANGE_WINDOW && t <= now,
        None => false,
    }
}

// ── 12c: 안전 rebase 가드 (순수 로직, 단위 테스트 대상) ────────────────────────────

/// rebase 기준 ref 검증 (arg injection 가드 — `-`로 시작 못함, 비어있지 못함).
pub(crate) fn validate_base_ref(base: &str) -> Result<String, GitError> {
    let b = base.trim();
    if b.is_empty() || b.starts_with('-') {
        return Err(GitError(format!("잘못된 base ref: {b:?}")));
    }
    Ok(b.to_string())
}

/// 백업 ref 이름 생성: `refs/wr-backup/<branch>-<ts>`. branch 없으면(detached) "detached".
/// ts는 호출자가 주입(테스트 결정성). branch의 '/'는 '-'로 치환(중첩 ref 충돌 방지).
pub(crate) fn backup_ref_name(branch: Option<&str>, ts: &str) -> String {
    let b = branch.unwrap_or("detached").replace('/', "-");
    format!("refs/wr-backup/{b}-{ts}")
}

// ── 12d: 정리 후보 분류 가드 (순수 로직, 단위 테스트 대상) ──────────────────────────

/// 한 로컬 브랜치의 정리 분류 입력 (실 git 조회 결과를 순수 함수로 넘긴다 — 테스트 가능).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchCleanupInput {
    pub name: String,
    /// base(예: dev)에 머지됐는지(`git branch --merged`).
    pub merged: bool,
    /// 현재 체크아웃된(또는 다른 worktree가 점유한) 브랜치 = 보호.
    pub checked_out: bool,
    /// stale 판정(마지막 커밋이 오래됨). merged가 아니어도 후보로 노출.
    pub stale: bool,
    /// base 브랜치 자신(예: dev/main) = 보호.
    pub is_base: bool,
}

/// 브랜치 입력 → 정리 후보(보호/force 분류). 머지됨 + 비보호 = 안전 삭제. 미머지 = needs_force.
/// current/base는 protected. merged도 stale도 아니면 후보 아님(None).
pub(crate) fn classify_branch(
    input: &BranchCleanupInput,
) -> Option<crate::models::CleanupCandidate> {
    use crate::models::{CleanupCandidate, CleanupKind};
    if !input.merged && !input.stale {
        return None; // 머지되지도 stale도 아니면 정리 대상 아님.
    }
    let protected = input.checked_out || input.is_base;
    let (kind, needs_force, detail) = if input.merged {
        (
            CleanupKind::MergedBranch,
            false,
            if input.is_base {
                "기준 브랜치 — 보호됨".to_string()
            } else if input.checked_out {
                "현재 체크아웃됨 — 보호됨".to_string()
            } else {
                "기준 브랜치에 머지됨".to_string()
            },
        )
    } else {
        (
            CleanupKind::StaleBranch,
            true, // 미머지 → force 필요.
            if input.checked_out {
                "현재 체크아웃됨 — 보호됨".to_string()
            } else {
                "오래된 미머지 브랜치 — 강제 삭제 필요".to_string()
            },
        )
    };
    Some(CleanupCandidate {
        id: format!("branch:{}", input.name),
        kind,
        name: input.name.clone(),
        detail,
        protected,
        needs_force,
    })
}

/// 정리 액션의 보호 가드: protected는 절대 삭제 불가, needs_force는 force일 때만 허용.
/// Ok면 삭제 진행, Err면 거부 사유. 코어가 삭제 직전 마지막 방어선으로 호출(UI 우회 방지).
pub(crate) fn guard_delete(
    protected: bool,
    needs_force: bool,
    force: bool,
) -> Result<(), GitError> {
    if protected {
        return Err(GitError("보호된 항목은 삭제할 수 없습니다.".into()));
    }
    if needs_force && !force {
        return Err(GitError(
            "미머지/dirty 항목은 강제(force) 옵션이 필요합니다.".into(),
        ));
    }
    Ok(())
}

// ── 실제 git CLI provider ───────────────────────────────────────────────────────

/// `git` 셸아웃 provider. read-only 서브커맨드만 호출한다(INVARIANT #6).
pub struct CliGitProvider;

impl CliGitProvider {
    /// `git -C <dir> <args...>` 실행 (timeout-bounded). 비0 종료/타임아웃/미설치는 GitError.
    /// `-c color.ui=false`로 사용자 config(`color.ui=always`)가 ANSI 코드를 diff에 섞지 않게 한다.
    async fn run(dir: &str, args: &[&str]) -> Result<String, GitError> {
        let fut = Command::new("git")
            .arg("-c")
            .arg("color.ui=false")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output();
        let out = tokio::time::timeout(CMD_TIMEOUT, fut)
            .await
            .map_err(|_| GitError(format!("git 타임아웃: git {}", args.join(" "))))?
            .map_err(|e| GitError(format!("git 실행 실패(설치/PATH 확인): {e}")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(GitError(format!(
                "git {}: {}",
                args.join(" "),
                stderr.trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    // ── 12c/12d: mutating 오퍼레이션 (사용자의 자기 worktree 대상, 명시 버튼 = 사람 액션) ──
    // INVARIANT #6은 *에이전트 코드 격리*를 다룬다 — 이 메서드들은 사용자가 버튼으로 직접
    // 호출하는 자기 트리 운영이라 별개. read-only인 GitProvider 트레잇 밖(인헌트 impl)에 두어
    // Diff Viewer의 read-only 계약을 깨지 않는다. 각 호출은 run()의 timeout으로 bound된다(#5).

    /// 현재 브랜치명(detached면 None). `git rev-parse --abbrev-ref HEAD` → "HEAD"는 detached.
    async fn current_branch(dir: &str) -> Result<Option<String>, GitError> {
        let out = Self::run(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        let b = out.trim();
        Ok(if b == "HEAD" || b.is_empty() {
            None
        } else {
            Some(b.to_string())
        })
    }

    /// 안전 dev rebase (Phase 12c). fetch → dirty 거부 → 백업 ref → rebase → 충돌 시 abort+복구.
    /// 성공/충돌 둘 다 RebaseResult로 terminal 노출(무한 retry 없음 — bounded, 한 번만 시도).
    pub async fn rebase_onto(
        worktree_path: &str,
        base: &str,
        ts: &str,
    ) -> Result<crate::models::RebaseResult, GitError> {
        use crate::models::RebaseResult;
        let base = validate_base_ref(base)?;

        // 1) fetch — 원격 최신을 가져온다(원격 미설정이면 fetch 실패는 무시하고 로컬 base로 진행).
        let _ = Self::run(worktree_path, &["fetch", "--all", "--prune"]).await;

        // 2) dirty면 거부 (rebase가 미커밋 변경을 위험에 빠뜨림).
        let st = parse_status_v2(
            &Self::run(worktree_path, &["status", "--porcelain=v2", "--branch"]).await?,
        );
        if st.dirty {
            return Err(GitError(
                "미커밋 변경(dirty)이 있어 rebase를 거부합니다 — 커밋/스태시 후 다시 시도하세요."
                    .into(),
            ));
        }

        // 3) 백업 ref 생성 (충돌 복구용). 현재 브랜치명으로 이름 짓는다.
        let branch = Self::current_branch(worktree_path).await?;
        let backup = backup_ref_name(branch.as_deref(), ts);
        Self::run(worktree_path, &["update-ref", &backup, "HEAD"]).await?;

        // 4) rebase 한 번 시도.
        match Self::run(worktree_path, &["rebase", &base]).await {
            Ok(out) => {
                let summary = out.trim();
                let message = if summary.is_empty() {
                    format!("rebase 성공 — 백업 ref: {backup}")
                } else {
                    format!("{summary}\n백업 ref: {backup}")
                };
                Ok(RebaseResult {
                    success: true,
                    base,
                    backup_ref: Some(backup),
                    message,
                })
            }
            Err(rebase_err) => {
                // 5) 충돌 → abort + 백업으로 hard reset 복구. 복구 자체 실패도 노출.
                let _ = Self::run(worktree_path, &["rebase", "--abort"]).await;
                let restore = Self::run(worktree_path, &["reset", "--hard", &backup]).await;
                let restore_note = match restore {
                    Ok(_) => "원래 상태로 복구됨".to_string(),
                    Err(e) => format!("⚠️ 복구 실패(수동 확인 필요): {e} — 백업 ref: {backup}"),
                };
                let message = format!("rebase 충돌로 중단됨 — {restore_note}\n사유: {rebase_err}");
                Ok(RebaseResult {
                    success: false,
                    base,
                    backup_ref: Some(backup),
                    message,
                })
            }
        }
    }

    /// 로컬 브랜치 삭제 (force면 `-D`, 아니면 `-d` = 미머지 거부). guard_delete 통과 후에만 호출.
    pub async fn delete_branch(repo_path: &str, branch: &str, force: bool) -> Result<(), GitError> {
        let flag = if force { "-D" } else { "-d" };
        Self::run(repo_path, &["branch", flag, branch]).await?;
        Ok(())
    }

    /// prunable worktree 등록 정리 (`git worktree prune`). 디스크에서 사라진 worktree 메타 제거.
    pub async fn prune_worktrees(repo_path: &str) -> Result<(), GitError> {
        Self::run(repo_path, &["worktree", "prune"]).await?;
        Ok(())
    }

    /// 로컬 브랜치명만 (`refs/heads` short). 정리 후보의 전체 모집단.
    pub async fn local_branches(repo_path: &str) -> Result<Vec<String>, GitError> {
        let out = Self::run(
            repo_path,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )
        .await?;
        Ok(parse_branches(&out))
    }

    /// base에 머지된 로컬 브랜치 set. 코어가 classify_branch에 넘긴다(순수 분류는 테스트 가능).
    pub async fn merged_branches(repo_path: &str, base: &str) -> Result<Vec<String>, GitError> {
        let base = validate_base_ref(base)?;
        let out = Self::run(
            repo_path,
            &["branch", "--merged", &base, "--format=%(refname:short)"],
        )
        .await?;
        Ok(parse_branches(&out))
    }

    /// 로컬 브랜치별 마지막 커밋 시각(stale 판정용). `for-each-ref ... %(committerdate:iso-strict)`.
    pub async fn branch_commit_dates(
        repo_path: &str,
    ) -> Result<std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>, GitError> {
        let out = Self::run(
            repo_path,
            &[
                "for-each-ref",
                "--format=%(refname:short)\t%(committerdate:iso-strict)",
                "refs/heads",
            ],
        )
        .await?;
        Ok(parse_branch_dates(&out))
    }

    /// prunable worktree 경로 목록 (`git worktree list --porcelain`의 "prunable" 표시).
    pub async fn prunable_worktrees(repo_path: &str) -> Result<Vec<String>, GitError> {
        let out = Self::run(repo_path, &["worktree", "list", "--porcelain"]).await?;
        Ok(parse_prunable_worktrees(&out))
    }
}

impl GitProvider for CliGitProvider {
    async fn list_worktrees(&self, repo_path: &str) -> Result<Vec<RawWorktree>, GitError> {
        let out = Self::run(repo_path, &["worktree", "list", "--porcelain"]).await?;
        Ok(parse_worktree_list(&out))
    }

    async fn status(&self, worktree_path: &str) -> Result<RawStatus, GitError> {
        let out = Self::run(worktree_path, &["status", "--porcelain=v2", "--branch"]).await?;
        Ok(parse_status_v2(&out))
    }

    async fn branches(&self, repo_path: &str) -> Result<Vec<String>, GitError> {
        let out = Self::run(
            repo_path,
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes",
            ],
        )
        .await?;
        Ok(parse_branches(&out))
    }

    async fn diff_files(
        &self,
        worktree_path: &str,
        mode: DiffMode,
        base: Option<&str>,
        head: Option<&str>,
    ) -> Result<Vec<DiffFileSummary>, GitError> {
        let range = diff_range_args(mode, base, head)?;
        // 파일 목록만(통계) — hunk 텍스트는 file_diff로 지연 로드.
        let mut numstat_args: Vec<&str> = vec!["diff"];
        numstat_args.extend(range.iter().map(|s| s.as_str()));
        let mut name_args = numstat_args.clone();
        numstat_args.push("--numstat");
        name_args.push("--name-status");

        let numstat = parse_numstat(&Self::run(worktree_path, &numstat_args).await?);
        let name_status = parse_name_status(&Self::run(worktree_path, &name_args).await?);
        Ok(merge_diff_summary(numstat, name_status))
    }

    async fn file_diff(
        &self,
        worktree_path: &str,
        mode: DiffMode,
        base: Option<&str>,
        head: Option<&str>,
        path: &str,
    ) -> Result<String, GitError> {
        let range = diff_range_args(mode, base, head)?;
        let mut args: Vec<&str> = vec!["diff"];
        args.extend(range.iter().map(|s| s.as_str()));
        // 경로는 `--` 뒤로 — arg injection 방지.
        args.push("--");
        args.push(path);
        Self::run(worktree_path, &args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_status_priority() {
        let s = |dirty, ahead, behind| {
            summarize_status(RawStatus {
                dirty,
                ahead,
                behind,
            })
        };
        assert_eq!(s(false, 0, 0), WorktreeStatus::Clean);
        assert_eq!(s(true, 0, 0), WorktreeStatus::Dirty);
        assert_eq!(s(false, 2, 0), WorktreeStatus::Ahead);
        assert_eq!(s(false, 0, 3), WorktreeStatus::Behind);
        assert_eq!(s(false, 2, 3), WorktreeStatus::Diverged);
        // diverged는 dirty보다 우선, dirty는 ahead보다 우선.
        assert_eq!(s(true, 2, 3), WorktreeStatus::Diverged);
        assert_eq!(s(true, 2, 0), WorktreeStatus::Dirty);
    }

    #[test]
    fn diff_range_args_modes() {
        assert_eq!(
            diff_range_args(DiffMode::Working, None, None).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            diff_range_args(DiffMode::Staged, None, None).unwrap(),
            vec!["--cached".to_string()]
        );
        assert_eq!(
            diff_range_args(DiffMode::VsBase, Some("origin/dev"), None).unwrap(),
            vec!["origin/dev...HEAD".to_string()]
        );
        assert_eq!(
            diff_range_args(DiffMode::VsBase, Some("main"), Some("feature")).unwrap(),
            vec!["main...feature".to_string()]
        );
        assert_eq!(
            diff_range_args(DiffMode::BranchBranch, Some("a"), Some("b")).unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
        // 필수 ref 누락 / arg injection은 거부.
        assert!(diff_range_args(DiffMode::VsBase, None, None).is_err());
        assert!(diff_range_args(DiffMode::BranchBranch, Some("a"), None).is_err());
        assert!(
            diff_range_args(DiffMode::BranchBranch, Some("--upload-pack=x"), Some("b")).is_err()
        );
    }

    #[test]
    fn parse_worktree_list_blocks() {
        let out = "\
worktree /repo/main
HEAD aaaa1111
branch refs/heads/dev

worktree /repo/wt-feature
HEAD bbbb2222
detached

worktree /repo/bare
bare
";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 3);
        assert_eq!(wts[0].path, "/repo/main");
        assert_eq!(wts[0].branch.as_deref(), Some("dev"));
        assert_eq!(wts[0].head, "aaaa1111");
        assert!(wts[0].is_primary);
        // detached → branch None, primary 아님.
        assert_eq!(wts[1].branch, None);
        assert!(!wts[1].is_primary);
        // bare 표시.
        assert!(wts[2].bare);
    }

    #[test]
    fn parse_status_v2_dirty_and_ab() {
        // clean + upstream 동일.
        let clean = "# branch.oid abc\n# branch.head dev\n# branch.upstream origin/dev\n# branch.ab +0 -0\n";
        assert_eq!(parse_status_v2(clean), RawStatus::default());
        // ahead/behind + 추적 변경 + untracked.
        let dirty =
            "# branch.ab +2 -1\n1 .M N... 100644 100644 100644 aaa bbb file.rs\n? new.txt\n";
        let s = parse_status_v2(dirty);
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
        assert!(s.dirty);
        // ahead만(클린 워킹트리).
        let ahead_only = "# branch.ab +3 -0\n";
        let s2 = parse_status_v2(ahead_only);
        assert_eq!(s2.ahead, 3);
        assert!(!s2.dirty);
    }

    #[test]
    fn parse_numstat_and_name_status_merge() {
        let numstat =
            "10\t2\tsrc/a.rs\n0\t5\tsrc/b.rs\n-\t-\tassets/logo.png\n3\t1\tsrc/{old => new}/c.rs\n";
        let name =
            "M\tsrc/a.rs\nD\tsrc/b.rs\nM\tassets/logo.png\nR096\tsrc/old/c.rs\tsrc/new/c.rs\n";
        let merged = merge_diff_summary(parse_numstat(numstat), parse_name_status(name));
        let by = |p: &str| merged.iter().find(|f| f.path == p).cloned();

        let a = by("src/a.rs").unwrap();
        assert_eq!((a.adds, a.dels, a.status), (10, 2, FileChange::Modified));
        let b = by("src/b.rs").unwrap();
        assert_eq!((b.dels, b.status), (5, FileChange::Deleted));
        let png = by("assets/logo.png").unwrap();
        assert!(png.binary);
        assert_eq!((png.adds, png.dels), (0, 0));
        // rename: numstat new-path 추출과 name-status R가 같은 경로로 머지 + old_path 보존.
        let c = by("src/new/c.rs").unwrap();
        assert_eq!((c.adds, c.dels, c.status), (3, 1, FileChange::Renamed));
        assert_eq!(c.old_path.as_deref(), Some("src/old/c.rs"));
        // 비-rename은 old_path 없음.
        assert_eq!(a.old_path, None);
    }

    #[test]
    fn parse_branches_filters_head() {
        let out = "dev\nmain\norigin/dev\norigin/HEAD\norigin/main\n";
        let b = parse_branches(out);
        assert_eq!(b, vec!["dev", "main", "origin/dev", "origin/main"]);
    }

    // ── Phase 12c: 활성 변경 + rebase 가드 ───────────────────────────────────────

    #[test]
    fn is_active_change_within_window() {
        let now = chrono::Utc::now();
        // 윈도 안(2분 전) → active.
        assert!(is_active_change(
            Some(now - chrono::Duration::minutes(2)),
            now
        ));
        // 윈도 밖(10분 전) → 비active.
        assert!(!is_active_change(
            Some(now - chrono::Duration::minutes(10)),
            now
        ));
        // mtime 없음 → false.
        assert!(!is_active_change(None, now));
        // 미래 mtime(시계 왜곡)은 active로 치지 않음.
        assert!(!is_active_change(
            Some(now + chrono::Duration::minutes(1)),
            now
        ));
        // 정확히 경계(5분)는 포함.
        assert!(is_active_change(Some(now - ACTIVE_CHANGE_WINDOW), now));
    }

    #[test]
    fn newest_mtime_skips_meta_dirs() {
        let uniq = |tag: &str| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            std::env::temp_dir().join(format!("wr-mtime-{tag}-{nanos}"))
        };
        let dir = uniq("a");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        // 빈 트리(추적 파일 없음) → None.
        assert!(newest_mtime_under(&dir).is_none());
        // 실제 파일 → Some.
        std::fs::write(dir.join("src/main.rs"), "fn main(){}").unwrap();
        assert!(newest_mtime_under(&dir).is_some());
        // .git/node_modules에만 파일이 있고 추적 파일이 없으면 None이어야(스킵 확인).
        let dir2 = uniq("b");
        std::fs::create_dir_all(dir2.join(".git")).unwrap();
        std::fs::create_dir_all(dir2.join("node_modules")).unwrap();
        std::fs::write(dir2.join(".git/HEAD"), "ref: x").unwrap();
        std::fs::write(dir2.join("node_modules/a.js"), "x").unwrap();
        assert!(
            newest_mtime_under(&dir2).is_none(),
            ".git/node_modules는 활동으로 치지 않음"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn validate_base_ref_guards_injection() {
        assert_eq!(validate_base_ref("origin/dev").unwrap(), "origin/dev");
        assert_eq!(validate_base_ref("  main  ").unwrap(), "main");
        assert!(validate_base_ref("").is_err());
        assert!(validate_base_ref("--upload-pack=x").is_err());
    }

    #[test]
    fn backup_ref_name_format() {
        assert_eq!(
            backup_ref_name(Some("feature/x"), "20260522T120000"),
            "refs/wr-backup/feature-x-20260522T120000"
        );
        assert_eq!(backup_ref_name(None, "ts"), "refs/wr-backup/detached-ts");
    }

    // ── Phase 12d: 정리 후보 분류 + 보호 가드 ──────────────────────────────────────

    #[test]
    fn classify_branch_merged_stale_protected() {
        use crate::models::CleanupKind;
        let mk = |name: &str, merged, checked_out, stale, is_base| BranchCleanupInput {
            name: name.to_string(),
            merged,
            checked_out,
            stale,
            is_base,
        };
        // 머지됨 + 비보호 → MergedBranch, force 불필요, 비보호.
        let c = classify_branch(&mk("feat-done", true, false, false, false)).unwrap();
        assert!(matches!(c.kind, CleanupKind::MergedBranch));
        assert!(!c.needs_force);
        assert!(!c.protected);
        assert_eq!(c.id, "branch:feat-done");
        // 머지됐지만 현재 체크아웃 → 보호.
        let cur = classify_branch(&mk("dev", true, true, false, false)).unwrap();
        assert!(cur.protected);
        // base 브랜치 → 보호.
        let base = classify_branch(&mk("dev", true, false, false, true)).unwrap();
        assert!(base.protected);
        // 미머지 + stale → StaleBranch, force 필요.
        let stale = classify_branch(&mk("old-feat", false, false, true, false)).unwrap();
        assert!(matches!(stale.kind, CleanupKind::StaleBranch));
        assert!(stale.needs_force);
        // 머지도 stale도 아님 → 후보 아님.
        assert!(classify_branch(&mk("active", false, false, false, false)).is_none());
    }

    #[test]
    fn guard_delete_protection() {
        // 보호 → 항상 거부(force여도).
        assert!(guard_delete(true, false, false).is_err());
        assert!(guard_delete(true, true, true).is_err());
        // 비보호 + force 불필요 → 허용.
        assert!(guard_delete(false, false, false).is_ok());
        // needs_force인데 force 없음 → 거부.
        assert!(guard_delete(false, true, false).is_err());
        // needs_force + force → 허용.
        assert!(guard_delete(false, true, true).is_ok());
    }

    #[test]
    fn parse_branch_dates_skips_bad() {
        let out =
            "dev\t2026-05-01T10:00:00+00:00\nfeat\t2025-01-01T00:00:00+09:00\nbad\tnot-a-date\n";
        let m = parse_branch_dates(out);
        assert_eq!(m.len(), 2, "bad date 행은 건너뜀");
        assert!(m.contains_key("dev"));
        assert!(m.contains_key("feat"));
        assert!(!m.contains_key("bad"));
    }

    #[test]
    fn parse_prunable_only() {
        let out = "\
worktree /repo/main
HEAD aaaa
branch refs/heads/dev

worktree /repo/gone
HEAD bbbb
prunable gitdir file points to non-existent location

worktree /repo/live
HEAD cccc
branch refs/heads/feat
";
        let p = parse_prunable_worktrees(out);
        assert_eq!(p, vec!["/repo/gone"]);
    }
}
