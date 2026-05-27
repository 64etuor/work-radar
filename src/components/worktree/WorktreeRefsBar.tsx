import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReviewLens } from "@/lib/worktreeReview";

export const REF_NONE = "__none__";

export function WorktreeRefsBar({
  lens,
  branchList,
  baseRef,
  headRef,
  onBaseRefChange,
  onHeadRefChange,
}: {
  lens: ReviewLens;
  branchList: string[];
  baseRef: string | null;
  headRef: string | null;
  onBaseRefChange: (ref: string | null) => void;
  onHeadRefChange: (ref: string | null) => void;
}) {
  if (lens !== "vs_base" && lens !== "branch_branch") return null;

  return (
    <div className="wt-refs">
      <label className="wt-ref">
        <span>base</span>
        <Select
          value={baseRef ?? REF_NONE}
          onValueChange={(v) => onBaseRefChange(v === REF_NONE ? null : v)}
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
            onValueChange={(v) => onHeadRefChange(v === REF_NONE ? null : v)}
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
      {lens === "vs_base" && <span className="wt-ref-hint">base...HEAD (3-dot)</span>}
    </div>
  );
}
