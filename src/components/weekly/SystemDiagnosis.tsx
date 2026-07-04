import { Link2, Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import { focusMatchesSprintCycle, sprintGoalLabel } from "@/lib/lifeOs";
import {
  useCurrentSprintCycle,
  useLinkSprintGoalToWeeklyFocus,
  useSelectedWeeklyFocus,
} from "@/lib/query";

export function SystemDiagnosis({
  weekStart,
  isCurrent,
}: {
  weekStart: string;
  isCurrent: boolean;
}) {
  const weeklyFocus = useSelectedWeeklyFocus(weekStart);
  const sprintCycle = useCurrentSprintCycle();
  const linkSprintGoal = useLinkSprintGoalToWeeklyFocus();
  const focus = weeklyFocus.data ?? null;
  const cycle = sprintCycle.data ?? null;
  const sprintGoal = sprintGoalLabel(cycle);
  const aligned = focusMatchesSprintCycle(focus, cycle);
  const mismatch = isCurrent && sprintGoal && focus && !aligned;
  const canLink = isCurrent && sprintGoal && (!focus || mismatch);

  return (
    <section className="wk-system">
      <div className="wk-sec-head">
        <Target className="text-wr-subtle size-4" />
        <span className="wk-sec-name">System Diagnosis</span>
      </div>
      <div className="wk-system-grid">
        <div className="wk-system-item">
          <span className="wk-system-label typo-mono-label">주간 목표</span>
          <strong className="wk-system-value typo-body-strong">
            {focus?.title ?? "선택된 주간 목표 없음"}
          </strong>
        </div>
        <div className="wk-system-item">
          <span className="wk-system-label typo-mono-label">스프린트</span>
          <strong className="wk-system-value typo-body-strong">
            {sprintGoal ?? "스프린트 목표 없음"}
          </strong>
        </div>
        <div className="wk-system-action">
          {aligned ? (
            <span className="wk-system-ok typo-label-sm">
              <Link2 className="size-4" />
              연결됨
            </span>
          ) : canLink ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => linkSprintGoal.mutate({ replaceExisting: !!focus })}
              disabled={linkSprintGoal.isPending}
            >
              <Link2 className="size-4" />
              {focus ? "주간 목표로 교체" : "주간 목표로 연결"}
            </Button>
          ) : (
            <span className="wk-system-muted typo-label-sm">분리됨</span>
          )}
        </div>
      </div>
    </section>
  );
}
