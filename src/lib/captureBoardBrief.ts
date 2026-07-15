import type { RoutineToday, WorkSignal } from "@/bindings";

export type CaptureBoardBrief = {
  inbox: number;
  decisions: number;
  today: number;
  routines: number;
};

export function captureBoardBrief(
  signals: readonly WorkSignal[],
  todayItems: readonly WorkSignal[],
  routines: readonly RoutineToday[],
): CaptureBoardBrief {
  let inbox = 0;
  let decisions = 0;

  for (const signal of signals) {
    if (signal.quadrant === "unclassified") inbox += 1;
    else decisions += 1;
  }

  return {
    inbox,
    decisions,
    today: todayItems.length,
    routines: routines.length,
  };
}
