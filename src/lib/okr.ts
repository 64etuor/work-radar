import type { KeyResult } from "@/bindings";

export type KeyResultProgressSource = Pick<
  KeyResult,
  "kind" | "currentValue" | "targetValue" | "milestones"
>;

export function keyResultProgressRatio(kr: KeyResultProgressSource): number {
  if (kr.kind === "metric") {
    if (kr.currentValue == null || kr.targetValue == null || kr.targetValue <= 0) return 0;
    return kr.currentValue / kr.targetValue;
  }
  if (kr.milestones.length === 0) return 0;
  return kr.milestones.filter((milestone) => milestone.done).length / kr.milestones.length;
}

export function objectiveProgressRatio(krs: KeyResultProgressSource[]): number {
  if (krs.length === 0) return 0;
  return krs.reduce((sum, kr) => sum + keyResultProgressRatio(kr), 0) / krs.length;
}

export function weekStartMonday(date = new Date()): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = monday.getDay();
  monday.setDate(monday.getDate() - ((day + 6) % 7));
  const month = String(monday.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${month}-${dayOfMonth}`;
}
