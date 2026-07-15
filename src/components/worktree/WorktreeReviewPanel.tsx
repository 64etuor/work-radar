import type { DiffMode, Worktree } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  branchChangeSummary,
  branchGraphAriaLabel,
  emptyStateForLens,
  localChangeCount,
  localChangeSummary,
  mergeStateSummary,
  relativeActivity,
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
      <div className="wt-review-intro">
        <span className="wt-review-kicker typo-mono-heading">Selected workspace</span>
        <div className="wt-review-title-row">
          <h2 className="wt-review-title typo-title-lg">{worktree.branch ?? "(detached)"}</h2>
          <span className="wt-review-base typo-mono-sm">base {worktree.baseBranch}</span>
        </div>
        <strong className="wt-review-total typo-body-strong">
          {reviewQueueLabel({
            stagedCount: worktree.stagedCount,
            unstagedCount: worktree.unstagedCount,
            branchFileCount,
          })}
        </strong>
      </div>
      <div className="wt-review-evidence" aria-label="Review evidence">
        <ReviewFact label="Local changes" value={localChangeSummary(worktree)} />
        <ReviewFact label="Branch relation" value={branchChangeSummary(worktree)} />
        <ReviewFact label="Merge state" value={mergeStateSummary(worktree)} />
        <ReviewFact label="Activity" value={activity || "최근 변경 없음"} />
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
    </section>
  );
}

function ReviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="wt-review-evidence-fact">
      <span className="typo-label-xs">{label}</span>
      <strong className="typo-body-sm">{value}</strong>
    </div>
  );
}

/**
 * newestMtime(ISO 문자열 또는 null) → 한국어 상대시간 레이블.
 * activeChange=true(90초 이내)면 "작업중" 펄스를 별도 배지로 표시.
 */

function BranchRail({ worktree, activity }: { worktree: Worktree; activity: string }) {
  const baseAhead = worktree.baseAhead ?? 0;
  const baseBehind = worktree.baseBehind ?? 0;
  const baseUnknown = worktree.baseAhead == null || worktree.baseBehind == null;
  const local = localChangeCount(worktree);
  const relation = branchChangeSummary(worktree);
  return (
    <div
      className={cn(
        "wt-branch-rail",
        worktree.mergedIntoBase === true && "wt-branch-rail-merged",
        baseUnknown && "wt-branch-rail-unknown",
      )}
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
