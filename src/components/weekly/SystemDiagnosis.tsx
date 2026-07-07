import { Link2, Target } from "lucide-react";

import { focusMatchesSprintCycle, sprintGoalLabel } from "@/lib/lifeOs";
import { useCurrentSprintCycle, useSelectedWeeklyFocus } from "@/lib/query";

export function SystemDiagnosis({
  weekStart,
  isCurrent,
}: {
  weekStart: string;
  isCurrent: boolean;
}) {
  const weeklyFocus = useSelectedWeeklyFocus(weekStart);
  const sprintCycle = useCurrentSprintCycle();
  const focus = weeklyFocus.data ?? null;
  const cycle = sprintCycle.data ?? null;
  const sprintGoal = sprintGoalLabel(cycle);
  const aligned = focusMatchesSprintCycle(focus, cycle);
  const autoSynced = sprintGoal && aligned;
  const pendingAutoSync = isCurrent && sprintGoal && !aligned;

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
          {autoSynced ? (
            <span className="wk-system-ok typo-label-sm">
              <Link2 className="size-4" />
              자동 동기화
            </span>
          ) : pendingAutoSync ? (
            <span className="wk-system-muted typo-label-sm">
              <Link2 className="size-4" />
              다음 저장 시 자동 동기화
            </span>
          ) : (
            <span className="wk-system-muted typo-label-sm">분리됨</span>
          )}
        </div>
      </div>
    </section>
  );
}
