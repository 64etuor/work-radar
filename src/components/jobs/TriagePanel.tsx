import { Check, ExternalLink, X } from "lucide-react";
import { useId, useState } from "react";

import type { AgentRunView, CiTriageProposal } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { openExternal, useAcceptTriage, useRejectProposal, useTriageProposal } from "@/lib/query";

import { prTrigger } from "./jobsUtils";
import { ProposalError } from "./ProposalError";

/**
 * CI triage Proposal 패널 (Phase 9 #3). 원인 가설/수정안/요약을 편집·accept한다. accept는 **로컬 기록**일
 * 뿐 외부 무변경(INVARIANT #2) — 실제 수정은 사람이. (재트리거 캡 초과는 백엔드가 Q1 escalate.)
 */
export function TriagePanel({ run }: { run: AgentRunView }) {
  const proposal = useTriageProposal(run.id, true);
  const reject = useRejectProposal();

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
  const initial: CiTriageProposal = proposal.data ?? { cause: "", suggestedFixes: [], summary: "" };

  return <TriageEditor key={JSON.stringify(initial)} run={run} initial={initial} />;
}

function TriageEditor({ run, initial }: { run: AgentRunView; initial: CiTriageProposal }) {
  const fieldId = useId();
  const causeId = `${fieldId}-cause`;
  const summaryId = `${fieldId}-summary`;
  const accept = useAcceptTriage();
  const reject = useRejectProposal();
  const pr = prTrigger(run.trigger);
  const [draft, setDraft] = useState(() => initial);

  return (
    <div className="jobs-prop">
      {pr && (
        <button type="button" className="jobs-prop-pr" onClick={() => void openExternal(pr.prUrl)}>
          <ExternalLink className="size-3" />
          {pr.repoFullName} #{pr.prNumber}
        </button>
      )}
      <label className="jobs-prop-label" htmlFor={causeId}>
        CI 실패 원인 가설
      </label>
      <Textarea
        id={causeId}
        className="min-h-0 resize-y"
        rows={2}
        value={draft.cause ?? ""}
        onChange={(e) => setDraft({ ...draft, cause: e.target.value })}
      />
      <div className="jobs-prop-label">수정안</div>
      {(draft.suggestedFixes ?? []).length === 0 && (
        <div className="jobs-prop-empty">(항목 없음)</div>
      )}
      <ul className="jobs-prop-ul">
        {(draft.suggestedFixes ?? []).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <label className="jobs-prop-label" htmlFor={summaryId}>
        요약
      </label>
      <Textarea
        id={summaryId}
        className="min-h-0 resize-y"
        rows={2}
        value={draft.summary ?? ""}
        onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
      />
      <div className="jobs-prop-hint">
        accept는 <b>로컬 기록</b>일 뿐입니다(외부 무변경). 실제 수정은 직접.
      </div>
      {(accept.error || reject.error) && (
        <div className="jobs-prop-err">{((accept.error ?? reject.error) as Error).message}</div>
      )}
      <div className="jobs-prop-actions">
        <Button
          size="sm"
          className="rounded-full text-[12px]"
          disabled={accept.isPending}
          onClick={() => accept.mutate({ runId: run.id, accepted: draft })}
        >
          <Check className="size-3.5" />
          accept (로컬 기록)
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
