import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { useRejectProposal } from "@/lib/query";

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
