/**
 * Staged "변경 N건 적용" 배지(PR 5 Task 5, 스펙 §6.2).
 *
 * cross-cal 드래그(moveCalendar)는 워커가 skip하는 staged=true 행으로 큐에 들어간다.
 * 본 배지는 staged 행 수를 노출하고, "적용" 버튼이 commit_staged_writes로 한 번에 풀어
 * 워커가 즉시 가져가게 한다(INVARIANT #2 — 사용자 Acceptance 게이트).
 */
import { Button } from "@/components/ui/button";
import { isStaged, useCommitStagedWrites, usePendingWrites } from "@/lib/query/calendarSync";

export function StagedBadge() {
  const pending = usePendingWrites();
  const commit = useCommitStagedWrites();
  const staged = (pending.data ?? []).filter(isStaged);
  if (staged.length === 0) return null;

  return (
    <div className="today-staged" role="status" aria-live="polite">
      <span className="today-staged-text">변경 {staged.length}건 대기 중</span>
      <Button
        size="sm"
        disabled={commit.isPending}
        onClick={() => commit.mutate(staged.map((s) => s.id))}
      >
        {commit.isPending ? "적용 중…" : "적용"}
      </Button>
    </div>
  );
}
