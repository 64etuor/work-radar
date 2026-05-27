import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import type { AgentRunView, AreaTag, BatchEnrichItem, Quadrant } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { useAcceptEnrichAll, useBatchEnrichProposal, useRejectProposal } from "@/lib/query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AREA_NONE, AREA_OPTS, QUADRANT_OPTS } from "./jobsConstants";
import { ProposalError } from "./jobsUtils";

/**
 * 배치 enrich Proposal 패널 (Phase 15 #4). 미분류 전체를 한 잡으로 enrich한 결과를 **카드별로** 나열하고
 * 사분면/영역을 편집한 뒤 일괄 accept한다. accept하면 **미분류 카드의 사분면+영역이 확정**되고 힌트가
 * 비워진다(이미 분류된 카드는 가드로 보존). codex 자동 확정 아님 — 사람의 적용 클릭이 결정 레일(INVARIANT #1).
 * 부분 실패(skipped) 카운트를 함께 노출한다.
 */
export function BatchEnrichPanel({ run }: { run: AgentRunView }) {
  const proposal = useBatchEnrichProposal(run.id, true);
  const accept = useAcceptEnrichAll();
  const reject = useRejectProposal();
  const [draft, setDraft] = useState<BatchEnrichItem[] | null>(null);
  useEffect(() => {
    if (proposal.data) setDraft(proposal.data.items);
  }, [proposal.data]);

  if (proposal.isLoading) {
    return (
      <div className="jobs-prop jobs-prop-loading">
        <Spinner /> Proposal 불러오는 중…
      </div>
    );
  }
  if (proposal.error) {
    return (
      <ProposalError runId={run.id} message={(proposal.error as Error).message} reject={reject} />
    );
  }
  const items = draft ?? proposal.data?.items ?? [];
  const skipped = proposal.data?.skipped ?? 0;

  const setItem = (i: number, patch: Partial<BatchEnrichItem>) => {
    const next = [...items];
    next[i] = { ...next[i], ...patch };
    setDraft(next);
  };

  return (
    <div className="jobs-prop">
      <div className="jobs-prop-hint">
        미분류 <b>{items.length}</b>개 카드 제안{skipped > 0 && <> · 격리(skip) {skipped}개</>}.
        수정 후 accept하면 <b>사분면·영역이 확정</b>됩니다(이미 분류된 카드는 보존).
      </div>

      {items.length === 0 && (
        <div className="jobs-prop-empty">(적용 가능한 카드 제안이 없습니다)</div>
      )}

      {items.map((it, i) => (
        <div key={it.id} className="jobs-prop-batch-item">
          <div className="jobs-prop-batch-title">{it.title ?? it.id}</div>
          <div className="jobs-prop-batch-row">
            <Select
              value={it.suggestedQuadrant ?? "unclassified"}
              onValueChange={(v) => setItem(i, { suggestedQuadrant: v as Quadrant })}
            >
              <SelectTrigger className="flex-1" aria-label="제안 사분면">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUADRANT_OPTS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={it.suggestedArea ?? AREA_NONE}
              onValueChange={(v) =>
                setItem(i, {
                  suggestedArea: v === AREA_NONE ? null : (v as AreaTag),
                })
              }
            >
              <SelectTrigger className="flex-1" aria-label="제안 영역">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AREA_NONE}>(미설정)</SelectItem>
                {AREA_OPTS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {it.reason && <div className="jobs-prop-batch-reason">{it.reason}</div>}
        </div>
      ))}

      {(accept.error || reject.error) && (
        <div className="jobs-prop-err">{((accept.error ?? reject.error) as Error).message}</div>
      )}
      <div className="jobs-prop-actions">
        <Button
          size="sm"
          className="rounded-full text-[12px]"
          disabled={accept.isPending || items.length === 0}
          onClick={() =>
            accept.mutate({
              runId: run.id,
              accepted: { items, skipped },
            })
          }
        >
          <Check className="size-3.5" />
          전체 accept (확정)
        </Button>
        <Button
          variant="destructiveOutline"
          size="sm"
          className="rounded-full text-[12px]"
          disabled={reject.isPending}
          onClick={() => reject.mutate(run.id)}
        >
          <X className="size-3.5" />
          폐기
        </Button>
      </div>
    </div>
  );
}
