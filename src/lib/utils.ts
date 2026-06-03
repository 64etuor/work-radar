import { type ClassValue, clsx } from "clsx";

import { twMergeTypo } from "./tw";

/** Tailwind 클래스 병합 헬퍼 (shadcn/ui 규약). typo-* 충돌 해소는 twMergeTypo가 담당. */
export function cn(...inputs: ClassValue[]) {
  return twMergeTypo(clsx(inputs));
}

/** 폼 입력 정리: trim 후 빈 문자열은 null (선택 필드 → Option). */
export function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}
