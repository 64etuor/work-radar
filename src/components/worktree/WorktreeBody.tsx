import type { UseQueryResult } from "@tanstack/react-query";

import type { DiffFileSummary, DiffMode, Worktree } from "@/bindings";
import { usePaneSize } from "@/lib/usePaneSize";
import type { ReviewLens } from "@/lib/worktreeReview";

import { CommitGraphDrawer } from "./CommitGraphDrawer";
import { WorktreeDiffPanel } from "./WorktreeDiffPanel";
import { WorktreeEmptyState } from "./WorktreeEmptyState";
import { type SelectedDiff } from "./WorktreeFileList";
import { WorktreeLensToolbar } from "./WorktreeLensToolbar";
import { WorktreeRefsBar } from "./WorktreeRefsBar";
import { ReviewSummary } from "./WorktreeReviewPanel";
import { WorktreeSideList } from "./WorktreeSideList";

type SidebarModel = {
  collapsed: boolean;
  error: Error | null;
  isLoading: boolean;
  list: Worktree[];
  grouped: [string, Worktree[]][];
  selectedPath: string | null;
};

type ReviewModel = {
  selected: Worktree | null;
  branchFileCount: number | null;
  branchList: string[];
  lens: ReviewLens;
  activeMode: DiffMode | null;
  ready: boolean;
  baseRef: string | null;
  headRef: string | null;
  fileCount: number;
  filesCollapsed: boolean;
  selectedDiff: SelectedDiff | null;
  graphOpen: boolean;
  reviewing: boolean;
};

type DiffQueries = {
  diffFiles: UseQueryResult<DiffFileSummary[], Error>;
  stagedFiles: UseQueryResult<DiffFileSummary[], Error>;
  unstagedFiles: UseQueryResult<DiffFileSummary[], Error>;
  fileDiff: UseQueryResult<string, Error>;
};

type WorktreeBodyActions = {
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  onSelectWorktree: (worktree: Worktree) => void;
  onLensChange: (lens: ReviewLens) => void;
  onBaseRefChange: (ref: string | null) => void;
  onHeadRefChange: (ref: string | null) => void;
  onFilesCollapsedChange: (collapsed: boolean) => void;
  onSelectedDiffChange: (next: SelectedDiff | null) => void;
  onCloseGraph: () => void;
  onReviewWorktree: () => void;
};

export function WorktreeBody({
  sidebar,
  review,
  queries,
  actions,
}: {
  sidebar: SidebarModel;
  review: ReviewModel;
  queries: DiffQueries;
  actions: WorktreeBodyActions;
}) {
  const sidePane = usePaneSize({
    key: "worktree-sidebar",
    defaultSize: 268,
    min: 180,
    max: 420,
    snap: 190,
    collapsed: sidebar.collapsed,
  });

  return (
    <div className="wt-body">
      <WorktreeSideList
        collapsed={sidebar.collapsed}
        onCollapsedChange={actions.onSidebarCollapsedChange}
        error={sidebar.error}
        isLoading={sidebar.isLoading}
        list={sidebar.list}
        grouped={sidebar.grouped}
        selectedPath={sidebar.selectedPath}
        onSelect={actions.onSelectWorktree}
        style={sidePane.style}
        resizeHandleProps={sidePane.bindResizeHandle(() => actions.onSidebarCollapsedChange(true))}
      />

      <main className="wt-main">
        {!review.selected ? (
          <WorktreeEmptyState />
        ) : (
          <>
            <ReviewSummary
              worktree={review.selected}
              branchFileCount={review.branchFileCount}
              reviewing={review.reviewing}
              onReview={actions.onReviewWorktree}
            />
            <WorktreeLensToolbar
              worktree={review.selected}
              lens={review.lens}
              onLensChange={actions.onLensChange}
            />
            <WorktreeRefsBar
              lens={review.lens}
              branchList={review.branchList}
              baseRef={review.baseRef}
              headRef={review.headRef}
              onBaseRefChange={actions.onBaseRefChange}
              onHeadRefChange={actions.onHeadRefChange}
            />
            <WorktreeDiffPanel
              worktree={review.selected}
              lens={review.lens}
              activeMode={review.activeMode}
              ready={review.ready}
              fileCount={review.fileCount}
              filesCollapsed={review.filesCollapsed}
              selectedDiff={review.selectedDiff}
              queries={queries}
              onFilesCollapsedChange={actions.onFilesCollapsedChange}
              onSelectedDiffChange={actions.onSelectedDiffChange}
              onLensChange={actions.onLensChange}
            />
          </>
        )}
      </main>

      {review.selected && review.graphOpen && (
        <CommitGraphDrawer
          worktree={review.selected}
          baseRef={review.baseRef ?? review.selected.baseBranch}
          onClose={actions.onCloseGraph}
        />
      )}
    </div>
  );
}
