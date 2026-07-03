import type { OkrConfidence } from "@/bindings";

export const CONFIDENCE_LABELS: Record<OkrConfidence, string> = {
  on_track: "순항",
  at_risk: "주의",
  off_track: "위험",
};

export function parseNullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
