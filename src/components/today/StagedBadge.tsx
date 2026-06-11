/**
 * Staged "변경 N건 적용" 배지(PR 5 Task 5, 스펙 §6.2).
 *
 * cross-cal 드래그(moveCalendar)는 워커가 skip하는 staged=true 행으로 큐에 들어간다.
 * 본 배지는 staged 행 수를 노출하고, "적용" 버튼이 commit_staged_writes로 한 번에 풀어
 * 워커가 즉시 가져가게 한다(INVARIANT #2 — 사용자 Acceptance 게이트).
 */
import { Button } from "@/components/ui/button";
import {
  isStaged,
  useCancelPendingWrites,
  useCommitStagedWrites,
  usePendingWrites,
} from "@/lib/query/calendarSync";

export function StagedBadge() {
  const pending = usePendingWrites();
  const commit = useCommitStagedWrites();
  const cancel = useCancelPendingWrites();
  const staged = (pending.data ?? []).filter(isStaged);
  if (staged.length === 0) return null;

  const busy = commit.isPending || cancel.isPending;
  const ids = staged.map((s) => s.id);

  return (
    <output className="today-staged" aria-live="polite">
      <span className="today-staged-text">변경 {staged.length}건 대기 중</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => cancel.mutate(ids)}>
        {cancel.isPending ? "취소 중…" : "취소"}
      </Button>
      <Button size="sm" disabled={busy} onClick={() => commit.mutate(ids)}>
        {commit.isPending ? "적용 중…" : "적용"}
      </Button>
    </output>
  );
}
