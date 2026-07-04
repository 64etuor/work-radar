import { Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { focusMatchesSprintCycle, primaryDominoTitle } from "@/lib/lifeOs";
import { weekStartMonday } from "@/lib/okr";
import { useCurrentSprintCycle, useSelectedWeeklyFocus } from "@/lib/query";

export function DominoPanel({ date }: { date: string }) {
  const weekStart = weekStartMonday(parseLocalDate(date));
  const weeklyFocus = useSelectedWeeklyFocus(weekStart);
  const sprintCycle = useCurrentSprintCycle();
  const focus = weeklyFocus.data ?? null;
  const cycle = sprintCycle.data ?? null;
  const domino = primaryDominoTitle(focus, cycle);

  if (!domino.title) {
    return (
      <section className="today-domino" aria-label="오늘의 선택">
        <span className="today-domino-label typo-mono-label">
          <Target className="size-4" />
          오늘의 선택
        </span>
        <span className="today-domino-empty typo-body-md">선택된 주간 목표 없음</span>
      </section>
    );
  }

  return (
    <section className="today-domino" aria-label="오늘의 선택">
      <span className="today-domino-label typo-mono-label">
        <Target className="size-4" />
        오늘의 도미노
      </span>
      <strong className="today-domino-title typo-body-strong">{domino.title}</strong>
      <span className="today-domino-badges">
        <Badge variant="outline">
          {domino.source === "weekly_focus" ? "주간 목표" : "스프린트"}
        </Badge>
        {focusMatchesSprintCycle(focus, cycle) && <Badge variant="secondary">연결됨</Badge>}
      </span>
    </section>
  );
}

function parseLocalDate(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}
