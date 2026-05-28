import type { Worktree } from "@/bindings";
import { Button } from "@/components/ui/button";
import type { ReviewLens } from "@/lib/worktreeReview";

import { RebaseBar } from "./RebaseBar";

const REVIEW_LENSES: { key: ReviewLens; label: string }[] = [
  { key: "local", label: "Local" },
  { key: "working", label: "Unstaged" },
  { key: "staged", label: "Staged" },
  { key: "vs_base", label: "Branch vs base" },
  { key: "branch_branch", label: "Compare refs" },
];

export function WorktreeLensToolbar({
  worktree,
  lens,
  onLensChange,
}: {
  worktree: Worktree;
  lens: ReviewLens;
  onLensChange: (lens: ReviewLens) => void;
}) {
  return (
    <div className="wt-modes">
      <div className="wt-review-tabs" role="tablist" aria-label="Review lens">
        {REVIEW_LENSES.map((m) => (
          <Button
            key={m.key}
            variant={lens === m.key ? "default" : "outline"}
            size="sm"
            className="rounded-full text-[12px]"
            aria-selected={lens === m.key}
            role="tab"
            onClick={() => onLensChange(m.key)}
          >
            {m.key === "vs_base" && worktree.baseBranch
              ? `Branch vs ${worktree.baseBranch}`
              : m.label}
          </Button>
        ))}
      </div>
      <div className="wt-maintenance">
        <span className="wt-maintenance-label">Maintenance</span>
        <RebaseBar worktree={worktree} onReviewBase={() => onLensChange("vs_base")} />
      </div>
    </div>
  );
}
