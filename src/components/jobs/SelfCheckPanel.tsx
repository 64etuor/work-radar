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
  const fieldId = useId();
  const summaryId = `${fieldId}-summary`;

  const proposal = usePrProposal(run.id, true);
  const accept = useAcceptProposal();
  const reject = useRejectProposal();
  const pr = prTrigger(run.trigger);

  // 편집 가능한 로컬 사본 — prev-compare로 render에서 시드 (set-state-in-effect 회피).
  const [draft, setDraft] = useState<PrSelfCheckProposal | null>(null);
  const [seededFrom, setSeededFrom] = useState<PrSelfCheckProposal | null>(null);
  if (proposal.data && proposal.data !== seededFrom) {
    setSeededFrom(proposal.data);
    setDraft(normalizeProposal(proposal.data));
  }

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
  const d = draft ?? normalizeProposal(proposal.data ?? {});

  const setChecks = (checks: SelfCheckItem[]) => setDraft({ ...d, selfChecks: checks });

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
        value={d.summary ?? ""}
        rows={3}
        onChange={(e) => setDraft({ ...d, summary: e.target.value })}
      />

      <div className="jobs-prop-label">self-check 체크리스트</div>
      <div className="jobs-prop-checks">
        {(d.selfChecks ?? []).length === 0 && <div className="jobs-prop-empty">(항목 없음)</div>}
        {(d.selfChecks ?? []).map((c, i) => (
          <label key={`${c.item}:${c.note ?? ""}`} className="jobs-prop-check">
            <input
              type="checkbox"
              aria-label={c.item}
              checked={c.checked ?? false}
              onChange={(e) => {
                const next = [...(d.selfChecks ?? [])];
                next[i] = { ...c, checked: e.target.checked };
                setChecks(next);
              }}
            />
            <span>{c.item}</span>
            {c.note && <span className="jobs-prop-note">{c.note}</span>}
          </label>
        ))}
      </div>

      {(d.screenshotsNeeded ?? []).length > 0 && (
        <>
          <div className="jobs-prop-label">스크린샷 필요</div>
          <ul className="jobs-prop-ul">
            {(d.screenshotsNeeded ?? []).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {(d.migrationNotes ?? []).length > 0 && (
        <>
          <div className="jobs-prop-label">마이그레이션/배포 노트</div>
          <ul className="jobs-prop-ul">
            {(d.migrationNotes ?? []).map((s) => (
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
          onClick={() => accept.mutate({ runId: run.id, accepted: d })}
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
