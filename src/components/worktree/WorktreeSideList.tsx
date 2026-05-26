import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Worktree } from "@/bindings";
import { localChangeCount, localChangeSummary } from "@/lib/worktreeReview";

type WorktreeSideListProps = {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  error: unknown;
  isLoading: boolean;
  list: Worktree[];
  grouped: [string, Worktree[]][];
  selectedPath: string | null;
  onSelect: (worktree: Worktree) => void;
};

export function WorktreeSideList({
  collapsed,
  onCollapsedChange,
  error,
  isLoading,
  list,
  grouped,
  selectedPath,
  onSelect,
}: WorktreeSideListProps) {
  if (collapsed) {
    return (
      <button
        type="button"
        className="wt-rail"
        onClick={() => onCollapsedChange(false)}
        title="Worktree 목록 펼치기"
      >
        <PanelLeftOpen className="size-4" />
        <span className="wt-rail-label">Worktrees</span>
      </button>
    );
  }

  return (
    <aside className="wt-side">
      <div className="wt-panel-head">
        <span className="wt-panel-title">Worktrees</span>
        <Button
          variant="ghost"
          size="sm"
          className="size-6 shrink-0 p-0 text-wr-muted"
          onClick={() => onCollapsedChange(true)}
          title="패널 접기"
        >
          <PanelLeftClose className="size-3.5" />
        </Button>
      </div>
      {Boolean(error) && (
        <div className="wt-err">{String((error as Error).message ?? error)}</div>
      )}
      {!isLoading && list.length === 0 && !error && (
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
              onClick={() => onSelect(w)}
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
  );
}

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
  const baseAhead = w.baseAhead ?? 0;
  const baseBehind = w.baseBehind ?? 0;
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
      {localChangeCount(w) > 0 && (
        <span className="wt-badge wt-dirty" title={localChangeSummary(w)}>
          local {localChangeCount(w)}
        </span>
      )}
      {w.stagedCount > 0 && (
        <span className="wt-badge wt-staged">staged {w.stagedCount}</span>
      )}
      {w.unstagedCount > 0 && (
        <span className="wt-badge wt-unstaged">unstaged {w.unstagedCount}</span>
      )}
      {baseAhead > 0 && (
        <span className="wt-badge wt-ahead" title={`${w.baseBranch}보다 커밋 ${baseAhead}개 앞섬`}>
          +{baseAhead}
        </span>
      )}
      {baseBehind > 0 && (
        <span className="wt-badge wt-behind" title={`${w.baseBranch}보다 커밋 ${baseBehind}개 뒤처짐`}>
          -{baseBehind}
        </span>
      )}
      {w.mergedIntoBase === true && (
        <span className="wt-badge wt-merged" title={`${w.baseBranch}에 이미 머지됨`}>
          merged
        </span>
      )}
      {w.mergedIntoBase === false && (
        <span className="wt-badge wt-unmerged" title={`${w.baseBranch}에 아직 머지되지 않음`}>
          unmerged
        </span>
      )}
      {localChangeCount(w) === 0 && baseAhead === 0 && baseBehind === 0 && (
        <span className="wt-badge wt-clean">clean</span>
      )}
    </>
  );
}
