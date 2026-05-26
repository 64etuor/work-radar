import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { useRejectProposal } from "@/lib/query";

/** run.trigger(JSON)에서 PR 링크 정보 추출 (없으면 null). */
export function prTrigger(
  trigger: string | null,
): { prUrl: string; repoFullName: string; prNumber: number } | null {
  if (!trigger) return null;
  try {
    const v = JSON.parse(trigger);
    if (typeof v?.prUrl === "string") return v;
  } catch {
    /* 무시 — 트리거 없는 잡. */
  }
  return null;
}

/** 파싱 실패(codex 형식 밖/세트 밖) → raw 노출 + 폐기만(accept 차단). Phase 9 패널 공유. */
export function ProposalError({
  runId,
  message,
  reject,
}: {
  runId: string;
  message: string;
  reject: ReturnType<typeof useRejectProposal>;
}) {
  return (
    <div className="jobs-prop">
      <div className="jobs-prop-err">{message}</div>
      <div className="jobs-prop-actions">
        <Button
          variant="destructiveOutline"
          size="sm"
          className="rounded-full text-[12px]"
          disabled={reject.isPending}
          onClick={() => reject.mutate(runId)}
        >
          <X className="size-3.5" />
          폐기
        </Button>
      </div>
    </div>
  );
}
