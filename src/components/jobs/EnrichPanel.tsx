import { Check, X } from "lucide-react";
import { useState } from "react";

import type { AgentRunView, AreaTag, EnrichProposal, Quadrant } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAcceptEnrich, useEnrichProposal, useRejectProposal } from "@/lib/query";

import { AREA_NONE, AREA_OPTS, QUADRANT_OPTS } from "./jobsConstants";
import { ProposalError } from "./ProposalError";

/**
 * enrich Proposal 패널 (Phase 9 #2). 제안 사분면/영역/근거를 편집·accept한다. accept하면 **사람이 확인한
 * 사분면+area가 확정**된다(제안에 quadrant 없으면 기존 분류 보존) — codex 자동 확정 아님(INVARIANT #1).
 */
export function EnrichPanel({ run }: { run: AgentRunView }) {
  const proposal = useEnrichProposal(run.id, true);
  const accept = useAcceptEnrich();
  const reject = useRejectProposal();
  // proposal 로드 시 draft 시드 — prev-compare로 render에서 적용 (set-state-in-effect 회피).
  const [draft, setDraft] = useState<EnrichProposal | null>(null);
  const [seededFrom, setSeededFrom] = useState<EnrichProposal | null>(null);
  if (proposal.data && proposal.data !== seededFrom) {
    setSeededFrom(proposal.data);
    setDraft(proposal.data);
  }

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
  const d: EnrichProposal = draft ??
    proposal.data ?? { suggestedQuadrant: null, suggestedArea: null, reason: null };

  return (
    <div className="jobs-prop">
      <label className="jobs-prop-label">사분면 (accept 시 확정)</label>
      <Select
        value={d.suggestedQuadrant ?? "unclassified"}
        onValueChange={(v) => setDraft({ ...d, suggestedQuadrant: v as Quadrant })}
      >
        <SelectTrigger aria-label="제안 사분면">
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

      <label className="jobs-prop-label">영역 (accept 시 확정)</label>
      <Select
        value={d.suggestedArea ?? AREA_NONE}
        onValueChange={(v) =>
          setDraft({
            ...d,
            suggestedArea: v === AREA_NONE ? null : (v as AreaTag),
          })
        }
      >
        <SelectTrigger aria-label="제안 영역">
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

      <label className="jobs-prop-label">근거</label>
      <Textarea
        className="min-h-0 resize-y"
        rows={2}
        value={d.reason ?? ""}
        onChange={(e) => setDraft({ ...d, reason: e.target.value })}
      />

      <div className="jobs-prop-hint">
        accept하면 카드의 <b>사분면·영역이 확정</b>됩니다 — codex 자동 확정이 아니라 지금 사람이
        확인한 결과(드래그/키보드 분류와 동일 결정 레일).
      </div>
      {(accept.error || reject.error) && (
        <div className="jobs-prop-err">{((accept.error ?? reject.error) as Error).message}</div>
      )}
      <div className="jobs-prop-actions">
        <Button
          size="sm"
          className="rounded-full text-[12px]"
          disabled={accept.isPending}
          onClick={() => accept.mutate({ runId: run.id, accepted: d })}
        >
          <Check className="size-3.5" />
          accept (확정)
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
