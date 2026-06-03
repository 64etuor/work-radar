import { type ClassValue, clsx } from "clsx";

import { twMergeTypo } from "@/lib/tw";

/** shadcn 표준 className 머지 유틸. typo-* 충돌 해소는 twMergeTypo가 담당. */
export function cn(...inputs: ClassValue[]) {
  return twMergeTypo(clsx(inputs));
}
