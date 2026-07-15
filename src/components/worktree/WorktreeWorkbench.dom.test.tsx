import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Worktree } from "@/bindings";
import { controlRoomBrief } from "@/lib/worktreeReview";

import { WorktreeHeader } from "./WorktreeHeader";
import { ReviewSummary } from "./WorktreeReviewPanel";
import { WorktreeSideList } from "./WorktreeSideList";

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "repo-1:/workspace/main",
    repoId: "repo-1",
    projectId: "project-1",
    repoLabel: "work-radar",
    path: "/workspace/main",
    branch: "feature/리뷰-워크벤치",
    head: "abc123",
    baseBranch: "dev",
    mergedIntoBase: false,
    baseAhead: 3,
    baseBehind: 1,
    isPrimary: false,
    status: "diverged",
    dirty: true,
    stagedCount: 1,
    unstagedCount: 2,
    ahead: 3,
    behind: 1,
    newestMtime: "2026-07-15T11:59:30Z",
    activeChange: true,
    lastFetchedAt: "2026-07-15T12:00:00Z",
    ...overrides,
  };
}

describe("Worktree control room orientation", () => {
  it("renders the editorial heading, live brief, and separated operational actions", () => {
    const list = [worktree(), worktree({ id: "repo-2:/workspace/docs", repoId: "repo-2" })];
    const html = renderToStaticMarkup(
      <WorktreeHeader
        projects={[]}
        projectFilter={null}
        brief={controlRoomBrief(list)}
        graph={{ enabled: true, active: false, onToggle: vi.fn() }}
        cleanup={{ enabled: true, active: false, onToggle: vi.fn() }}
        worktreesFetching={false}
        onProjectFilterChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(html).toContain("CODE / WORKSPACE REVIEW");
    expect(html).toContain("<h1>Worktree Control Room</h1>");
    expect(html).toContain('aria-label="Worktree portfolio summary"');
    expect(html).toContain("Repositories");
    expect(html).toContain("Worktrees");
    expect(html).toContain("Active now");
    expect(html).toContain("Attention");
    expect(html).toContain("Evidence");
    expect(html).toContain("Maintenance");
  });

  it("renders repository counts and full worktree path evidence", () => {
    const first = worktree();
    const second = worktree({
      id: "repo-1:/workspace/docs",
      path: "/workspace/docs",
      branch: "docs/long-english-and-한국어-branch",
      activeChange: false,
    });
    const list = [first, second];
    const html = renderToStaticMarkup(
      <WorktreeSideList
        collapsed={false}
        onCollapsedChange={vi.fn()}
        error={null}
        isLoading={false}
        list={list}
        grouped={[["work-radar", list]]}
        selectedPath={first.path}
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain("work-radar");
    expect(html).toContain("2 worktrees");
    expect(html).toContain('title="/workspace/main"');
    expect(html).toContain("feature/리뷰-워크벤치");
    expect(html).toContain("docs/long-english-and-한국어-branch");
  });

  it("states the selected workspace and review evidence explicitly", () => {
    const html = renderToStaticMarkup(<ReviewSummary worktree={worktree()} branchFileCount={4} />);

    expect(html).toContain("Selected workspace");
    expect(html).toContain("Review evidence");
    expect(html).toContain("Local changes");
    expect(html).toContain("Branch relation");
    expect(html).toContain("feature/리뷰-워크벤치");
    expect(html).toContain("base dev");
    expect(html).toContain("검수할 변경 7개");
  });
});
