import type {
  GroceryOrderStatus,
  MealPlanStatus,
  MealType,
  PantryLocation,
  PlannedMealStatus,
} from "@/bindings";
import { APP_LOCALE } from "@/lib/localeFormat";

/** specta f64는 TS에서 `number | null` — 표시 전 0 폴백을 한 곳으로 모은다. */
export function num(v: number | null | undefined): number {
  return v ?? 0;
}

const INT_FMT = new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: 0 });

/** 중량 g — 정수 반올림 + 천단위 구분. */
export function fmtG(v: number | null | undefined): string {
  return `${INT_FMT.format(Math.round(num(v)))}g`;
}

export function fmtKcal(v: number | null | undefined): string {
  return `${INT_FMT.format(Math.round(num(v)))} kcal`;
}

/** 목표 허용 밴드 [min, max] = target ± target×tolerance%. */
export function kcalBand(
  target: number | null | undefined,
  tolerancePct: number | null | undefined,
): { min: number; max: number } {
  const t = num(target);
  const allowed = (t * num(tolerancePct)) / 100;
  return { min: t - allowed, max: t + allowed };
}

export type ExpiryTone = "expired" | "soon" | "ok";

/**
 * 유통기한 배지 분류. 'YYYY-MM-DD' 사전순 == 시간순.
 * 기한 없는 로트는 null(배지 없음). `soonDays` 이내(오늘 포함)면 "soon".
 */
export function expiryTone(
  expiresOn: string | null | undefined,
  today: string,
  soonDays = 3,
): ExpiryTone | null {
  if (!expiresOn) return null;
  if (expiresOn < today) return "expired";
  const soonCutoff = addDays(today, soonDays);
  return expiresOn <= soonCutoff ? "soon" : "ok";
}

/** 로컬 날짜 문자열 연산(타임존 무관 — Date는 정오 고정으로 DST 경계 회피). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1, 12);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export const MEAL_TYPE_LABEL: Record<MealType, string> = {
  breakfast: "아침",
  lunch: "점심",
  dinner: "저녁",
  snack: "간식",
  pre_workout: "운동 전",
  post_workout: "운동 후",
  free: "자유식",
};

export const MEAL_STATUS_LABEL: Record<PlannedMealStatus, string> = {
  planned: "예정",
  eaten: "먹음",
  partial: "일부",
  skipped: "건너뜀",
};

export const PLAN_STATUS_LABEL: Record<MealPlanStatus, string> = {
  draft: "초안",
  active: "활성",
  archived: "보관",
};

export const LOCATION_LABEL: Record<PantryLocation, string> = {
  fridge: "냉장",
  freezer: "냉동",
  pantry: "실온",
  other: "기타",
};

export const ORDER_STATUS_LABEL: Record<GroceryOrderStatus, string> = {
  ordered: "주문됨",
  delivered: "배송완료",
  cancelled: "취소",
};

/**
 * 선택 숫자 입력 파싱 — 빈 문자열은 null, 비수치/음수는 null(조용한 NaN 직렬화 방지).
 * `inputMode="numeric"`은 데스크톱에서 강제가 아니라서 폼 경계에서 한 번 더 거른다.
 */
export function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const v = Number(trimmed);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

const KRW_FMT = new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: 0 });

export function fmtKrw(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${KRW_FMT.format(v)}원`;
}
