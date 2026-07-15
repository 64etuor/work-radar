import type { DiffMode, Worktree } from "@/bindings";

export type ReviewLens = "local" | DiffMode;

export type WorktreeReviewCounts = Pick<
  Worktree,
  "stagedCount" | "unstagedCount" | "baseAhead" | "baseBehind" | "dirty"
>;

export type WorktreeMergeState = Pick<
  Worktree,
  "branch" | "baseBranch" | "mergedIntoBase" | "baseAhead" | "baseBehind"
>;

export type ControlRoomBrief = {
  readonly repositories: number;
  readonly worktrees: number;
  readonly active: number;
  readonly attention: number;
};

export function controlRoomBrief(worktrees: readonly Worktree[]): ControlRoomBrief {
  const repositories = new Set(worktrees.map((worktree) => worktree.repoId)).size;
  const active = worktrees.filter((worktree) => worktree.activeChange).length;
  const attention = worktrees.filter((worktree) => {
    const hasLocalChanges = worktree.stagedCount + worktree.unstagedCount > 0;
    const hasDiverged = (worktree.baseAhead ?? 0) > 0 || (worktree.baseBehind ?? 0) > 0;
    return hasLocalChanges || hasDiverged || worktree.mergedIntoBase === false;
  }).length;

  return { repositories, worktrees: worktrees.length, active, attention };
}

export function localChangeCount(w: WorktreeReviewCounts): number {
  return w.stagedCount + w.unstagedCount;
}

export function chooseInitialReviewLens(w: WorktreeReviewCounts): DiffMode {
  if (w.unstagedCount > 0) return "working";
  if (w.stagedCount > 0) return "staged";
  return "vs_base";
}

export function localChangeSummary(w: WorktreeReviewCounts): string {
  const local = localChangeCount(w);
  if (local === 0) return "로컬 미커밋 변경 없음";
  const parts: string[] = [];
  if (w.stagedCount > 0) parts.push(`staged ${w.stagedCount}`);
  if (w.unstagedCount > 0) parts.push(`unstaged ${w.unstagedCount}`);
  return `로컬 변경 ${local}개 · ${parts.join(" · ")}`;
}

export function branchChangeSummary(w: WorktreeReviewCounts): string {
  if (w.baseAhead == null || w.baseBehind == null) return "base 비교 미확인";
  if (w.baseAhead > 0 && w.baseBehind > 0) {
    return `base보다 ${w.baseAhead}개 앞서고 ${w.baseBehind}개 뒤처짐`;
  }
  if (w.baseAhead > 0) return `base보다 커밋 ${w.baseAhead}개 앞섬`;
  if (w.baseBehind > 0) return `base보다 커밋 ${w.baseBehind}개 뒤처짐`;
  return "base와 커밋 차이 없음";
}

export function mergeStateSummary(w: WorktreeMergeState): string {
  if (!w.branch) return "detached HEAD";
  if (w.branch === w.baseBranch) return `${w.baseBranch} 기준 브랜치`;
  if (w.mergedIntoBase === true) return `${w.baseBranch}에 머지됨`;
  if (w.mergedIntoBase === false) return `${w.baseBranch}에 미머지`;
  return "머지 상태 미확인";
}

export function branchGraphAriaLabel(w: WorktreeMergeState): string {
  const relation = branchChangeSummary({
    stagedCount: 0,
    unstagedCount: 0,
    baseAhead: w.baseAhead,
    baseBehind: w.baseBehind,
    dirty: false,
  });
  return `${w.baseBranch}에서 ${w.branch ?? "detached HEAD"}까지의 base 비교 그래프: ${relation}, ${mergeStateSummary(w)}`;
}

export function reviewQueueLabel(args: {
  stagedCount: number;
  unstagedCount: number;
  branchFileCount: number | null;
}): string {
  const local = args.stagedCount + args.unstagedCount;
  const branch = args.branchFileCount ?? 0;
  const total = local + branch;
  if (total === 0) return "검수할 변경 없음";
  if (local > 0 && branch > 0) return `검수할 변경 ${total}개 · local ${local} · branch ${branch}`;
  if (local > 0) return `검수할 local 변경 ${local}개`;
  return `검수할 branch 변경 ${branch}개`;
}

export function emptyStateForLens(
  lens: DiffMode,
  counts: Pick<WorktreeReviewCounts, "stagedCount" | "unstagedCount">,
): { message: string; switchTo?: DiffMode; switchLabel?: string } {
  if (lens === "working" && counts.stagedCount > 0) {
    return {
      message: `Unstaged 변경은 없습니다. Staged에 ${counts.stagedCount}개 파일이 있습니다.`,
      switchTo: "staged",
      switchLabel: "Staged 보기",
    };
  }
  if (lens === "staged" && counts.unstagedCount > 0) {
    return {
      message: `Staged 변경은 없습니다. Unstaged에 ${counts.unstagedCount}개 파일이 있습니다.`,
      switchTo: "working",
      switchLabel: "Unstaged 보기",
    };
  }
  return { message: "이 bucket에는 변경 파일이 없습니다." };
}

export function diffContextLabel(lens: DiffMode): string {
  switch (lens) {
    case "working":
      return "unstaged · working tree vs index";
    case "staged":
      return "staged · index vs HEAD";
    case "vs_base":
      return "branch · HEAD vs base";
    case "branch_branch":
      return "compare refs";
  }
}

export type VisualGitGraphCommit = {
  shortHash: string;
  side: "left" | "right";
};

export type VisualGitGraphRow = {
  graph: string;
  text: string;
  side: "left" | "right" | null;
};

export type VisualGitGraphCell = {
  kind: "space" | "node" | "vertical" | "slash" | "backslash" | "horizontal";
  lane: number;
};

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function normalizeGraphLine(line: string): string {
  return line.replace(ANSI_ESCAPE_RE, "").replace(/\r$/, "");
}

function findFirstCommitToken(
  line: string,
  commits: VisualGitGraphCommit[],
): VisualGitGraphCommit | null {
  let first: { commit: VisualGitGraphCommit; index: number } | null = null;
  for (const commit of commits) {
    const index = line.indexOf(commit.shortHash);
    if (index === -1) continue;
    if (!first || index < first.index) {
      first = { commit, index };
    }
  }
  return first?.commit ?? null;
}

export function visualGitGraphRows(
  graphLines: string[],
  commits: VisualGitGraphCommit[],
): VisualGitGraphRow[] {
  return graphLines.map((rawLine) => {
    const line = normalizeGraphLine(rawLine);
    const commit = findFirstCommitToken(line, commits);
    if (!commit) return { graph: line, text: "", side: null };

    const hashIndex = line.indexOf(commit.shortHash);
    return {
      graph: line.slice(0, hashIndex),
      text: line.slice(hashIndex),
      side: commit.side,
    };
  });
}

export type GraphTopologyCommit = {
  shortHash: string;
  parents: string[];
};

export type GraphTopologyRow = {
  laneNode: number;
  lanesAbove: (string | null)[];
  lanesBelow: (string | null)[];
  laneColors: number[];
};

export type GraphTopology = {
  rows: GraphTopologyRow[];
  maxLanes: number;
};

/**
 * commits(자식→부모 순)로부터 lane 토폴로지를 계산한다.
 * 각 row.laneNode = 그 커밋이 차지하는 lane index.
 * lanesAbove/lanesBelow = 그 row 위/아래의 lane 상태(각 lane이 기다리는 parent shortHash, 빈 lane은 null).
 * laneColors = 각 lane index의 안정적 색 버킷(0..5).
 */
export function computeGraphTopology(commits: GraphTopologyCommit[]): GraphTopology {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const allocateLane = (hash: string): number => {
    let slot = lanes.indexOf(null);
    if (slot === -1) {
      slot = lanes.length;
      lanes.push(null);
      colors.push(nextColor++ % 6);
    } else {
      colors[slot] = nextColor++ % 6;
    }
    lanes[slot] = hash;
    return slot;
  };

  const rows: GraphTopologyRow[] = [];

  for (const commit of commits) {
    let laneNode = lanes.indexOf(commit.shortHash);
    if (laneNode === -1) {
      laneNode = allocateLane(commit.shortHash);
    }
    const dropLanes: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== laneNode && lanes[i] === commit.shortHash) dropLanes.push(i);
    }

    const lanesAbove = lanes.slice();

    if (commit.parents.length === 0) {
      lanes[laneNode] = null;
    } else {
      lanes[laneNode] = commit.parents[0];
      for (let i = 1; i < commit.parents.length; i++) {
        const parent = commit.parents[i];
        const existing = lanes.indexOf(parent);
        if (existing !== -1) continue;
        allocateLane(parent);
      }
    }
    for (const dl of dropLanes) lanes[dl] = null;
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }

    const lanesBelow = lanes.slice();
    const laneCount = Math.max(lanesAbove.length, lanesBelow.length, laneNode + 1);
    const laneColors: number[] = [];
    for (let i = 0; i < laneCount; i++) laneColors.push(colors[i] ?? 0);

    rows.push({ laneNode, lanesAbove, lanesBelow, laneColors });
  }

  const maxLanes = rows.reduce((m, r) => Math.max(m, r.lanesAbove.length, r.lanesBelow.length), 1);
  return { rows, maxLanes };
}

export function visualGitGraphCells(graphPrefix: string): VisualGitGraphCell[] {
  return [...graphPrefix].map((char, lane) => {
    switch (char) {
      case "*":
        return { kind: "node", lane };
      case "|":
        return { kind: "vertical", lane };
      case "/":
        return { kind: "slash", lane };
      case "\\":
        return { kind: "backslash", lane };
      case "-":
      case "_":
        return { kind: "horizontal", lane };
      default:
        return { kind: "space", lane };
    }
  });
}

/** mtime → "N분/시간/일 전 변경" 상대 라벨(순수). 미래 mtime(시계 왜곡)은 표시 안 함. */
export function relativeActivity(newestMtime: string | null): string {
  if (!newestMtime) return "";
  const diffMs = Date.now() - new Date(newestMtime).getTime();
  if (diffMs < 0) return "";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "방금 변경";
  if (diffMin < 60) return `${diffMin}분 전 변경`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전 변경`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}일 전 변경`;
}
