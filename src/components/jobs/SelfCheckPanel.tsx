import { Check, ExternalLink, X } from "lucide-react";
import { useId, useState } from "react";

import type { AgentRunView, PrSelfCheckProposal, SelfCheckItem } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { openExternal, useAcceptProposal, usePrProposal, useRejectProposal } from "@/lib/query";

import { prTrigger } from "./jobsUtils";

/** Proposal 옵셔널 필드를 안전한 기본값으로 정규화. */
function normalizeProposal(p: PrSelfCheckProposal): PrSelfCheckProposal {
  return {
    summary: p.summary ?? "",
    selfChecks: p.selfChecks ?? [],
    screenshotsNeeded: p.screenshotsNeeded ?? [],
    migrationNotes: p.migrationNotes ?? [],
  };
}

/**
 * PR self-check Proposal 패널 (Phase 8). codex가 낸 self-check/설명/스크린샷/마이그레이션 초안을
 * 사람이 편집하고 accept하면 로컬에 반영된다. **GitHub 제출은 사람이 수동으로** 한다(INVARIANT #2).
 */
export function SelfCheckPanel({ run }: { run: AgentRunView }) {
  const proposal = usePrProposal(run.id, true);
  const reject = useRejectProposal();

  if (proposal.isLoading) {
    return (
      <div className="jobs-prop jobs-prop-loading">
        <Spinner /> Proposal 불러오는 중…
      </div>
    );
  }
  if (proposal.error) {
    // 파싱 실패(codex가 형식 밖 출력) — raw를 노출하고 accept는 막는다(reject만).
    return (
      <div className="jobs-prop">
        <div className="jobs-prop-err">{(proposal.error as Error).message}</div>
        <div className="jobs-prop-actions">
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
  const initial = normalizeProposal(proposal.data ?? {});

  return <SelfCheckEditor key={JSON.stringify(initial)} run={run} initial={initial} />;
}

function SelfCheckEditor({ run, initial }: { run: AgentRunView; initial: PrSelfCheckProposal }) {
  const fieldId = useId();
  const summaryId = `${fieldId}-summary`;
  const accept = useAcceptProposal();
  const reject = useRejectProposal();
  const pr = prTrigger(run.trigger);
  const [draft, setDraft] = useState(() => initial);

  const setChecks = (checks: SelfCheckItem[]) => setDraft({ ...draft, selfChecks: checks });

  return (
    <div className="jobs-prop">
      {pr && (
        <button type="button" className="jobs-prop-pr" onClick={() => void openExternal(pr.prUrl)}>
          <ExternalLink className="size-3" />
          {pr.repoFullName} #{pr.prNumber}
        </button>
      )}

      <label className="jobs-prop-label" htmlFor={summaryId}>
        PR 설명 초안
      </label>
      <Textarea
        id={summaryId}
        className="min-h-0 resize-y"
        value={draft.summary ?? ""}
        rows={3}
        onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
      />

      <div className="jobs-prop-label">self-check 체크리스트</div>
      <div className="jobs-prop-checks">
        {(draft.selfChecks ?? []).length === 0 && (
          <div className="jobs-prop-empty">(항목 없음)</div>
        )}
        {(draft.selfChecks ?? []).map((c, i) => (
          <label key={`${c.item}:${c.note ?? ""}`} className="jobs-prop-check">
            <input
              type="checkbox"
              aria-label={c.item}
              checked={c.checked ?? false}
              onChange={(e) => {
                const next = [...(draft.selfChecks ?? [])];
                next[i] = { ...c, checked: e.target.checked };
                setChecks(next);
              }}
            />
            <span>{c.item}</span>
            {c.note && <span className="jobs-prop-note">{c.note}</span>}
          </label>
        ))}
      </div>

      {(draft.screenshotsNeeded ?? []).length > 0 && (
        <>
          <div className="jobs-prop-label">스크린샷 필요</div>
          <ul className="jobs-prop-ul">
            {(draft.screenshotsNeeded ?? []).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {(draft.migrationNotes ?? []).length > 0 && (
        <>
          <div className="jobs-prop-label">마이그레이션/배포 노트</div>
          <ul className="jobs-prop-ul">
            {(draft.migrationNotes ?? []).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}

      <div className="jobs-prop-hint">
        accept하면 로컬 self-check가 표시됩니다. <b>GitHub 제출은 직접</b> 하세요(외부 무변경).
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
          accept (로컬 반영)
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
