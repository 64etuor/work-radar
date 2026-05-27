import type { PromotionOutcome } from "@/bindings";
import { IpcError } from "@/lib/query/client";

export function projectPickerSuccessMessage(
  label: string,
  outcome: PromotionOutcome,
): { message: string; openUrl: string | null } {
  if (outcome.status === "created") {
    return { message: `${label}됨`, openUrl: outcome.pageDeepLink ?? outcome.pageUrl };
  }
  if (outcome.status === "draft") {
    return { message: `${label} — 오프라인, 큐에 저장됨(복구 시 등록)`, openUrl: null };
  }
  return { message: `${label} 실패: ${outcome.detail}`, openUrl: null };
}

export function projectPickerErrorMessage(label: string, error: unknown) {
  return error instanceof IpcError ? error.app : `${label} 실패: ${String(error)}`;
}
