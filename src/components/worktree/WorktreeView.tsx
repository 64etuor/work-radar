import { useCallback, useMemo, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { GitCompare, PanelLeftClose, PanelLeftOpen, RefreshCw, Trash2, Waypoints } from "lucide-react";
import {
  chooseInitialReviewLens,
  diffContextLabel,
  type ReviewLens,
} from "@/lib/worktreeReview";
import type { DiffMode, Worktree } from "@/bindings";
import {
  useProjects,
  useWorktreeBranches,
  useWorktreeDiffFiles,
  useWorktreeFileDiff,
  useWorktrees,
} from "@/lib/query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStickyToggle } from "@/lib/useStickyToggle";
import { CleanupPanel } from "./CleanupPanel";
import { CommitGraphDrawer } from "./CommitGraphDrawer";
import { LocalFileSections, FileRow, type SelectedDiff } from "./WorktreeFileList";
import { DiffText } from "./WorktreeDiffText";
import { LensEmptyState, ReviewSummary } from "./WorktreeReviewPanel";
import { RebaseBar } from "./RebaseBar";
import { WorktreeSideList } from "./WorktreeSideList";

/** radix Select는 빈 문자열 value를 허용하지 않는다 → "전체"/"선택 안 함"은 센티넬로(write 시 null 매핑). */
const PROJECT_ALL = "__all__";
const REF_NONE = "__none__";

/** Review Cockpit lenses: 사람 작업 단위 라벨을 앞세우고 Git plumbing은 설명으로 낮춘다. */
const REVIEW_LENSES: { key: ReviewLens; label: string }[] = [
  { key: "local", label: "Local" },
  { key: "working", label: "Unstaged" },
  { key: "staged", label: "Staged" },
  { key: "vs_base", label: "Branch vs base" },
  { key: "branch_branch", label: "Compare refs" },
];

const SOURCE_LABEL: Record<DiffMode, string> = {
  working: "unstaged",
  staged: "staged",
  vs_base: "branch",
  branch_branch: "compare",
};

/**
 * Worktree & Branch Diff Viewer (Phase 5, read-only — INVARIANT #6).
 * 멀티 repo worktree를 상태 배지(ahead/behind/dirty)와 함께 나열하고, 4종 비교 모드로 파일 목록 +
 * 파일별 diff를 본다. 대용량 비차단 = 파일목록 먼저 + 선택 파일만 지연 로드. git 접근은 Rust(셸아웃).
 */
export function WorktreeView() {
  const projects = useProjects();
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
    selected && (lens === "vs_base" || lens === "branch_branch")
      ? selected.path
      : null,
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
    baseRef: selectedDiff?.mode === "vs_base" || selectedDiff?.mode === "branch_branch" ? baseRef : null,
    headRef: selectedDiff?.mode === "branch_branch" ? headRef : null,
    path: selectedDiff?.path ?? null,
    ready: selectedDiffReady && !!selectedDiff,
  });

  // worktree 선택 시 모드/ref/파일 초기화.
  // 스마트 기본: dirty(미커밋 변경 있음) → working 모드(즉시 표시).
  // 아닌 경우(에이전트가 커밋 완료한 브랜치) → vs_base 모드 + baseRef=baseBranch
  //   (브랜치의 커밋된 divergence를 기본으로 표시 — 수동 ref 선택 불필요).
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

  // repo_label로 그룹핑(멀티 repo 동시 표시).
  const grouped = useMemo(() => {
    const g = new Map<string, Worktree[]>();
    for (const w of list) {
      const arr = g.get(w.repoLabel) ?? [];
      arr.push(w);
      g.set(w.repoLabel, arr);
    }
    return [...g.entries()];
  }, [list]);

  const branchList = branches.data ?? [];

  // 정리 패널은 선택 worktree(없으면 primary)의 repo를 대상으로 한다.
  const cleanupRepo = selected ?? list.find((w) => w.isPrimary) ?? list[0] ?? null;
  const branchFileCount = branchFiles.data?.length ?? null;
  const fileCount =
    lens === "local"
      ? (stagedFiles.data?.length ?? 0) + (unstagedFiles.data?.length ?? 0)
      : (diffFiles.data?.length ?? 0);

  return (
    <div className="wt">
      <header className="wt-head" data-tauri-drag-region>
        <span className="wt-title">Worktree Diff</span>
        <Select
          value={projectFilter ?? PROJECT_ALL}
          onValueChange={(v) => {
            setProjectFilter(v === PROJECT_ALL ? null : v);
            setSelectedPath(null);
            setSelectedDiff(null);
          }}
        >
          <SelectTrigger
            className="ml-auto w-auto min-w-[150px] text-[12px]"
            aria-label="프로젝트 필터"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROJECT_ALL}>전체 프로젝트</SelectItem>
            {(projects.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} ({p.kind === "personal" ? "개인" : "업무"})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={graphOpen ? "default" : "outline"}
          size="sm"
          className="gap-1.5 rounded-full text-[12px]"
          onClick={() => setGraphOpen((v) => !v)}
          disabled={!selected}
          title={selected ? "커밋 그래프 보기" : "worktree 선택 필요"}
        >
          <Waypoints className="size-3.5" />
          Graph
        </Button>
        <Button
          variant={showCleanup ? "default" : "outline"}
          size="sm"
          className="gap-1.5 rounded-full text-[12px]"
          onClick={() => setShowCleanup((s) => !s)}
          disabled={!cleanupRepo}
          title="브랜치/워크트리 정리"
        >
          <Trash2 className="size-3.5" />
          정리
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="size-8 shrink-0 rounded-full p-0 text-wr-muted"
          onClick={() => void worktrees.refetch()}
          title="새로고침"
        >
          <RefreshCw
            className={`size-3.5${worktrees.isFetching ? " wt-spin" : ""}`}
          />
        </Button>
      </header>

      {showCleanup && cleanupRepo && (
        <CleanupPanel
          repoPath={cleanupRepo.path}
          base={cleanupRepo.baseBranch}
          onClose={() => setShowCleanup(false)}
        />
      )}

      <div className="wt-body">
        {/* 좌: worktree 목록 (접기 가능) */}
        <WorktreeSideList
          collapsed={sideCollapsed}
          onCollapsedChange={setSideCollapsed}
          error={worktrees.error}
          isLoading={worktrees.isLoading}
          list={list}
          grouped={grouped}
          selectedPath={selectedPath}
          onSelect={selectWorktree}
        />

        {/* 우: 비교 모드 + 파일 목록 + 파일 diff */}
        <main className="wt-main">
          {!selected ? (
            <div className="wt-placeholder">
              <GitCompare className="size-5" />
              <span>worktree를 선택하면 변경 파일과 diff를 봅니다.</span>
            </div>
          ) : (
            <>
              <ReviewSummary worktree={selected} branchFileCount={branchFileCount} />

              <div className="wt-modes">
                <div className="wt-review-tabs" role="tablist" aria-label="Review lens">
                  {REVIEW_LENSES.map((m) => (
                    <Button
                      key={m.key}
                      variant={lens === m.key ? "default" : "outline"}
                      size="sm"
                      className="rounded-full text-[12px]"
                      aria-pressed={lens === m.key}
                      role="tab"
                      onClick={() => changeLens(m.key)}
                    >
                      {m.key === "vs_base" && selected.baseBranch
                        ? `Branch vs ${selected.baseBranch}`
                        : m.label}
                    </Button>
                  ))}
                </div>
                <div className="wt-maintenance">
                  <span className="wt-maintenance-label">Maintenance</span>
                  <RebaseBar worktree={selected} onReviewBase={() => changeLens("vs_base")} />
                </div>
              </div>

              {/* ref picker (vs_base = base, branch↔branch = base + head) */}
              {(lens === "vs_base" || lens === "branch_branch") && (
                <div className="wt-refs">
                  <label className="wt-ref">
                    <span>base</span>
                    <Select
                      value={baseRef ?? REF_NONE}
                      onValueChange={(v) => {
                        setBaseRef(v === REF_NONE ? null : v);
                        setSelectedDiff(null);
                      }}
                    >
                      <SelectTrigger className="w-[150px] text-[12px]" aria-label="base ref">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={REF_NONE}>선택…</SelectItem>
                        {branchList.map((b) => (
                          <SelectItem key={b} value={b}>
                            {b}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {lens === "branch_branch" && (
                    <label className="wt-ref">
                      <span>head</span>
                      <Select
                        value={headRef ?? REF_NONE}
                        onValueChange={(v) => {
                          setHeadRef(v === REF_NONE ? null : v);
                          setSelectedDiff(null);
                        }}
                      >
                        <SelectTrigger className="w-[150px] text-[12px]" aria-label="head ref">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={REF_NONE}>선택…</SelectItem>
                          {branchList.map((b) => (
                            <SelectItem key={b} value={b}>
                              {b}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  )}
                  {lens === "vs_base" && (
                    <span className="wt-ref-hint">base...HEAD (3-dot)</span>
                  )}
                </div>
              )}

              <div className="wt-split">
                {/* 파일 목록(통계 먼저) — 접기 가능 */}
                {filesCollapsed ? (
                  <button
                    type="button"
                    className="wt-rail"
                    onClick={() => setFilesCollapsed(false)}
                    title="파일 목록 펼치기"
                  >
                    <PanelLeftOpen className="size-4" />
                    <span className="wt-rail-label">
                      Files
                      {fileCount > 0 ? ` (${fileCount})` : ""}
                    </span>
                  </button>
                ) : (
                <div className="wt-files">
                  <div className="wt-panel-head">
                    <span className="wt-panel-title">
                      Files
                      {fileCount > 0 ? ` (${fileCount})` : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-6 shrink-0 p-0 text-wr-muted"
                      onClick={() => setFilesCollapsed(true)}
                      title="패널 접기"
                    >
                      <PanelLeftClose className="size-3.5" />
                    </Button>
                  </div>
                  {lens === "local" ? (
                    <LocalFileSections
                      stagedFiles={stagedFiles.data ?? []}
                      unstagedFiles={unstagedFiles.data ?? []}
                      stagedLoading={stagedFiles.isFetching}
                      unstagedLoading={unstagedFiles.isFetching}
                      stagedError={stagedFiles.error}
                      unstagedError={unstagedFiles.error}
                      selectedDiff={selectedDiff}
                      onSelect={(next) => setSelectedDiff(next)}
                    />
                  ) : !ready ? (
                    <div className="wt-empty">비교할 ref를 선택하세요.</div>
                  ) : diffFiles.isFetching ? (
                    <div className="wt-empty">
                      <Spinner />
                    </div>
                  ) : diffFiles.error ? (
                    <div className="wt-err">
                      {(diffFiles.error as Error).message}
                    </div>
                  ) : (diffFiles.data?.length ?? 0) === 0 ? (
                    <LensEmptyState
                      lens={activeMode ?? "working"}
                      worktree={selected}
                      onSwitch={changeLens}
                    />
                  ) : (
                    (diffFiles.data ?? []).map((f) => (
                      <FileRow
                        key={`${activeMode}:${f.path}`}
                        file={f}
                        source={activeMode ?? "working"}
                        active={
                          selectedDiff?.path === f.path &&
                          selectedDiff.mode === activeMode
                        }
                        onSelect={() =>
                          activeMode &&
                          setSelectedDiff({ path: f.path, mode: activeMode })
                        }
                      />
                    ))
                  )}
                </div>
                )}

                {/* 파일별 diff(지연 로드) */}
                <div className="wt-diff">
                  {!selectedDiff ? (
                    <div className="wt-empty">파일을 선택하면 diff를 봅니다.</div>
                  ) : fileDiff.isFetching ? (
                    <div className="wt-empty">diff 로드 중…</div>
                  ) : fileDiff.error ? (
                    <div className="wt-err">
                      {(fileDiff.error as Error).message}
                    </div>
                  ) : (
                    <>
                      <div className="wt-diff-context">
                        <span className={`wt-source wt-source-${selectedDiff.mode}`}>
                          {SOURCE_LABEL[selectedDiff.mode]}
                        </span>
                        <span className="wt-diff-path">{selectedDiff.path}</span>
                        <span className="wt-diff-mode">
                          {diffContextLabel(selectedDiff.mode)}
                        </span>
                      </div>
                      <DiffText text={fileDiff.data ?? ""} path={selectedDiff.path} />
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
        {selected && graphOpen && (
          <CommitGraphDrawer
            worktree={selected}
            baseRef={baseRef ?? selected.baseBranch}
            onClose={closeGraph}
          />
        )}
      </div>
    </div>
  );
}
