import { useCallback, useMemo, useState } from "react";
import "./WorktreeView.css";
import type { DiffMode, Worktree } from "@/bindings";
import {
  useProjects,
  useTriggerCodexJob,
  useWorktreeBranches,
  useWorktreeDiffFiles,
  useWorktreeFileDiff,
  useWorktrees,
} from "@/lib/query";
import { useStickyToggle } from "@/lib/useStickyToggle";
import { chooseInitialReviewLens, type ReviewLens } from "@/lib/worktreeReview";
import { useUIStore } from "@/store";
import { CleanupPanel } from "./CleanupPanel";
import { type SelectedDiff } from "./WorktreeFileList";
import { WorktreeBody } from "./WorktreeBody";
import { WorktreeHeader } from "./WorktreeHeader";

/**
 * Worktree & Branch Diff Viewer (Phase 5, read-only — INVARIANT #6).
 * Container owns query/state orchestration; child sections render workflow surfaces from props.
 */
export function WorktreeView() {
  const projects = useProjects();
  const { goTo } = useUIStore();
  const reviewJob = useTriggerCodexJob();
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  // 12c: live=true → dirty/ahead/behind + 활성 변경 활동을 bounded 주기로 자동 갱신.
  const worktrees = useWorktrees(null, true);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [lens, setLens] = useState<ReviewLens>("local");
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [headRef, setHeadRef] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
  const [showCleanup, setShowCleanup] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const closeGraph = useCallback(() => setGraphOpen(false), []);
  // 패널 접기(레이아웃 선호 — localStorage로 세션 간 유지). diff 본문은 항상 표시.
  const [sideCollapsed, setSideCollapsed] = useStickyToggle("wt-side-collapsed");
  const [filesCollapsed, setFilesCollapsed] = useStickyToggle("wt-files-collapsed");

  const list = useMemo(() => {
    const raw = worktrees.data ?? [];
    if (!projectFilter) return raw;
    return raw.filter((w) => w.projectId === projectFilter);
  }, [worktrees.data, projectFilter]);
  const selected = list.find((w) => w.path === selectedPath) ?? null;

  // 모드별 ref 준비 상태: working/staged는 항상, vs_base는 base, branch↔branch는 base+head.
  const modeReady = (m: DiffMode) =>
    m === "working" ||
    m === "staged" ||
    (m === "vs_base" && !!baseRef) ||
    (m === "branch_branch" && !!baseRef && !!headRef);
  const activeMode = lens === "local" ? null : lens;
  const ready = activeMode ? modeReady(activeMode) : true;

  const branches = useWorktreeBranches(
    selected && (lens === "vs_base" || lens === "branch_branch") ? selected.path : null,
  );

  const diffFiles = useWorktreeDiffFiles({
    worktreePath: selected?.path ?? null,
    mode: activeMode ?? "working",
    baseRef,
    headRef,
    ready: !!activeMode && ready,
  });

  const unstagedFiles = useWorktreeDiffFiles({
    worktreePath: selected?.path ?? null,
    mode: "working",
    baseRef: null,
    headRef: null,
    ready: lens === "local" && !!selected,
  });

  const stagedFiles = useWorktreeDiffFiles({
    worktreePath: selected?.path ?? null,
    mode: "staged",
    baseRef: null,
    headRef: null,
    ready: lens === "local" && !!selected,
  });

  const branchFiles = useWorktreeDiffFiles({
    worktreePath: selected?.path ?? null,
    mode: "vs_base",
    baseRef,
    headRef: null,
    ready: !!selected && !!baseRef,
  });

  const selectedDiffReady = selectedDiff ? modeReady(selectedDiff.mode) : false;
  const fileDiff = useWorktreeFileDiff({
    worktreePath: selected?.path ?? null,
    mode: selectedDiff?.mode ?? "working",
    baseRef:
      selectedDiff?.mode === "vs_base" || selectedDiff?.mode === "branch_branch" ? baseRef : null,
    headRef: selectedDiff?.mode === "branch_branch" ? headRef : null,
    path: selectedDiff?.path ?? null,
    ready: selectedDiffReady && !!selectedDiff,
  });

  function selectWorktree(w: Worktree) {
    setSelectedPath(w.path);
    setBaseRef(w.baseBranch);
    setHeadRef(null);
    setSelectedDiff(null);
    setGraphOpen(false);
    setLens(chooseInitialReviewLens(w));
  }

  function changeLens(next: ReviewLens) {
    setLens(next);
    setSelectedDiff(null);
    if ((next === "vs_base" || next === "local") && selected && !baseRef) {
      setBaseRef(selected.baseBranch);
    }
  }

  function changeProjectFilter(next: string | null) {
    setProjectFilter(next);
    setSelectedPath(null);
    setSelectedDiff(null);
  }

  function startWorktreeReview() {
    if (!selected || reviewJob.isPending) return;
    const prompt = [
      "You are reviewing a worktree in read-only mode.",
      "Focus on architectural issues, risky changes, dead code, dependency impact, missing tests, and merge conflict risk.",
      "Do not edit files. Return a concise Korean review with findings ordered by severity and concrete file references when available.",
      `Worktree path: ${selected.path}`,
      `Branch: ${selected.branch ?? "(detached)"}`,
      `Base: ${selected.baseBranch}`,
    ].join("\n");
    reviewJob.mutate(
      {
        projectId: selected.projectId,
        repoId: selected.repoId,
        agentPromptBinding: "worktree_review",
        prompt,
        timeoutSec: 180,
        maxTurns: 10,
        costCapUsd: 1.5,
      },
      { onSuccess: () => goTo("jobs") },
    );
  }

  const grouped = useMemo(() => {
    const g = new Map<string, Worktree[]>();
    for (const w of list) {
      const arr = g.get(w.repoLabel) ?? [];
      arr.push(w);
      g.set(w.repoLabel, arr);
    }
    return [...g.entries()];
  }, [list]);

  const cleanupRepo = selected ?? list.find((w) => w.isPrimary) ?? list[0] ?? null;
  const branchFileCount = branchFiles.data?.length ?? null;
  const fileCount =
    lens === "local"
      ? (stagedFiles.data?.length ?? 0) + (unstagedFiles.data?.length ?? 0)
      : (diffFiles.data?.length ?? 0);

  return (
    <div className="wt">
      <WorktreeHeader
        projects={projects.data ?? []}
        projectFilter={projectFilter}
        graph={{
          enabled: !!selected,
          active: graphOpen,
          onToggle: () => setGraphOpen((v) => !v),
        }}
        cleanup={{
          enabled: !!cleanupRepo,
          active: showCleanup,
          onToggle: () => setShowCleanup((s) => !s),
        }}
        worktreesFetching={worktrees.isFetching}
        onProjectFilterChange={changeProjectFilter}
        onRefresh={() => void worktrees.refetch()}
      />

      {showCleanup && cleanupRepo && (
        <CleanupPanel
          repoPath={cleanupRepo.path}
          base={cleanupRepo.baseBranch}
          onClose={() => setShowCleanup(false)}
        />
      )}

      <WorktreeBody
        sidebar={{
          collapsed: sideCollapsed,
          error: worktrees.error,
          isLoading: worktrees.isLoading,
          list,
          grouped,
          selectedPath,
        }}
        review={{
          selected,
          branchFileCount,
          branchList: branches.data ?? [],
          lens,
          activeMode,
          ready,
          baseRef,
          headRef,
          fileCount,
          filesCollapsed,
          selectedDiff,
          graphOpen,
          reviewing: reviewJob.isPending,
        }}
        queries={{ diffFiles, stagedFiles, unstagedFiles, fileDiff }}
        actions={{
          onSidebarCollapsedChange: setSideCollapsed,
          onSelectWorktree: selectWorktree,
          onLensChange: changeLens,
          onBaseRefChange: (ref) => {
            setBaseRef(ref);
            setSelectedDiff(null);
          },
          onHeadRefChange: (ref) => {
            setHeadRef(ref);
            setSelectedDiff(null);
          },
          onFilesCollapsedChange: setFilesCollapsed,
          onSelectedDiffChange: setSelectedDiff,
          onCloseGraph: closeGraph,
          onReviewWorktree: startWorktreeReview,
        }}
      />
    </div>
  );
}
