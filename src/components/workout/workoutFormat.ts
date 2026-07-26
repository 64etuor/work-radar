import type { ExerciseModality } from "@/bindings";

/** specta는 f64를 `number | null`로 내린다 — 표시 전에 항상 통과시킨다. */
export function num(v: number | null | undefined): number {
  return v == null || !Number.isFinite(v) ? 0 : v;
}

/** 소수 꼬리 없는 표기(60 → "60", 62.5 → "62.5"). */
export function trimNum(v: number | null | undefined): string {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function fmtKg(v: number | null | undefined): string {
  return `${trimNum(v)}kg`;
}

export function fmtTonnage(v: number | null | undefined): string {
  const n = num(v);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}t` : `${Math.round(n)}kg`;
}

export function fmtKcal(v: number | null | undefined): string {
  return `${Math.round(num(v))}kcal`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  const total = Math.round(num(seconds));
  if (total <= 0) return "—";
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes === 0) return `${secs}초`;
  return secs === 0 ? `${minutes}분` : `${minutes}분 ${secs}초`;
}

export function fmtDistance(meters: number | null | undefined): string {
  const n = num(meters);
  if (n <= 0) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(2)}km` : `${Math.round(n)}m`;
}

export const MODALITY_LABEL: Record<ExerciseModality, string> = {
  strength: "근력",
  cardio: "유산소",
  mobility: "가동성",
  sport: "스포츠",
};

/** 근력 종목은 reps×weight, 그 외는 시간/거리를 주 축으로 본다. */
export function isStrength(modality: ExerciseModality): boolean {
  return modality === "strength";
}

export function parseOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 분 입력 → 초. 빈 값은 null(축이 없다는 뜻 — 0과 구분). */
export function minutesToSeconds(raw: string): number | null {
  const minutes = parseOptionalNumber(raw);
  return minutes == null || minutes <= 0 ? null : Math.round(minutes * 60);
}

/** km 입력 → m. */
export function kmToMeters(raw: string): number | null {
  const km = parseOptionalNumber(raw);
  return km == null || km <= 0 ? null : Math.round(km * 1000);
}
