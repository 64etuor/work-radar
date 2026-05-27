import type { DiffMode, Worktree } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  branchChangeSummary,
  branchGraphAriaLabel,
  emptyStateForLens,
  localChangeCount,
  mergeStateSummary,
  type ReviewLens,
  reviewQueueLabel,
} from "@/lib/worktreeReview";

export function ReviewSummary({
  worktree,
  branchFileCount,
  reviewing,
  onReview,
}: {
  worktree: Worktree;
  branchFileCount: number | null;
  reviewing?: boolean;
  onReview?: () => void;
}) {
  const activity = relativeActivity(worktree.newestMtime);
  return (
    <section className="wt-review-summary" aria-label="선택한 worktree 요약">
      <div className="wt-review-title-row">
        <span className="wt-review-kicker">Review queue</span>
        <h2 className="wt-review-title">{worktree.branch ?? "(detached)"}</h2>
        <span className="wt-review-base">base {worktree.baseBranch}</span>
        <strong className="wt-review-total">
          {reviewQueueLabel({
            stagedCount: worktree.stagedCount,
            unstagedCount: worktree.unstagedCount,
            branchFileCount,
          })}
        </strong>
      </div>
      <div className="wt-review-facts">
        <BranchRail worktree={worktree} activity={activity} />
        {onReview && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full text-[12px]"
            onClick={onReview}
            disabled={reviewing}
            title="이 worktree 변경을 AI가 read-only로 리뷰합니다"
          >
            {reviewing ? "리뷰 시작 중…" : "AI worktree review"}
          </Button>
        )}
      </div>
      <p className="wt-review-help">
        Unstaged는 working tree vs index, Staged는 index vs HEAD, Branch는 HEAD vs base입니다.
      </p>
      <WorktreeTimeline worktree={worktree} />
    </section>
  );
}

function WorktreeTimeline({ worktree }: { worktree: Worktree }) {
  const events = [
    { key: "created", label: "worktree", detail: worktree.isPrimary ? "primary" : "linked" },
    ...(worktree.newestMtime
      ? [{ key: "modified", label: "modified", detail: relativeActivity(worktree.newestMtime) }]
      : []),
    ...(worktree.mergedIntoBase === true
      ? [{ key: "merge", label: "merged", detail: worktree.baseBranch }]
      : []),
    ...(worktree.stagedCount + worktree.unstagedCount > 0
      ? [
          {
            key: "local",
            label: "local changes",
            detail: `${worktree.stagedCount + worktree.unstagedCount} files`,
          },
        ]
      : []),
    ...(worktree.baseAhead
      ? [{ key: "branch", label: "branch commits", detail: `ahead ${worktree.baseAhead}` }]
      : []),
  ];
  return (
    <div className="wt-timeline" aria-label="worktree timeline">
      {events.map((event) => (
        <span key={event.key} className={`wt-timeline-event wt-te-${event.key}`}>
          <i />
          <b>{event.label}</b>
          <small>{event.detail}</small>
        </span>
      ))}
    </div>
  );
}

/**
 * newestMtime(ISO 문자열 또는 null) → 한국어 상대시간 레이블.
 * activeChange=true(90초 이내)면 "작업중" 펄스를 별도 배지로 표시.
 */
function relativeActivity(newestMtime: string | null): string {
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

function BranchRail({ worktree, activity }: { worktree: Worktree; activity: string }) {
  const baseAhead = worktree.baseAhead ?? 0;
  const baseBehind = worktree.baseBehind ?? 0;
  const baseUnknown = worktree.baseAhead == null || worktree.baseBehind == null;
  const local = localChangeCount(worktree);
  const relation = branchChangeSummary(worktree);
  return (
    <div
      className={`wt-branch-rail${worktree.mergedIntoBase === true ? "wt-branch-rail-merged" : ""}${baseUnknown ? "wt-branch-rail-unknown" : ""}`}
      aria-label={branchGraphAriaLabel(worktree)}
      title={relation}
    >
      <span className="wt-graph-ref wt-graph-base">{worktree.baseBranch}</span>
      <span className="wt-graph" aria-hidden="true">
        <span className="wt-graph-dot" />
        <span className="wt-graph-line" />
        <span className="wt-graph-dot wt-graph-head" />
      </span>
      <span className="wt-graph-ref wt-graph-branch">{worktree.branch ?? "detached"}</span>
      {!baseUnknown && baseBehind > 0 && <span className="wt-graph-pill">behind {baseBehind}</span>}
      {!baseUnknown && baseAhead > 0 && <span className="wt-graph-pill">ahead {baseAhead}</span>}
      {!baseUnknown && baseAhead === 0 && baseBehind === 0 && (
        <span className="wt-graph-pill">in sync</span>
      )}
      {baseUnknown && <span className="wt-graph-pill">base unknown</span>}
      <span
        className={worktree.mergedIntoBase === true ? "wt-graph-pill wt-merge-ok" : "wt-graph-pill"}
      >
        {mergeStateSummary(worktree)}
      </span>
      {local > 0 && <span className="wt-graph-pill">local {local}</span>}
      <span className="wt-graph-pill">{activity || "no recent files"}</span>
    </div>
  );
}

export function LensEmptyState({
  lens,
  worktree,
  onSwitch,
}: {
  lens: DiffMode;
  worktree: Worktree;
  onSwitch: (lens: ReviewLens) => void;
}) {
  const empty = emptyStateForLens(lens, worktree);
  return (
    <div className="wt-empty wt-empty-action">
      <span>{empty.message}</span>
      {empty.switchTo && empty.switchLabel && (
        <Button
          variant="outline"
          size="sm"
          className="rounded-full text-[12px]"
          onClick={() => onSwitch(empty.switchTo ?? "local")}
        >
          {empty.switchLabel}
        </Button>
      )}
    </div>
  );
}
