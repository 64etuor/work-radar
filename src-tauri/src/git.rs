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
}
