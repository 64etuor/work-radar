import { Check, X } from "lucide-react";
import { useState } from "react";

import type { AgentRunView, OkrImportDraft } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAcceptOkrImport, useOkrImportProposal, useRejectProposal } from "@/lib/query";

import { ProposalError } from "./ProposalError";

/**
 * OKR 받아쓰기 Proposal 패널. 자유 텍스트에서 뽑은 초안(mission/horizon/objective/KR)을 나열하고
 * 제목 편집·항목 제거 후 일괄 적용한다. 적용해야만 생성 — codex 자동 생성 0(INVARIANT #1),
 * Acceptance 게이트(INVARIANT #2). 부분 실패(skipped) 카운트를 함께 노출한다.
 */
export function OkrImportPanel({ run }: { run: AgentRunView }) {
  const proposal = useOkrImportProposal(run.id, true);
  const reject = useRejectProposal();

  if (proposal.isLoading) {
    return (
      <div className="jobs-prop jobs-prop-loading">
        <Spinner /> 초안 불러오는 중…
      </div>
    );
  }
  if (proposal.error) {
    return (
      <ProposalError runId={run.id} message={(proposal.error as Error).message} reject={reject} />
    );
  }
  if (!proposal.data) return null;

  return (
    <OkrImportEditor key={JSON.stringify(proposal.data)} runId={run.id} initial={proposal.data} />
  );
}

const HORIZON_KIND_LABEL: Record<string, string> = {
  three_year: "3년",
  one_year: "1년",
  someday: "언젠가",
};

function OkrImportEditor({ runId, initial }: { runId: string; initial: OkrImportDraft }) {
  const accept = useAcceptOkrImport();
  const reject = useRejectProposal();
  const [draft, setDraft] = useState<OkrImportDraft>(() => initial);

  const patchObjective = (index: number, patch: Partial<OkrImportDraft["objectives"][number]>) =>
    setDraft((current) => ({
      ...current,
      objectives: current.objectives.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    }));

  const totalKrs = draft.objectives.reduce((sum, o) => sum + (o.keyResults ?? []).length, 0);

  return (
    <div className="jobs-prop">
      <div className="jobs-prop-hint">
        Objective <b>{draft.objectives.length}</b>개 · KR <b>{totalKrs}</b>개 초안
        {draft.skipped > 0 && <> · 격리(skip) {draft.skipped}개</>}. 편집·제거 후 적용하면{" "}
        <b>Mission 페이지에 생성</b>됩니다.
      </div>

      {draft.mission != null && (
        <div className="jobs-prop-batch-item">
          <div className="jobs-prop-batch-title">미션(시즌 주제) — 기존 문구를 덮어씁니다</div>
          <div className="jobs-prop-batch-row">
            <Input
              value={draft.mission}
              onChange={(e) => setDraft((c) => ({ ...c, mission: e.target.value }))}
              aria-label="미션 문구"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDraft((c) => ({ ...c, mission: null }))}
            >
              제외
            </Button>
          </div>
        </div>
      )}

      {draft.horizons.map((horizon, index) => (
        <div key={`${horizon.title}-${index}`} className="jobs-prop-batch-item">
          <div className="jobs-prop-batch-title">
            장기 목표 · {HORIZON_KIND_LABEL[horizon.horizonKind] ?? horizon.horizonKind}
          </div>
          <div className="jobs-prop-batch-row">
            <Input
              value={horizon.title}
              onChange={(e) =>
                setDraft((c) => ({
                  ...c,
                  horizons: c.horizons.map((h, i) =>
                    i === index ? { ...h, title: e.target.value } : h,
                  ),
                }))
              }
              aria-label="장기 목표 제목"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((c) => ({ ...c, horizons: c.horizons.filter((_, i) => i !== index) }))
              }
            >
              제외
            </Button>
          </div>
        </div>
      ))}

      {draft.objectives.map((objective, index) => (
        <div key={`${objective.title}-${index}`} className="jobs-prop-batch-item">
          <div className="jobs-prop-batch-row">
            <Input
              value={objective.title}
              onChange={(e) => patchObjective(index, { title: e.target.value })}
              aria-label="Objective 제목"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((c) => ({
                  ...c,
                  objectives: c.objectives.filter((_, i) => i !== index),
                }))
              }
            >
              제외
            </Button>
          </div>
          {(objective.linkedAreaKeys ?? []).length > 0 && (
            <div className="jobs-prop-batch-reason">
              영역: {(objective.linkedAreaKeys ?? []).join(", ")}
            </div>
          )}
          {(objective.keyResults ?? []).map((kr, krIndex) => (
            <div key={`${kr.title}-${krIndex}`} className="jobs-prop-batch-row">
              <Input
                value={kr.title}
                onChange={(e) =>
                  patchObjective(index, {
                    keyResults: (objective.keyResults ?? []).map((k, i) =>
                      i === krIndex ? { ...k, title: e.target.value } : k,
                    ),
                  })
                }
                aria-label="KR 제목"
              />
              <span className="jobs-prop-batch-reason">
                {kr.kind === "metric"
                  ? `목표 ${kr.targetValue ?? "-"}${kr.unit ?? ""}`
                  : `단계 ${(kr.milestones ?? []).length}개`}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="KR 제외"
                onClick={() =>
                  patchObjective(index, {
                    keyResults: (objective.keyResults ?? []).filter((_, i) => i !== krIndex),
                  })
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ))}

      {(accept.error || reject.error) && (
        <div className="jobs-prop-err">{((accept.error ?? reject.error) as Error).message}</div>
      )}
      <div className="jobs-prop-actions">
        <Button
          size="sm"
          className="typo-label-sm rounded-full"
          disabled={
            accept.isPending ||
            (draft.objectives.length === 0 && draft.horizons.length === 0 && !draft.mission)
          }
          onClick={() => accept.mutate({ runId, accepted: draft })}
        >
          <Check className="size-3.5" />
          적용 (Mission에 생성)
        </Button>
        <Button
          variant="destructiveOutline"
          size="sm"
          className="typo-label-sm rounded-full"
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
