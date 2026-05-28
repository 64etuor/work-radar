import "./EnrichModal.css";

import { useEffect, useState } from "react";

import type { AreaTag, EnrichProposal, Quadrant } from "@/bindings";
import { AREA_NONE, AREA_OPTS, QUADRANT_OPTS } from "@/components/jobs/jobsConstants";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AGENT_TERMINAL_STATUSES,
  useAcceptEnrich,
  useAgentRunStatus,
  useEnrichProposal,
  useKillAgentRun,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";

type Props = {
  runId: string;
  onClose: () => void;
};

/**
 * EnrichModal — 단일 카드 enrich 결과를 인플레이스 모달로 표시 (B3).
 *
 * 동작:
 *  1. runId를 받아 agent_run_status를 1초마다 폴링한다.
 *  2. terminal 상태에 도달하면 폴링 멈춤.
 *  3. awaiting_approval → enrich_proposal 로드 → 편집 가능한 폼 표시.
 *  4. 수락: accept_enrich(runId, editedProposal) → 성공 toast → 닫기.
 *  5. 취소/거절: kill_agent_run(runId) → 닫기 (running/proposed일 때) 또는 그냥 닫기.
 *  6. failed: detail 텍스트를 error toast로 표시 + 닫기 버튼만.
 *
 * INVARIANT #5 준수: 폴링은 terminal 상태에서 중단(무한 폴링 없음).
 * INVARIANT #1 준수: codex는 절대 확정하지 않는다(proposal만 생성). 사람이 검토·편집 후 accept를 클릭하면
 *   accept_enrich가 quadrant+area를 확정(제안에 quadrant 없으면 기존 분류 보존, COALESCE) + 힌트 비움.
 * gated 잡 유지: trigger_enrich는 변경하지 않음 — 모달은 폴링만 함.
 */
export function EnrichModal({ runId, onClose }: Props) {
  const { pushSuccess, pushError } = useToastStore();
  const acceptEnrich = useAcceptEnrich();

  // 잡 상태 — query 레이어가 폴링/중단/에러 처리 단일화(INVARIANT #5: terminal 자동 정지).
  const runStatus = useAgentRunStatus(runId);
  const status: string = runStatus.isError ? "failed" : (runStatus.data?.status ?? "proposed");
  const hasProposal = runStatus.data?.hasProposal ?? false;
  const failDetail: string | null = runStatus.isError
    ? String(runStatus.error)
    : runStatus.data?.status === "failed"
      ? (runStatus.data.detail ?? "알 수 없는 오류")
      : null;

  // 편집 가능한 proposal 초안
  const [draft, setDraft] = useState<EnrichProposal | null>(null);

  // proposal 로드 (awaiting_approval + has_proposal일 때만)
  const proposalReady = status === "awaiting_approval" && hasProposal;
  const proposal = useEnrichProposal(proposalReady ? runId : null, proposalReady);

  // proposal 로드 시 draft 시드 (한 번만 — 이후 server push가 user 편집을 덮지 않음).
  // prev-compare로 render에서 적용 (set-state-in-effect 회피).
  const [seeded, setSeeded] = useState(false);
  if (proposal.data && !seeded) {
    setSeeded(true);
    setDraft(proposal.data);
  }

  // Esc/외부 클릭/창 양보는 PR 0 Dialog 래퍼(overlay-stack 계약)가 전담(plan §0.6).

  // 실패 시 error toast
  useEffect(() => {
    if (status === "failed" && failDetail) {
      pushError("codex", `AI 제안 실패: ${failDetail}`);
    }
  }, [status, failDetail, pushError]);

  const handleAccept = () => {
    const d = draft ?? proposal.data;
    if (!d) return;
    acceptEnrich.mutate(
      { runId, accepted: d },
      {
        onSuccess: () => {
          pushSuccess("AI 제안 확정됨 (사분면·영역)");
          onClose();
        },
        onError: (e) => pushError("codex", `수락 실패: ${String(e)}`),
      },
    );
  };

  const killAgentRun = useKillAgentRun();
  const handleCancel = async () => {
    // running/proposed 상태이면 kill (terminal이면 그냥 닫기). kill 실패는 닫기에 영향 없음.
    if (status === "running" || status === "proposed") {
      try {
        await killAgentRun.mutateAsync(runId);
      } catch {
        // kill 실패는 무시하고 닫음
      }
    }
    onClose();
  };

  const d: EnrichProposal = draft ??
    proposal.data ?? { suggestedQuadrant: null, suggestedArea: null, reason: null };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        className="max-h-[78vh] w-[min(400px,92vw)] max-w-none gap-3 overflow-y-auto p-5"
      >
        <DialogTitle className="font-mono text-[13px] font-semibold tracking-[0.1em] uppercase">
          AI 제안 — 영역 / 사분면
        </DialogTitle>

        {/* 실행 중 스피너 */}
        {!AGENT_TERMINAL_STATUSES.has(status) && (
          <div className="enrich-modal-loading">
            <Spinner />
            <span>codex 분석 중…</span>
          </div>
        )}

        {/* 실패 */}
        {status === "failed" && (
          <div className="enrich-modal-err">{failDetail ?? "제안 생성에 실패했습니다."}</div>
        )}

        {/* 취소/완료 (proposal 없이 succeeded/cancelled) */}
        {(status === "succeeded" || status === "cancelled") && !proposalReady && (
          <div className="enrich-modal-hint">제안이 없거나 이미 처리되었습니다.</div>
        )}

        {/* Proposal 로딩 중 */}
        {proposalReady && proposal.isLoading && (
          <div className="enrich-modal-loading">
            <Spinner />
            <span>제안 불러오는 중…</span>
          </div>
        )}

        {/* Proposal 파싱 실패 */}
        {proposalReady && proposal.error && (
          <div className="enrich-modal-err">{(proposal.error as Error).message}</div>
        )}

        {/* 편집 가능한 제안 폼 — accept 시 quadrant+area 확정(사람 결정 레일, INVARIANT #1) */}
        {proposalReady && proposal.data && (
          <>
            <label className="enrich-modal-label">사분면 (accept 시 확정)</label>
            <Select
              value={d.suggestedQuadrant ?? "unclassified"}
              onValueChange={(v) => setDraft({ ...d, suggestedQuadrant: v as Quadrant })}
            >
              <SelectTrigger>
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

            <label className="enrich-modal-label">영역 (accept 시 확정)</label>
            <Select
              value={d.suggestedArea ?? AREA_NONE}
              onValueChange={(v) =>
                setDraft({
                  ...d,
                  suggestedArea: v === AREA_NONE ? null : (v as AreaTag),
                })
              }
            >
              <SelectTrigger>
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

            <label className="enrich-modal-label">근거</label>
            <Textarea
              rows={2}
              value={d.reason ?? ""}
              onChange={(e) => setDraft({ ...d, reason: e.target.value })}
            />

            <div className="enrich-modal-hint">
              accept하면 카드의 <b>사분면·영역이 확정</b>됩니다 — codex 자동 확정이 아니라 지금
              사람이 확인한 결과(드래그/키보드 분류와 동일 결정 레일).
            </div>
          </>
        )}

        {acceptEnrich.error && (
          <div className="enrich-modal-err">{(acceptEnrich.error as Error).message}</div>
        )}

        <div className="enrich-modal-actions">
          {/* 수락 버튼: awaiting_approval + proposal 있을 때만 */}
          {proposalReady && proposal.data && (
            <Button
              className="rounded-full px-[22px]"
              disabled={acceptEnrich.isPending}
              onClick={handleAccept}
            >
              수락
            </Button>
          )}
          <Button variant="outline" className="rounded-full" onClick={() => void handleCancel()}>
            {status === "running" || status === "proposed" ? "취소" : "닫기"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
