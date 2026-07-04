import type { SprintCycle, WeeklyFocus } from "@/bindings";

export type DominoSource = "weekly_focus" | "sprint" | "none";

export function currentQuarterKey(date = new Date()): string {
  return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}

export function sprintGoalLabel(cycle: SprintCycle | null | undefined): string | null {
  const goal = cycle?.goal?.trim();
  return goal ? goal : null;
}

export function focusMatchesSprintCycle(
  focus: WeeklyFocus | null | undefined,
  cycle: SprintCycle | null | undefined,
): boolean {
  if (!focus || !cycle) return false;
  return (
    focus.sourceKind === "sprint" && focus.sourceId === cycle.id && cycle.weeklyFocusId === focus.id
  );
}

export function primaryDominoTitle(
  focus: WeeklyFocus | null | undefined,
  cycle: SprintCycle | null | undefined,
): { title: string | null; source: DominoSource } {
  const focusTitle = focus?.title.trim();
  if (focusTitle) return { title: focusTitle, source: "weekly_focus" };
  const sprintGoal = sprintGoalLabel(cycle);
  if (sprintGoal) return { title: sprintGoal, source: "sprint" };
  return { title: null, source: "none" };
}
