import {
  useMutation,
} from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { unwrap, useInvalidate } from "./client";
import {
  commands,
  type PromotionTarget,
} from "@/bindings";

/** 외부 URL(생성된 Notion 페이지)을 브라우저/Notion 앱에서 연다("Notion에서 열기"). */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

/**
 * 카드 → Notion 백로그/안건 즉시 승격(write 레일, Phase 3). 사람 클릭이 곧 결정/accept(INVARIANT #2).
 * 결과 status로 created(성공·pageUrl) / draft(오프라인 큐잉) / failed(영구 실패)를 구분한다.
 * created 시 signal status=linked가 되므로 signals를 invalidate한다.
 * `projectId`: picker에서 사람이 고른 프로젝트(null이면 백엔드가 자동 해석).
 */
export function usePromoteToNotion() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({
      signalId,
      target,
      projectId = null,
    }: {
      signalId: string;
      target: PromotionTarget;
      projectId?: string | null;
    }) => unwrap(commands.promoteToNotion(signalId, target, projectId)),
    onSuccess: (outcome) => {
      if (outcome.status === "created") inv.signals();
    },
  });
}

/** 오프라인 큐(draft) flush — 복구 시 호출. created>0면 signals 갱신. */
export function useFlushPromotions() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: () => unwrap(commands.flushPromotions()),
    onSuccess: (summary) => {
      if (summary.created > 0) inv.signals();
    },
  });
}
