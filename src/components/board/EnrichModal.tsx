import { useEffect, useRef, useState } from "react";

import type { AreaTag, EnrichProposal, Quadrant } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import {
  useAcceptEnrich,
  useEnrichProposal,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";
import { commands } from "@/bindings";
import { unwrap } from "@/lib/query/client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

/** area select 미설정 센티넬 — radix Select는 빈 문자열 value를 허용하지 않는다. */
const AREA_NONE = "__none__";

/** EnrichModal에서 사용하는 닫힌 세트 옵션들 (JobsView.tsx EnrichPanel에서 미러). */
const QUADRANT_OPTS: { value: Quadrant; label: string }[] = [
  { value: "unclassified", label: "미분류" },
  { value: "q1_do_now", label: "Q1 지금" },
  { value: "q2_schedule", label: "Q2 일정" },
  { value: "q3_quick_contain", label: "Q3 빠르게" },
  { value: "q4_drop", label: "Q4 버림" },
];
const AREA_OPTS: { value: AreaTag; label: string }[] = [
  { value: "health", label: "건강" },
  { value: "work", label: "업무" },
  { value: "studies", label: "학습" },
  { value: "environment", label: "환경" },
  { value: "recreation", label: "휴식" },
  { value: "romance", label: "연애" },
  { value: "family", label: "가족" },
  { value: "finances", label: "재정" },
  { value: "friends", label: "친구" },
  { value: "other", label: "기타" },
];

/** terminal 상태 — 이 상태에 도달하면 폴링 중단. */
const TERMINAL = new Set(["awaiting_approval", "succeeded", "failed", "cancelled"]);

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
 * INVARIANT #1 준수: accept는 accept_enrich를 통해 suggested_* 힌트만 씀(quadrant 자동 확정 없음).
 * gated 잡 유지: trigger_enrich는 변경하지 않음 — 모달은 폴링만 함.
 */
export function EnrichModal({ runId, onClose }: Props) {
  const { pushSuccess, pushError } = useToastStore();
  const acceptEnrich = useAcceptEnrich();

  // 폴링 상태
  const [status, setStatus] = useState<string>("proposed");
  const [hasProposal, setHasProposal] = useState(false);
  const [failDetail, setFailDetail] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 편집 가능한 proposal 초안
  const [draft, setDraft] = useState<EnrichProposal | null>(null);

  // proposal 로드 (awaiting_approval + has_proposal일 때만)
  const proposalReady = status === "awaiting_approval" && hasProposal;
  const proposal = useEnrichProposal(proposalReady ? runId : null, proposalReady);

  // proposal 로드되면 draft 시드
  useEffect(() => {
    if (proposal.data && !draft) {
      setDraft(proposal.data);
    }
  }, [proposal.data, draft]);

  // 폴링 시작 (1초 주기, terminal에서 중단)
  useEffect(() => {
    const poll = async () => {
      try {
        const s = await unwrap(commands.agentRunStatus(runId));
        setStatus(s.status);
        setHasProposal(s.hasProposal);
        if (s.status === "failed") {
          setFailDetail(s.detail ?? "알 수 없는 오류");
        }
        if (TERMINAL.has(s.status)) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      } catch (e) {
        // 잡을 못 찾으면 폴링 중단
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setFailDetail(String(e));
        setStatus("failed");
      }
    };

    void poll(); // 즉시 1회 실행
    intervalRef.current = setInterval(() => void poll(), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

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
          pushSuccess("AI 제안 힌트 적용됨 (자동 분류 없음)");
          onClose();
        },
        onError: (e) => pushError("codex", `수락 실패: ${String(e)}`),
      },
    );
  };

  const handleCancel = async () => {
    // running/proposed 상태이면 kill (terminal이면 그냥 닫기)
    if (status === "running" || status === "proposed") {
      try {
        await unwrap(commands.killAgentRun(runId));
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
        <DialogTitle className="font-mono text-[13px] font-semibold uppercase tracking-[0.1em]">
          AI 제안 — 영역 / 사분면
        </DialogTitle>

        {/* 실행 중 스피너 */}
        {!TERMINAL.has(status) && (
          <div className="enrich-modal-loading">
            <Spinner />
            <span>codex 분석 중…</span>
          </div>
        )}

        {/* 실패 */}
        {status === "failed" && (
          <div className="enrich-modal-err">
            {failDetail ?? "제안 생성에 실패했습니다."}
          </div>
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
          <div className="enrich-modal-err">
            {(proposal.error as Error).message}
          </div>
        )}

        {/* 편집 가능한 제안 폼 (suggested-only — INVARIANT #1) */}
        {proposalReady && proposal.data && (
          <>
            <label className="enrich-modal-label">제안 사분면 (힌트 — 자동 분류 아님)</label>
            <Select
              value={d.suggestedQuadrant ?? "unclassified"}
              onValueChange={(v) =>
                setDraft({ ...d, suggestedQuadrant: v as Quadrant })
              }
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

            <label className="enrich-modal-label">제안 영역 (라이프 도메인)</label>
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
              수락하면 카드에 <b>제안 힌트</b>로만 표시됩니다 — 사분면 분류·영역 확정은
              보드에서 직접(자동 분류 없음).
            </div>
          </>
        )}

        {acceptEnrich.error && (
          <div className="enrich-modal-err">
            {(acceptEnrich.error as Error).message}
          </div>
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
          <Button
            variant="outline"
            className="rounded-full"
            onClick={() => void handleCancel()}
          >
            {status === "running" || status === "proposed" ? "취소" : "닫기"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
