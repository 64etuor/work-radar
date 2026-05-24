import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 표준 className 머지 유틸. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
