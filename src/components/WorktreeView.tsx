import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Spinner } from "@/components/Spinner";
import {
  GitCompare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Trash2,
  Waypoints,
} from "lucide-react";
import { detectLang, tokenizeLines, type ThemedToken } from "@/lib/shiki";

import type {
  CleanupCandidate,
  DiffFileSummary,
  DiffMode,
  FileChange,
  Worktree,
} from "@/bindings";
import {
  useCleanupCandidates,
  useDeleteCleanupCandidates,
  useProjects,
  useRebaseWorktree,
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

/** radix Select는 빈 문자열 value를 허용하지 않는다 → "전체"/"선택 안 함"은 센티넬로(write 시 null 매핑). */
const PROJECT_ALL = "__all__";
const REF_NONE = "__none__";

/** 4종 비교 모드 라벨 (PLAN.md Phase 5). */
const MODES: { key: DiffMode; label: string }[] = [
  { key: "working", label: "Working" },
  { key: "staged", label: "Staged" },
  { key: "vs_base", label: "vs Base" },
  { key: "branch_branch", label: "Branch↔Branch" },
];

const FILE_STATUS_LABEL: Record<FileChange, string> = {
  M: "수정",
  A: "추가",
  D: "삭제",
  R: "이름변경",
};

/** 패널 접힘 상태를 localStorage에 유지하는 토글 훅(레이아웃 선호 보존). */
function useStickyToggle(key: string): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* private mode 등 — 무시 */
    }
  };
  return [on, set];
}

/**
 * Worktree & Branch Diff Viewer (Phase 5, read-only — INVARIANT #6).
 * 멀티 repo worktree를 상태 배지(ahead/behind/dirty)와 함께 나열하고, 4종 비교 모드로 파일 목록 +
 * 파일별 diff를 본다. 대용량 비차단 = 파일목록 먼저 + 선택 파일만 지연 로드. git 접근은 Rust(셸아웃).
 */
export function WorktreeView() {
  const projects = useProjects();
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  // 12c: live=true → dirty/ahead/behind + 활성 변경 활동을 bounded 주기로 자동 갱신.
  const worktrees = useWorktrees(projectFilter, true);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("working");
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [headRef, setHeadRef] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showCleanup, setShowCleanup] = useState(false);
  // 패널 접기(레이아웃 선호 — localStorage로 세션 간 유지). diff 본문은 항상 표시.
  const [sideCollapsed, setSideCollapsed] = useStickyToggle("wt-side-collapsed");
  const [filesCollapsed, setFilesCollapsed] = useStickyToggle("wt-files-collapsed");

  const list = worktrees.data ?? [];
  const selected = list.find((w) => w.path === selectedPath) ?? null;

  // 모드별 ref 준비 상태: working/staged는 항상, vs_base는 base, branch↔branch는 base+head.
  const ready =
    mode === "working" ||
    mode === "staged" ||
    (mode === "vs_base" && !!baseRef) ||
    (mode === "branch_branch" && !!baseRef && !!headRef);

  const branches = useWorktreeBranches(
    selected && (mode === "vs_base" || mode === "branch_branch")
      ? selected.path
      : null,
  );

  const diffFiles = useWorktreeDiffFiles({
    worktreePath: selected?.path ?? null,
    mode,
    baseRef,
    headRef,
    ready,
  });

  const fileDiff = useWorktreeFileDiff({
    worktreePath: selected?.path ?? null,
    mode,
    baseRef,
    headRef,
    path: selectedFile,
    ready: ready && !!selectedFile,
  });

  // worktree 선택 시 모드/ref/파일 초기화.
  // 스마트 기본: dirty(미커밋 변경 있음) → working 모드(즉시 표시).
  // 아닌 경우(에이전트가 커밋 완료한 브랜치) → vs_base 모드 + baseRef=baseBranch
  //   (브랜치의 커밋된 divergence를 기본으로 표시 — 수동 ref 선택 불필요).
  function selectWorktree(w: Worktree) {
    setSelectedPath(w.path);
    setBaseRef(w.baseBranch);
    setHeadRef(null);
    setSelectedFile(null);
    if (w.dirty) {
      setMode("working");
    } else {
      setMode("vs_base");
    }
  }

  function changeMode(m: DiffMode) {
    setMode(m);
    setSelectedFile(null);
    if (m === "vs_base" && selected && !baseRef) setBaseRef(selected.baseBranch);
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

  return (
    <div className="wt">
      <header className="wt-head" data-tauri-drag-region>
        <span className="wt-title">Worktree Diff</span>
        <Select
          value={projectFilter ?? PROJECT_ALL}
          onValueChange={(v) => {
            setProjectFilter(v === PROJECT_ALL ? null : v);
            setSelectedPath(null);
            setSelectedFile(null);
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
        {sideCollapsed ? (
          <button
            type="button"
            className="wt-rail"
            onClick={() => setSideCollapsed(false)}
            title="Worktree 목록 펼치기"
          >
            <PanelLeftOpen className="size-4" />
            <span className="wt-rail-label">Worktrees</span>
          </button>
        ) : (
          <aside className="wt-side">
            <div className="wt-panel-head">
              <span className="wt-panel-title">Worktrees</span>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 shrink-0 p-0 text-wr-muted"
                onClick={() => setSideCollapsed(true)}
                title="패널 접기"
              >
                <PanelLeftClose className="size-3.5" />
              </Button>
            </div>
          {worktrees.error && (
            <div className="wt-err">{(worktrees.error as Error).message}</div>
          )}
          {!worktrees.isLoading && list.length === 0 && !worktrees.error && (
            <div className="wt-empty">
              표시할 worktree가 없습니다 — 설정에서 local 경로가 있는 레포를 추가하세요.
            </div>
          )}
          {grouped.map(([label, wts]) => (
            <section key={label} className="wt-group">
              <div className="wt-group-name">{label}</div>
              {wts.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={`wt-item${w.path === selectedPath ? " wt-item-on" : ""}`}
                  onClick={() => selectWorktree(w)}
                >
                  <div className="wt-item-top">
                    <span className="wt-branch">{w.branch ?? "(detached)"}</span>
                    {w.isPrimary && <span className="wt-primary">main</span>}
                  </div>
                  <div className="wt-item-badges">
                    <StatusBadges w={w} />
                  </div>
                </button>
              ))}
            </section>
          ))}
          </aside>
        )}

        {/* 우: 비교 모드 + 파일 목록 + 파일 diff */}
        <main className="wt-main">
          {!selected ? (
            <div className="wt-placeholder">
              <GitCompare className="size-5" />
              <span>worktree를 선택하면 변경 파일과 diff를 봅니다.</span>
            </div>
          ) : (
            <>
              <div className="wt-modes">
                {MODES.map((m) => (
                  <Button
                    key={m.key}
                    variant={mode === m.key ? "default" : "outline"}
                    size="sm"
                    className="rounded-full text-[12px]"
                    aria-pressed={mode === m.key}
                    onClick={() => changeMode(m.key)}
                  >
                    {m.label}
                  </Button>
                ))}
                <RebaseBar worktree={selected} onReviewBase={() => changeMode("vs_base")} />
              </div>

              {/* ref picker (vs_base = base, branch↔branch = base + head) */}
              {(mode === "vs_base" || mode === "branch_branch") && (
                <div className="wt-refs">
                  <label className="wt-ref">
                    <span>base</span>
                    <Select
                      value={baseRef ?? REF_NONE}
                      onValueChange={(v) => {
                        setBaseRef(v === REF_NONE ? null : v);
                        setSelectedFile(null);
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
                  {mode === "branch_branch" && (
                    <label className="wt-ref">
                      <span>head</span>
                      <Select
                        value={headRef ?? REF_NONE}
                        onValueChange={(v) => {
                          setHeadRef(v === REF_NONE ? null : v);
                          setSelectedFile(null);
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
                  {mode === "vs_base" && (
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
                      {(diffFiles.data?.length ?? 0) > 0
                        ? ` (${diffFiles.data?.length})`
                        : ""}
                    </span>
                  </button>
                ) : (
                <div className="wt-files">
                  <div className="wt-panel-head">
                    <span className="wt-panel-title">
                      Files
                      {(diffFiles.data?.length ?? 0) > 0
                        ? ` (${diffFiles.data?.length})`
                        : ""}
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
                  {!ready && (
                    <div className="wt-empty">비교할 ref를 선택하세요.</div>
                  )}
                  {ready && diffFiles.isFetching && (
                    <div className="wt-empty">
                      <Spinner />
                    </div>
                  )}
                  {ready && diffFiles.error && (
                    <div className="wt-err">
                      {(diffFiles.error as Error).message}
                    </div>
                  )}
                  {ready &&
                    !diffFiles.isFetching &&
                    (diffFiles.data?.length ?? 0) === 0 &&
                    !diffFiles.error && (
                      <div className="wt-empty">변경 파일이 없습니다.</div>
                    )}
                  {(diffFiles.data ?? []).map((f) => (
                    <FileRow
                      key={f.path}
                      file={f}
                      active={f.path === selectedFile}
                      onSelect={() => setSelectedFile(f.path)}
                    />
                  ))}
                </div>
                )}

                {/* 파일별 diff(지연 로드) */}
                <div className="wt-diff">
                  {!selectedFile ? (
                    <div className="wt-empty">파일을 선택하면 diff를 봅니다.</div>
                  ) : fileDiff.isFetching ? (
                    <div className="wt-empty">diff 로드 중…</div>
                  ) : fileDiff.error ? (
                    <div className="wt-err">
                      {(fileDiff.error as Error).message}
                    </div>
                  ) : (
                    <DiffText text={fileDiff.data ?? ""} path={selectedFile} />
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * newestMtime(ISO 문자열 또는 null) → 한국어 상대시간 레이블.
 * activeChange=true(90초 이내)면 "작업중" 펄스를 별도 배지로 표시.
 * 그 외 최근 변경이 있으면 "N분 전 변경" / "N시간 전 변경" 등 정직한 상대시간.
 * newestMtime 없으면 빈 문자열(배지 미표시).
 */
function relativeActivity(newestMtime: string | null): string {
  if (!newestMtime) return "";
  const diffMs = Date.now() - new Date(newestMtime).getTime();
  if (diffMs < 0) return ""; // 미래 mtime — 시계 왜곡, 표시 안 함
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "방금 변경";
  if (diffMin < 60) return `${diffMin}분 전 변경`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전 변경`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}일 전 변경`;
}

/** worktree 상태 배지: 활성 펄스(90초 이내) / 상대시간 / dirty / +ahead / -behind / clean. */
function StatusBadges({ w }: { w: Worktree }) {
  const activityLabel = relativeActivity(w.newestMtime);
  return (
    <>
      {w.activeChange && (
        <span className="wt-badge wt-active" title="90초 이내 파일 변경 — 방금 작업함">
          <span className="wt-active-dot" />
          작업중
        </span>
      )}
      {!w.activeChange && activityLabel && (
        <span className="wt-badge wt-idle" title={`마지막 파일 변경: ${w.newestMtime ?? ""}`}>
          {activityLabel}
        </span>
      )}
      {w.dirty && <span className="wt-badge wt-dirty">dirty</span>}
      {w.ahead > 0 && <span className="wt-badge wt-ahead">↑{w.ahead}</span>}
      {w.behind > 0 && <span className="wt-badge wt-behind">↓{w.behind}</span>}
      {!w.dirty && w.ahead === 0 && w.behind === 0 && (
        <span className="wt-badge wt-clean">clean</span>
      )}
    </>
  );
}

/**
 * 안전 dev rebase 액션 (Phase 12c). dirty면 백엔드가 거부, 충돌이면 자동 abort+복구.
 * 성공 후 사용자는 "vs Base" 모드로 결과를 검수한다(onReviewBase).
 */
function RebaseBar({
  worktree,
  onReviewBase,
}: {
  worktree: Worktree;
  onReviewBase: () => void;
}) {
  const rebase = useRebaseWorktree();
  const base = "origin/dev";

  function run() {
    if (rebase.isPending) return;
    if (
      !window.confirm(
        `${worktree.branch ?? "(detached)"} 를 ${base} 위로 rebase합니다.\n` +
          "미커밋 변경이 있으면 거부되고, 충돌 시 자동으로 원상복구됩니다. 계속할까요?",
      )
    )
      return;
    rebase.mutate(
      { worktreePath: worktree.path, base },
      {
        onSuccess: (res) => {
          if (res.success) onReviewBase();
        },
      },
    );
  }

  const result = rebase.data;
  return (
    <div className="wt-rebase">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 rounded-full text-[12px]"
        onClick={run}
        disabled={rebase.isPending || worktree.dirty}
        title={
          worktree.dirty
            ? "미커밋 변경이 있어 rebase할 수 없습니다"
            : `${base} 위로 안전 rebase`
        }
      >
        <Waypoints className="size-3.5" />
        {rebase.isPending ? "rebase 중…" : `${base} rebase`}
      </Button>
      {rebase.error && (
        <span className="wt-rebase-msg wt-rebase-err">
          {(rebase.error as Error).message}
        </span>
      )}
      {result && (
        <span
          className={`wt-rebase-msg${result.success ? " wt-rebase-ok" : " wt-rebase-err"}`}
        >
          {result.success ? "rebase 성공 — vs Base로 검수하세요." : result.message}
        </span>
      )}
    </div>
  );
}

const CLEANUP_KIND_LABEL: Record<CleanupCandidate["kind"], string> = {
  merged_branch: "머지됨",
  stale_branch: "오래됨",
  prunable_worktree: "prune",
};

/**
 * 브랜치/워크트리 정리 패널 (Phase 12d). merged/stale 브랜치 + prunable worktree를 다중 선택해
 * 확인 후 삭제. 보호 항목(현재/base/dirty)은 선택 불가, 미머지는 force 토글이 켜져야 선택 가능.
 */
function CleanupPanel({
  repoPath,
  base,
  onClose,
}: {
  repoPath: string;
  base: string;
  onClose: () => void;
}) {
  const candidates = useCleanupCandidates(repoPath, base);
  const del = useDeleteCleanupCandidates();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [force, setForce] = useState(false);

  const list = candidates.data ?? [];

  // 선택 가능 = 비보호 && (force 불필요 || force 켜짐).
  function selectable(c: CleanupCandidate): boolean {
    return !c.protected && (!c.needsForce || force);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run() {
    const ids = [...selected];
    if (ids.length === 0 || del.isPending) return;
    if (!window.confirm(`${ids.length}개 항목을 삭제합니다. 계속할까요?`)) return;
    del.mutate(
      { repoPath, base, ids, force },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  return (
    <div className="wt-cleanup">
      <div className="wt-cleanup-head">
        <span className="wt-cleanup-title">브랜치 / 워크트리 정리</span>
        <span className="wt-cleanup-base">기준: {base}</span>
        <label className="wt-cleanup-force">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => {
              setForce(e.target.checked);
              if (!e.target.checked) {
                // force 끄면 force-필요 항목 선택 해제.
                setSelected((prev) => {
                  const next = new Set(prev);
                  for (const c of list) {
                    if (c.needsForce && next.has(c.id)) next.delete(c.id);
                  }
                  return next;
                });
              }
            }}
          />
          미머지 강제 삭제(force)
        </label>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto rounded-full text-[12px]"
          onClick={onClose}
        >
          닫기
        </Button>
      </div>

      {candidates.isLoading && (
        <div className="wt-empty">
          <Spinner />
        </div>
      )}
      {candidates.error && (
        <div className="wt-err">{(candidates.error as Error).message}</div>
      )}
      {!candidates.isLoading && list.length === 0 && !candidates.error && (
        <div className="wt-empty">정리할 후보가 없습니다.</div>
      )}

      <div className="wt-cleanup-list">
        {list.map((c) => {
          const can = selectable(c);
          return (
            <label
              key={c.id}
              className={`wt-cleanup-row${can ? "" : " wt-cleanup-locked"}`}
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                disabled={!can}
                onChange={() => toggle(c.id)}
              />
              <span className={`wt-cleanup-kind wt-ck-${c.kind}`}>
                {CLEANUP_KIND_LABEL[c.kind]}
              </span>
              <span className="wt-cleanup-name">{c.name}</span>
              <span className="wt-cleanup-detail">{c.detail}</span>
            </label>
          );
        })}
      </div>

      <div className="wt-cleanup-foot">
        <Button
          variant="destructiveOutline"
          size="sm"
          className="gap-1.5 rounded-full text-[12px]"
          onClick={run}
          disabled={selected.size === 0 || del.isPending}
        >
          <Trash2 className="size-3.5" />
          {del.isPending ? "삭제 중…" : `선택 ${selected.size}개 삭제`}
        </Button>
        {del.error && (
          <span className="wt-cleanup-msg wt-rebase-err">
            {(del.error as Error).message}
          </span>
        )}
        {del.data && <span className="wt-cleanup-msg">{del.data}</span>}
      </div>
    </div>
  );
}

function FileRow({
  file,
  active,
  onSelect,
}: {
  file: DiffFileSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`wt-file${active ? " wt-file-on" : ""}`}
      onClick={onSelect}
    >
      <span className={`wt-fstatus wt-fs-${file.status}`} title={FILE_STATUS_LABEL[file.status]}>
        {file.status}
      </span>
      <span className="wt-fpath">
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      {file.binary ? (
        <span className="wt-fbin">bin</span>
      ) : (
        <span className="wt-fstat">
          <span className="wt-adds">+{file.adds}</span>
          <span className="wt-dels">−{file.dels}</span>
        </span>
      )}
    </button>
  );
}

/** 표시 줄 상한 — 초과분은 비차단 위해 잘라 표시(전체는 외부 도구로). */
const MAX_DIFF_LINES = 6000;
/** 줄 묶음 단위 — content-visibility로 오프스크린 블록을 저렴하게 가상화. */
const BLOCK = 240;

/** 구문 강조를 적용할 코드 줄 수 상한 — 초과 시 평문(diff 색상만)으로 비차단 유지. */
const SYNTAX_MAX_LINES = 4000;

type ParsedDiffLine = {
  kind: "code" | "meta";
  cls: string;
  marker: string; // 코드 줄의 +/-/space, 메타 줄은 ""
  raw: string;
};

/** unified diff 한 줄을 분류하고 코드 줄은 마커(1글자) + 본문으로 분리. */
function parseDiffLine(raw: string): ParsedDiffLine {
  const cls = diffLineClass(raw);
  if (cls === "wt-l-add" || cls === "wt-l-del" || cls === "wt-l-ctx") {
    return { kind: "code", cls, marker: raw.slice(0, 1), raw };
  }
  return { kind: "meta", cls, marker: "", raw };
}

/** Shiki ThemedToken.fontStyle 비트마스크(1 italic / 2 bold / 4 underline) → React 스타일. */
function tokenStyle(t: ThemedToken): CSSProperties {
  const s: CSSProperties = { color: t.color };
  const fs = t.fontStyle ?? 0;
  if (fs & 1) s.fontStyle = "italic";
  if (fs & 2) s.fontWeight = 600;
  if (fs & 4) s.textDecoration = "underline";
  return s;
}

/**
 * unified diff 텍스트를 렌더. diff 줄 배경(추가/삭제/hunk/메타)은 유지하면서, 코드 줄은
 * 파일 확장자로 감지한 언어로 Shiki 구문강조(github-light)를 입힌다. 강조 준비 전이나
 * 미지원 언어/대용량(SYNTAX_MAX_LINES 초과)이면 평문으로 폴백한다.
 * 큰 diff는 줄을 블록으로 묶고 content-visibility:auto로 오프스크린을 가상화하며,
 * MAX_DIFF_LINES 초과 시 잘라 비차단을 보장한다.
 */
function DiffText({ text, path }: { text: string; path: string | null }) {
  const allLines = useMemo(
    () => (text.length === 0 ? [] : text.split("\n")),
    [text],
  );
  const truncated = allLines.length > MAX_DIFF_LINES;

  const parsed = useMemo<ParsedDiffLine[]>(() => {
    const lines =
      allLines.length > MAX_DIFF_LINES
        ? allLines.slice(0, MAX_DIFF_LINES)
        : allLines;
    return lines.map(parseDiffLine);
  }, [allLines]);

  const lang = useMemo(() => detectLang(path), [path]);

  // 코드 줄만 모아 한 번에 토크나이즈(문맥 유지 + 단일 패스). 마커는 제외.
  const { codeText, codeIndices } = useMemo(() => {
    const indices: number[] = [];
    const texts: string[] = [];
    parsed.forEach((p, i) => {
      if (p.kind === "code") {
        indices.push(i);
        texts.push(p.raw.slice(1));
      }
    });
    return { codeText: texts.join("\n"), codeIndices: indices };
  }, [parsed]);

  // parsed 인덱스 → 토큰 줄. 강조 준비 전/미지원이면 null(평문 렌더).
  const [tokenByLine, setTokenByLine] = useState<Map<
    number,
    ThemedToken[]
  > | null>(null);

  useEffect(() => {
    setTokenByLine(null);
    if (
      !lang ||
      codeIndices.length === 0 ||
      codeIndices.length > SYNTAX_MAX_LINES
    ) {
      return;
    }
    let cancelled = false;
    void tokenizeLines(codeText, lang)
      .then((tokens) => {
        if (cancelled || tokens.length !== codeIndices.length) return;
        const map = new Map<number, ThemedToken[]>();
        codeIndices.forEach((pi, k) => map.set(pi, tokens[k]));
        setTokenByLine(map);
      })
      .catch(() => {
        /* 강조 실패 → 평문 폴백 */
      });
    return () => {
      cancelled = true;
    };
  }, [codeText, lang, codeIndices]);

  if (parsed.length === 0) {
    return <div className="wt-empty">변경 내용이 없습니다.</div>;
  }

  const blocks: ParsedDiffLine[][] = [];
  for (let i = 0; i < parsed.length; i += BLOCK) {
    blocks.push(parsed.slice(i, i + BLOCK));
  }

  return (
    <div className="wt-diff-text">
      {blocks.map((block, bi) => (
        <div key={bi} className="wt-diff-block">
          {block.map((p, li) => {
            const tokens = tokenByLine?.get(bi * BLOCK + li);
            if (p.kind === "code" && tokens) {
              return (
                <div key={li} className={`wt-line ${p.cls}`}>
                  <span className="wt-mark">{p.marker}</span>
                  {tokens.map((t, ti) => (
                    <span key={ti} style={tokenStyle(t)}>
                      {t.content}
                    </span>
                  ))}
                </div>
              );
            }
            return (
              <div key={li} className={`wt-line ${p.cls}`}>
                {p.raw || " "}
              </div>
            );
          })}
        </div>
      ))}
      {truncated && (
        <div className="wt-trunc">
          큰 diff — {MAX_DIFF_LINES.toLocaleString()}/
          {allLines.length.toLocaleString()}줄만 표시.
        </div>
      )}
    </div>
  );
}

/** 한 diff 줄 → CSS 클래스(추가/삭제/hunk/메타/컨텍스트). */
function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "wt-l-hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files")
  ) {
    return "wt-l-meta";
  }
  if (line.startsWith("+")) return "wt-l-add";
  if (line.startsWith("-")) return "wt-l-del";
  return "wt-l-ctx";
}
