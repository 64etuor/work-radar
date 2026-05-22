import { useMemo, useState } from "react";
import {
  ArrowLeft,
  GitCompare,
  RefreshCw,
  Trash2,
  Waypoints,
} from "lucide-react";

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
import { useUIStore } from "@/store";

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

/**
 * Worktree & Branch Diff Viewer (Phase 5, read-only — INVARIANT #6).
 * 멀티 repo worktree를 상태 배지(ahead/behind/dirty)와 함께 나열하고, 4종 비교 모드로 파일 목록 +
 * 파일별 diff를 본다. 대용량 비차단 = 파일목록 먼저 + 선택 파일만 지연 로드. git 접근은 Rust(셸아웃).
 */
export function WorktreeView() {
  const { goTo } = useUIStore();
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
        <button type="button" className="wt-back" onClick={() => goTo("board")}>
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="wt-title">Worktree Diff</span>
        <select
          className="wt-project"
          value={projectFilter ?? ""}
          onChange={(e) => {
            setProjectFilter(e.target.value || null);
            setSelectedPath(null);
            setSelectedFile(null);
          }}
        >
          <option value="">전체 프로젝트</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.kind === "personal" ? "개인" : "업무"})
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`wt-cleanup-btn${showCleanup ? " wt-cleanup-on" : ""}`}
          onClick={() => setShowCleanup((s) => !s)}
          disabled={!cleanupRepo}
          title="브랜치/워크트리 정리"
        >
          <Trash2 className="size-3.5" />
          정리
        </button>
        <button
          type="button"
          className="wt-refresh"
          onClick={() => void worktrees.refetch()}
          title="새로고침"
        >
          <RefreshCw
            className={`size-3.5${worktrees.isFetching ? " wt-spin" : ""}`}
          />
        </button>
      </header>

      {showCleanup && cleanupRepo && (
        <CleanupPanel
          repoPath={cleanupRepo.path}
          base={cleanupRepo.baseBranch}
          onClose={() => setShowCleanup(false)}
        />
      )}

      <div className="wt-body">
        {/* 좌: worktree 목록 */}
        <aside className="wt-side">
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
                  <button
                    key={m.key}
                    type="button"
                    className={`wt-mode${mode === m.key ? " wt-mode-on" : ""}`}
                    onClick={() => changeMode(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
                <RebaseBar worktree={selected} onReviewBase={() => changeMode("vs_base")} />
              </div>

              {/* ref picker (vs_base = base, branch↔branch = base + head) */}
              {(mode === "vs_base" || mode === "branch_branch") && (
                <div className="wt-refs">
                  <label className="wt-ref">
                    <span>base</span>
                    <select
                      value={baseRef ?? ""}
                      onChange={(e) => {
                        setBaseRef(e.target.value || null);
                        setSelectedFile(null);
                      }}
                    >
                      <option value="">선택…</option>
                      {branchList.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </label>
                  {mode === "branch_branch" && (
                    <label className="wt-ref">
                      <span>head</span>
                      <select
                        value={headRef ?? ""}
                        onChange={(e) => {
                          setHeadRef(e.target.value || null);
                          setSelectedFile(null);
                        }}
                      >
                        <option value="">선택…</option>
                        {branchList.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {mode === "vs_base" && (
                    <span className="wt-ref-hint">base...HEAD (3-dot)</span>
                  )}
                </div>
              )}

              <div className="wt-split">
                {/* 파일 목록(통계 먼저) */}
                <div className="wt-files">
                  {!ready && (
                    <div className="wt-empty">비교할 ref를 선택하세요.</div>
                  )}
                  {ready && diffFiles.isFetching && (
                    <div className="wt-empty">불러오는 중…</div>
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
                    <DiffText text={fileDiff.data ?? ""} />
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
      <button
        type="button"
        className="wt-rebase-btn"
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
      </button>
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
        <button type="button" className="wt-cleanup-close" onClick={onClose}>
          닫기
        </button>
      </div>

      {candidates.isLoading && <div className="wt-empty">불러오는 중…</div>}
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
        <button
          type="button"
          className="wt-cleanup-del"
          onClick={run}
          disabled={selected.size === 0 || del.isPending}
        >
          <Trash2 className="size-3.5" />
          {del.isPending ? "삭제 중…" : `선택 ${selected.size}개 삭제`}
        </button>
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

/**
 * unified diff 텍스트를 줄 단위로 색칠해 렌더(diff-line 구문강조). 큰 diff는 줄을 블록으로 묶고
 * content-visibility:auto로 오프스크린을 건너뛰며, 상한 초과 시 잘라 비차단을 보장한다.
 */
function DiffText({ text }: { text: string }) {
  const allLines = text.length === 0 ? [] : text.split("\n");
  const truncated = allLines.length > MAX_DIFF_LINES;
  const lines = truncated ? allLines.slice(0, MAX_DIFF_LINES) : allLines;

  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i += BLOCK) {
    blocks.push(lines.slice(i, i + BLOCK));
  }

  if (lines.length === 0) {
    return <div className="wt-empty">변경 내용이 없습니다.</div>;
  }

  return (
    <div className="wt-diff-text">
      {blocks.map((block, bi) => (
        <div key={bi} className="wt-diff-block">
          {block.map((line, li) => (
            <div key={li} className={`wt-line ${diffLineClass(line)}`}>
              {line || " "}
            </div>
          ))}
        </div>
      ))}
      {truncated && (
        <div className="wt-trunc">
          큰 diff — {MAX_DIFF_LINES.toLocaleString()}/{allLines.length.toLocaleString()}줄만 표시.
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
