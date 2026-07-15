import { describe, expect, it } from "vitest";

import {
  branchChangeSummary,
  chooseInitialReviewLens,
  emptyStateForLens,
  localChangeSummary,
  mergeStateSummary,
  reviewQueueLabel,
  visualGitGraphCells,
  visualGitGraphRows,
  type WorktreeReviewCounts,
} from "@/lib/worktreeReview";

function counts(partial: Partial<WorktreeReviewCounts>): WorktreeReviewCounts {
  return {
    stagedCount: 0,
    unstagedCount: 0,
    baseAhead: 0,
    baseBehind: 0,
    dirty: false,
    ...partial,
  };
}

describe("chooseInitialReviewLens", () => {
  it("unstaged-only는 Unstaged(working)를 먼저 연다", () => {
    expect(chooseInitialReviewLens(counts({ unstagedCount: 2, dirty: true }))).toBe("working");
  });

  it("staged-only는 Staged를 먼저 연다", () => {
    expect(chooseInitialReviewLens(counts({ stagedCount: 1, dirty: true }))).toBe("staged");
  });

  it("로컬 변경이 없으면 branch vs base를 먼저 연다", () => {
    expect(chooseInitialReviewLens(counts({ baseAhead: 2 }))).toBe("vs_base");
  });
});

describe("worktree review copy", () => {
  it("local summary는 staged와 unstaged를 문장으로 설명한다", () => {
    expect(localChangeSummary(counts({ stagedCount: 1, unstagedCount: 2 }))).toBe(
      "로컬 변경 3개 · staged 1 · unstaged 2",
    );
  });

  it("branch summary는 ahead/behind를 문장화한다", () => {
    expect(branchChangeSummary(counts({ baseAhead: 2, baseBehind: 1 }))).toBe(
      "base보다 2개 앞서고 1개 뒤처짐",
    );
  });

  it("review queue는 local과 branch를 합쳐 보여준다", () => {
    expect(reviewQueueLabel({ stagedCount: 1, unstagedCount: 2, branchFileCount: 4 })).toBe(
      "검수할 변경 7개 · local 3 · branch 4",
    );
  });

  it("merge 상태는 base 기준으로 문장화한다", () => {
    expect(
      mergeStateSummary({
        branch: "dev",
        baseBranch: "dev",
        mergedIntoBase: null,
        baseAhead: 0,
        baseBehind: 0,
      }),
    ).toBe("dev 기준 브랜치");
    expect(
      mergeStateSummary({
        branch: "feature",
        baseBranch: "dev",
        mergedIntoBase: true,
        baseAhead: 2,
        baseBehind: 0,
      }),
    ).toBe("dev에 머지됨");
    expect(
      mergeStateSummary({
        branch: "feature",
        baseBranch: "dev",
        mergedIntoBase: false,
        baseAhead: 2,
        baseBehind: 1,
      }),
    ).toBe("dev에 미머지");
    expect(
      mergeStateSummary({
        branch: null,
        baseBranch: "dev",
        mergedIntoBase: null,
        baseAhead: null,
        baseBehind: null,
      }),
    ).toBe("detached HEAD");
  });
});

describe("emptyStateForLens", () => {
  it("unstaged가 비었지만 staged가 있으면 staged로 안내한다", () => {
    expect(emptyStateForLens("working", counts({ stagedCount: 2 }))).toEqual({
      message: "Unstaged 변경은 없습니다. Staged에 2개 파일이 있습니다.",
      switchTo: "staged",
      switchLabel: "Staged 보기",
    });
  });

  it("staged가 비었지만 unstaged가 있으면 unstaged로 안내한다", () => {
    expect(emptyStateForLens("staged", counts({ unstagedCount: 3 }))).toEqual({
      message: "Staged 변경은 없습니다. Unstaged에 3개 파일이 있습니다.",
      switchTo: "working",
      switchLabel: "Unstaged 보기",
    });
  });
});

describe("visualGitGraphRows", () => {
  it("git log --graph 원문에서 graph prefix와 커밋 본문을 분리한다", () => {
    expect(
      visualGitGraphRows(
        ["* a1b2c3d (HEAD -> feature) add drawer", "| * b2c3d4e (origin/main) base fix", "|/"],
        [
          { shortHash: "a1b2c3d", side: "right" },
          { shortHash: "b2c3d4e", side: "left" },
        ],
      ),
    ).toEqual([
      { graph: "* ", text: "a1b2c3d (HEAD -> feature) add drawer", side: "right" },
      { graph: "| * ", text: "b2c3d4e (origin/main) base fix", side: "left" },
      { graph: "|/", text: "", side: null },
    ]);
  });

  it("커밋 hash를 못 찾으면 전체 라인을 graph-only로 보존한다", () => {
    expect(visualGitGraphRows(["|\\"], [])).toEqual([{ graph: "|\\", text: "", side: null }]);
  });

  it("커밋 제목에 다른 short hash가 있어도 라인의 첫 커밋 토큰을 기준으로 분리한다", () => {
    expect(
      visualGitGraphRows(
        ["| * b2c3d4e mention a1b2c3d in subject"],
        [
          { shortHash: "a1b2c3d", side: "right" },
          { shortHash: "b2c3d4e", side: "left" },
        ],
      ),
    ).toEqual([
      {
        graph: "| * ",
        text: "b2c3d4e mention a1b2c3d in subject",
        side: "left",
      },
    ]);
  });
});

describe("computeGraphTopology", () => {
  it("linear history → single lane, every row's node at lane 0", async () => {
    const { computeGraphTopology } = await import("./worktreeReview");
    const top = computeGraphTopology([
      { shortHash: "c3", parents: ["c2"] },
      { shortHash: "c2", parents: ["c1"] },
      { shortHash: "c1", parents: [] },
    ]);
    expect(top.maxLanes).toBe(1);
    expect(top.rows.map((r) => r.laneNode)).toEqual([0, 0, 0]);
    expect(top.rows[2].lanesBelow).toEqual([]);
  });

  it("merge commit branches into two lanes then rejoins", async () => {
    const { computeGraphTopology } = await import("./worktreeReview");
    // m → (a, b); a → base; b → base; base → null
    const top = computeGraphTopology([
      { shortHash: "m", parents: ["a", "b"] },
      { shortHash: "a", parents: ["base"] },
      { shortHash: "b", parents: ["base"] },
      { shortHash: "base", parents: [] },
    ]);
    expect(top.maxLanes).toBe(2);
    expect(top.rows[0].laneNode).toBe(0);
    // After merge node: lane 0 expects 'a', lane 1 expects 'b'
    expect(top.rows[0].lanesBelow).toEqual(["a", "b"]);
    // Last commit 'base' merges both lanes back; one drops, one becomes laneNode.
    const last = top.rows[3];
    expect(last.lanesBelow).toEqual([]);
  });
});

describe("visualGitGraphCells", () => {
  it("git graph prefix 문자를 시각 lane cell로 정규화한다", () => {
    expect(visualGitGraphCells("| * ")).toEqual([
      { kind: "vertical", lane: 0 },
      { kind: "space", lane: 1 },
      { kind: "node", lane: 2 },
      { kind: "space", lane: 3 },
    ]);
    expect(visualGitGraphCells("|\\  ")).toEqual([
      { kind: "vertical", lane: 0 },
      { kind: "backslash", lane: 1 },
      { kind: "space", lane: 2 },
      { kind: "space", lane: 3 },
    ]);
  });
});
