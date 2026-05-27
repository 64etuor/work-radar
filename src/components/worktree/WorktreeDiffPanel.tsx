import type { UseQueryResult } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import type { DiffFileSummary, DiffMode, Worktree } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { usePaneSize } from "@/lib/usePaneSize";
import { diffContextLabel, type ReviewLens } from "@/lib/worktreeReview";

import { DiffText } from "./WorktreeDiffText";
import { FileRow, LocalFileSections, type SelectedDiff } from "./WorktreeFileList";
import { LensEmptyState } from "./WorktreeReviewPanel";

const SOURCE_LABEL: Record<DiffMode, string> = {
  working: "unstaged",
  staged: "staged",
  vs_base: "branch",
  branch_branch: "compare",
};

type FileQueries = {
  diffFiles: UseQueryResult<DiffFileSummary[], Error>;
  stagedFiles: UseQueryResult<DiffFileSummary[], Error>;
  unstagedFiles: UseQueryResult<DiffFileSummary[], Error>;
  fileDiff: UseQueryResult<string, Error>;
};

export function WorktreeDiffPanel({
  worktree,
  lens,
  activeMode,
  ready,
  fileCount,
  filesCollapsed,
  selectedDiff,
  queries,
  onFilesCollapsedChange,
  onSelectedDiffChange,
  onLensChange,
}: {
  worktree: Worktree;
  lens: ReviewLens;
  activeMode: DiffMode | null;
  ready: boolean;
  fileCount: number;
  filesCollapsed: boolean;
  selectedDiff: SelectedDiff | null;
  queries: FileQueries;
  onFilesCollapsedChange: (collapsed: boolean) => void;
  onSelectedDiffChange: (next: SelectedDiff | null) => void;
  onLensChange: (lens: ReviewLens) => void;
}) {
  const { diffFiles, stagedFiles, unstagedFiles, fileDiff } = queries;
  const selectedFile = findSelectedFile(
    selectedDiff,
    diffFiles.data,
    stagedFiles.data,
    unstagedFiles.data,
  );
  const filePane = usePaneSize({
    key: "worktree-files",
    defaultSize: 300,
    min: 190,
    max: 520,
    snap: 200,
    collapsed: filesCollapsed,
  });

  return (
    <div className="wt-split">
      {filesCollapsed ? (
        <button
          type="button"
          className="wt-rail"
          onClick={() => onFilesCollapsedChange(false)}
          title="파일 목록 펼치기"
        >
          <PanelLeftOpen className="size-4" />
          <span className="wt-rail-label">
            Files
            {fileCount > 0 ? ` (${fileCount})` : ""}
          </span>
        </button>
      ) : (
        <div className="wt-files" style={filePane.style}>
          <div className="wt-panel-head">
            <span className="wt-panel-title">
              Files
              {fileCount > 0 ? ` (${fileCount})` : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-wr-muted size-6 shrink-0 p-0"
              onClick={() => onFilesCollapsedChange(true)}
              title="패널 접기"
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </div>
          <WorktreeFilePanel
            worktree={worktree}
            lens={lens}
            activeMode={activeMode}
            ready={ready}
            selectedDiff={selectedDiff}
            diffFiles={diffFiles}
            stagedFiles={stagedFiles}
            unstagedFiles={unstagedFiles}
            onSelectedDiffChange={onSelectedDiffChange}
            onLensChange={onLensChange}
          />
          <div
            className="wt-resize-handle"
            {...filePane.bindResizeHandle(() => onFilesCollapsedChange(true))}
            title="파일 패널 크기 조절"
          />
        </div>
      )}

      <div className="wt-diff">
        {!selectedDiff ? (
          <div className="wt-empty">파일을 선택하면 diff를 봅니다.</div>
        ) : fileDiff.isFetching ? (
          <div className="wt-empty">diff 로드 중…</div>
        ) : fileDiff.error ? (
          <div className="wt-err">{fileDiff.error.message}</div>
        ) : (
          <>
            <div className="wt-diff-context">
              <span className={`wt-source wt-source-${selectedDiff.mode}`}>
                {SOURCE_LABEL[selectedDiff.mode]}
              </span>
              <span className="wt-diff-path">{selectedDiff.path}</span>
              <span className="wt-diff-mode">{diffContextLabel(selectedDiff.mode)}</span>
            </div>
            {selectedFile && <FileTimeline file={selectedFile} mode={selectedDiff.mode} />}
            <DiffText text={fileDiff.data ?? ""} path={selectedDiff.path} />
          </>
        )}
      </div>
    </div>
  );
}

function findSelectedFile(
  selected: SelectedDiff | null,
  branchFiles?: DiffFileSummary[],
  stagedFiles?: DiffFileSummary[],
  unstagedFiles?: DiffFileSummary[],
): DiffFileSummary | null {
  if (!selected) return null;
  const source =
    selected.mode === "staged"
      ? stagedFiles
      : selected.mode === "working"
        ? unstagedFiles
        : branchFiles;
  return source?.find((file) => file.path === selected.path) ?? null;
}

function FileTimeline({ file, mode }: { file: DiffFileSummary; mode: DiffMode }) {
  const events = [
    file.status === "A"
      ? "file created"
      : file.status === "R"
        ? `renamed from ${file.oldPath ?? "previous path"}`
        : file.status === "D"
          ? "file deleted"
          : "file modified",
    `${file.adds}+ / ${file.dels}-`,
    SOURCE_LABEL[mode],
    mode === "vs_base" || mode === "branch_branch"
      ? "merge review surface"
      : "local review surface",
    "AI review can attach from worktree header",
  ];
  return (
    <div className="wt-file-timeline" aria-label="file timeline">
      {events.map((event) => (
        <span key={event}>
          <i />
          {event}
        </span>
      ))}
    </div>
  );
}

function WorktreeFilePanel({
  worktree,
  lens,
  activeMode,
  ready,
  selectedDiff,
  diffFiles,
  stagedFiles,
  unstagedFiles,
  onSelectedDiffChange,
  onLensChange,
}: {
  worktree: Worktree;
  lens: ReviewLens;
  activeMode: DiffMode | null;
  ready: boolean;
  selectedDiff: SelectedDiff | null;
  diffFiles: UseQueryResult<DiffFileSummary[], Error>;
  stagedFiles: UseQueryResult<DiffFileSummary[], Error>;
  unstagedFiles: UseQueryResult<DiffFileSummary[], Error>;
  onSelectedDiffChange: (next: SelectedDiff | null) => void;
  onLensChange: (lens: ReviewLens) => void;
}) {
  if (lens === "local") {
    return (
      <LocalFileSections
        stagedFiles={stagedFiles.data ?? []}
        unstagedFiles={unstagedFiles.data ?? []}
        stagedLoading={stagedFiles.isFetching}
        unstagedLoading={unstagedFiles.isFetching}
        stagedError={stagedFiles.error}
        unstagedError={unstagedFiles.error}
        selectedDiff={selectedDiff}
        onSelect={onSelectedDiffChange}
      />
    );
  }
  if (!ready) return <div className="wt-empty">비교할 ref를 선택하세요.</div>;
  if (diffFiles.isFetching) {
    return (
      <div className="wt-empty">
        <Spinner />
      </div>
    );
  }
  if (diffFiles.error) return <div className="wt-err">{diffFiles.error.message}</div>;
  if ((diffFiles.data?.length ?? 0) === 0) {
    return (
      <LensEmptyState lens={activeMode ?? "working"} worktree={worktree} onSwitch={onLensChange} />
    );
  }

  return (diffFiles.data ?? []).map((f) => (
    <FileRow
      key={`${activeMode}:${f.path}`}
      file={f}
      source={activeMode ?? "working"}
      active={selectedDiff?.path === f.path && selectedDiff.mode === activeMode}
      onSelect={() => activeMode && onSelectedDiffChange({ path: f.path, mode: activeMode })}
    />
  ));
}
