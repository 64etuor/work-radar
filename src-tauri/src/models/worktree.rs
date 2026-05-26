use serde::{Deserialize, Serialize};
use specta::Type;
// ── Worktree & Branch Diff (Phase 5, read-only) ──────────────────────────────────
//
// 모두 ambient DTO다 — DB 영속 없이 매 호출마다 git에서 fresh 도출(PR Radar 선례).
// INVARIANT #6: read 서브커맨드만 — Diff Viewer는 워킹트리/브랜치를 절대 변경하지 않는다.
// specta는 i64/u64 export 금지 → 카운트는 u32.

/// worktree 동기화 상태 요약 (architecture §4). 우선순위:
/// Diverged(ahead&behind) > Dirty > Ahead > Behind > Clean. 수치는 ahead/behind로 별도 노출.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeStatus {
    Clean,
    Dirty,
    Ahead,
    Behind,
    Diverged,
}

/// repo별 git worktree (ambient — `git worktree list`로 매번 도출). 토큰 등 비밀 미포함.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// 안정 식별자 = `{repoId}:{path}` (ambient라 DB id 없음).
    pub id: String,
    pub repo_id: String,
    pub project_id: String,
    /// 표시 라벨 (remote owner/repo 또는 local_path basename).
    pub repo_label: String,
    /// worktree 파일시스템 경로.
    pub path: String,
    /// 현재 브랜치 (detached HEAD면 None).
    pub branch: Option<String>,
    /// HEAD sha.
    pub head: String,
    /// diff 비교 기본 기준 (repo.default_branch). vs_base 모드 기본값.
    pub base_branch: String,
    /// 현재 브랜치가 base_branch에 머지됐는지. detached/base/조회 실패는 None으로 둔다.
    pub merged_into_base: Option<bool>,
    /// base_branch에는 없고 현재 HEAD에만 있는 커밋 수(`git rev-list base...HEAD` right side).
    /// detached/조회 실패는 None.
    pub base_ahead: Option<u32>,
    /// 현재 HEAD에는 없고 base_branch에만 있는 커밋 수(`git rev-list base...HEAD` left side).
    /// detached/조회 실패는 None.
    pub base_behind: Option<u32>,
    /// 메인 워킹카피 여부 (`git worktree list` 첫 항목).
    pub is_primary: bool,
    pub status: WorktreeStatus,
    /// 미커밋 변경(추적 변경 + untracked) 존재 여부.
    pub dirty: bool,
    /// staged(index vs HEAD) 변경 파일 수. Worktree Review Cockpit이 staged-only 상태를 설명한다.
    pub staged_count: u32,
    /// unstaged(working tree vs index + untracked) 변경 파일 수.
    pub unstaged_count: u32,
    pub ahead: u32,
    pub behind: u32,
    /// worktree 안 가장 최근 파일 mtime(RFC3339). .git/target/node_modules 등은 제외. 없으면 None.
    pub newest_mtime: Option<String>,
    /// 최근(ACTIVE_CHANGE_WINDOW 이내) 파일 변경 = "지금 작업 중" 표시. 라이브 폴링으로 갱신.
    pub active_change: bool,
    /// 이 도출 시각(RFC3339) — ambient라 항상 now.
    pub last_fetched_at: String,
}

/// 안전 dev rebase 결과 (Phase 12c). 성공/충돌(abort+복구) 둘 다 terminal로 노출한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    /// rebase 성공 여부. false면 충돌로 abort + 백업 복구된 상태.
    pub success: bool,
    /// rebase 기준 ref (예: "origin/dev").
    pub base: String,
    /// 복구를 위해 만든 백업 ref (`refs/wr-backup/<branch>-<ts>`). dirty 거부 시엔 미생성(None).
    pub backup_ref: Option<String>,
    /// 사람이 읽을 결과/실패 요약(성공 통계 또는 충돌 사유).
    pub message: String,
}

/// 정리 후보 한 항목 (Phase 12d). merged 브랜치 / stale 브랜치 / prunable worktree.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CleanupKind {
    /// 기준 브랜치(base)에 이미 머지된 로컬 브랜치.
    MergedBranch,
    /// base에 미머지지만 오래된(stale) 로컬 브랜치 — 삭제는 force 필요.
    StaleBranch,
    /// 디스크에서 사라졌거나 prune 대상인 worktree 등록.
    PrunableWorktree,
}

/// 정리 후보 (Phase 12d). UI 다중 선택 + 보호 가드의 입력. 비밀 미포함.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    /// 안정 식별자 = `{kind}:{name}` (branch명 또는 worktree 경로).
    pub id: String,
    pub kind: CleanupKind,
    /// 브랜치명 또는 worktree 경로.
    pub name: String,
    /// 사람이 읽을 보조 설명(예: "dev에 머지됨", "현재 브랜치 — 보호됨").
    pub detail: String,
    /// 보호 대상(현재 브랜치/dirty worktree/미머지)이라 기본 삭제 불가. force여도 일부는 불가.
    pub protected: bool,
    /// 삭제 시 force 플래그 필요 여부(미머지 브랜치 = true).
    pub needs_force: bool,
}

/// diff 비교 모드 4종 (PLAN.md Phase 5). IPC 파라미터.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DiffMode {
    /// 미커밋 워킹트리 diff (워킹트리 vs index, unstaged).
    Working,
    /// index diff (staged, index vs HEAD).
    Staged,
    /// `git diff <base>...<head>` (3-dot, merge-base 기준).
    VsBase,
    /// 임의 두 ref 직접 비교 (`git diff <base> <head>`).
    BranchBranch,
}

/// diff 한 파일의 변경 종류. architecture DTO와 동일하게 단일 문자로 직렬화("M"/"A"/"D"/"R").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FileChange {
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
}

/// diff 파일 목록 한 항목 (통계만 — 파일별 hunk는 지연 로드). specta i64/u64 금지 → adds/dels u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileSummary {
    pub path: String,
    pub status: FileChange,
    pub adds: u32,
    pub dels: u32,
    /// rename일 때 이전 경로 (표시용 "old → new").
    pub old_path: Option<String>,
    /// 바이너리 파일 (numstat이 '-'). adds/dels는 0.
    pub binary: bool,
}

/// base...HEAD 커밋 그래프 한 커밋의 방향. right=head 전용, left=base 전용.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommitSide {
    Left,
    Right,
}

/// 커밋 그래프 drawer용 구조화 커밋. Git read-only log 출력에서 도출.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphEntry {
    pub side: CommitSide,
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    /// 짧은 hash 리스트(`git log %p`). 빈 벡터면 root 커밋. lane 토폴로지 계산용.
    pub parents: Vec<String>,
}

/// `git log --graph` 원문 라인 + 구조화 커밋 목록. 표시 전용(read-only).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraph {
    pub base: String,
    pub head: String,
    pub graph_lines: Vec<String>,
    pub commits: Vec<CommitGraphEntry>,
    pub truncated: bool,
}
