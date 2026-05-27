import { useEffect, useState } from "react";
import "./EnrichReviewPanel.css";

import type { AreaTag, BatchEnrichItem, Quadrant } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { AREA_NONE, AREA_OPTS, QUADRANT_OPTS } from "@/components/jobs/jobsConstants";
import {
  AGENT_TERMINAL_STATUSES,
  useAcceptEnrichAll,
  useAgentRunStatus,
  useBatchEnrichProposal,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

type Props = {
  /** trigger_enrich_all이 만든 잡 id(폴링 대상). */
  runId: string;
  /** 패널 닫기(부모가 enrichAllRunId를 null로). */
  onClose: () => void;
  /** 생성 중(터미널 전) 여부 보고 — 인박스 버튼 스피너 표시용(토스트/팝업 대신). */
  onRunningChange?: (running: boolean) => void;
};

/**
 * EnrichReviewPanel — "전체 제안 실행" 완료 시 **보드 내 인라인** 제안 검토 패널 (Phase 8 #2).
 *
 * 오버레이 모달이 아니다(카드 계속 보임 — 결정 맥락 유지, DESIGN enrich-review-panel). 잡을 1초마다
 * 폴링하다 awaiting_approval에 도달하면 카드별 제안(사분면/영역/근거)을 **수정 가능**하게 보여주고,
 * 사람이 수정 후 `모두 적용`을 눌러야 **확정**된다(codex 자동 확정 절대 없음 — INVARIANT #1; 적용 클릭이
 * 드래그/키보드 분류와 동일한 사람 결정 레일). accept 경로는 useAcceptEnrichAll(awaiting_approval →
 * accept_enrich_all → 미분류 카드의 quadrant+area 확정 + 힌트 비움) 그대로 재사용한다.
 *
 * 상태: running=진행 표시 · empty="제안 없음" · error=재시도(잡 reject은 부모가 닫기로 처리) ·
 * partial=skipped 카운트 노출. (Jobs 페이지 BatchEnrichPanel을 점프 없이 인라인으로 이전.)
 */
export function EnrichReviewPanel({ runId, onClose, onRunningChange }: Props) {
  const { pushSuccess, pushError } = useToastStore();
  const acceptEnrichAll = useAcceptEnrichAll();

  // 잡 상태 — query 레이어가 폴링/중단/에러 처리 단일화(INVARIANT #5).
  const runStatus = useAgentRunStatus(runId);
  const status: string = runStatus.isError ? "failed" : (runStatus.data?.status ?? "proposed");
  const hasProposal = runStatus.data?.hasProposal ?? false;
  const failDetail: string | null = runStatus.isError
    ? String(runStatus.error)
    : runStatus.data?.status === "failed"
      ? (runStatus.data.detail ?? "알 수 없는 오류")
      : null;

  // awaiting_approval + proposal 있을 때만 카드별 제안 로드(파싱 실패는 즉시 노출).
  const proposalReady = status === "awaiting_approval" && hasProposal;
  const proposal = useBatchEnrichProposal(proposalReady ? runId : null, proposalReady);

  // 편집 가능한 로컬 사본(제안 로드 시 시드).
  const [draft, setDraft] = useState<BatchEnrichItem[] | null>(null);
  useEffect(() => {
    if (proposal.data && !draft) setDraft(proposal.data.items);
  }, [proposal.data, draft]);

  // 생성 중(터미널 전) 여부를 부모에 보고 — 인박스 버튼 스피너로 표시(여기선 팝업/토스트 안 띄움).
  useEffect(() => {
    onRunningChange?.(!AGENT_TERMINAL_STATUSES.has(status));
  }, [status, onRunningChange]);

  const items = draft ?? proposal.data?.items ?? [];
  const skipped = proposal.data?.skipped ?? 0;

  const setItem = (i: number, patch: Partial<BatchEnrichItem>) => {
    const next = [...items];
    next[i] = { ...next[i], ...patch };
    setDraft(next);
  };

  const handleApplyAll = () => {
    if (items.length === 0) return;
    acceptEnrichAll.mutate(
      { runId, accepted: { items, skipped } },
      {
        onSuccess: (applied) => {
          pushSuccess(`제안 ${applied}건 확정됨 (사분면·영역)`);
          onClose();
        },
        onError: (e) => pushError("codex", `적용 실패: ${String(e)}`),
      },
    );
  };

  // 생성 중(proposed/running 등 터미널 전)에는 패널을 렌더하지 않는다 — 인박스 버튼 스피너가 진행을
  // 표시(팝업/토스트 대신). awaiting_approval/succeeded/failed/cancelled에 도달해야 패널이 뜬다.
  if (!AGENT_TERMINAL_STATUSES.has(status)) return null;

  return (
    <div className="enrich-review" role="region" aria-label="AI 제안 검토">
      <div className="enrich-review-head">
        <span className="enrich-review-title">
          제안 검토{proposalReady ? ` (${items.length})` : ""}
        </span>
        <button type="button" className="enrich-review-x" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      {/* error — 재시도는 "전체 제안 실행" 버튼으로(여기선 닫기). */}
      {status === "failed" && (
        <div className="enrich-review-err">
          {failDetail ?? "제안 생성에 실패했습니다."} — 닫고 다시 실행하세요.
        </div>
      )}

      {/* proposal 없이 종료(succeeded/cancelled) — empty. */}
      {(status === "succeeded" || status === "cancelled") && !proposalReady && (
        <div className="enrich-review-empty">제안이 없거나 이미 처리되었습니다.</div>
      )}

      {/* proposal 로딩/파싱 실패. */}
      {proposalReady && proposal.isLoading && (
        <div className="enrich-review-loading">
          <Spinner />
          <span>제안 불러오는 중…</span>
        </div>
      )}
      {proposalReady && proposal.error && (
        <div className="enrich-review-err">{(proposal.error as Error).message}</div>
      )}

      {/* 카드별 제안(수정 가능) — 사람이 수정 후 적용해야 확정(codex 자동 확정 없음 — INVARIANT #1). */}
      {proposalReady && proposal.data && (
        <>
          <div className="enrich-review-meta">
            미분류 <b>{items.length}</b>개 제안
            {skipped > 0 && <> · 격리(skip) {skipped}개</>} — 수정 후 적용하면 사분면·영역이
            확정됩니다.
          </div>

          {items.length === 0 ? (
            <div className="enrich-review-empty">제안 없음 (적용 가능한 카드가 없습니다)</div>
          ) : (
            <div className="enrich-review-rows">
              {items.map((it, i) => (
                <div key={it.id} className="enrich-review-row">
                  <div className="enrich-review-row-title">{it.title ?? it.id}</div>
                  <div className="enrich-review-row-fields">
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
                        <SelectItem value={AREA_NONE}>(영역 미설정)</SelectItem>
                        {AREA_OPTS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {it.reason && <div className="enrich-review-row-reason">{it.reason}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {acceptEnrichAll.error && (
        <div className="enrich-review-err">{(acceptEnrichAll.error as Error).message}</div>
      )}

      <div className="enrich-review-actions">
        {proposalReady && proposal.data && items.length > 0 && (
          <Button
            className="rounded-full px-[18px] text-[13px]"
            disabled={acceptEnrichAll.isPending}
            onClick={handleApplyAll}
          >
            모두 적용 (확정)
          </Button>
        )}
        <Button variant="outline" className="rounded-full text-[13px]" onClick={onClose}>
          닫기
        </Button>
      </div>
    </div>
  );
}
