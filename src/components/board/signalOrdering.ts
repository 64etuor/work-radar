import type { WorkSignal } from "@/bindings";

export function sortSignalsForBoard(
  signals: WorkSignal[],
  captureOrder: ReadonlyMap<string, number>,
): WorkSignal[] {
  return [...signals].sort((a, b) => {
    if (a.quadrant !== "unclassified" || b.quadrant !== "unclassified") return 0;
    const aOrder = captureOrder.get(a.id);
    const bOrder = captureOrder.get(b.id);
    if (aOrder == null && bOrder == null) return 0;
    if (aOrder == null) return -1;
    if (bOrder == null) return 1;
    return aOrder - bOrder;
  });
}
