import { useEffect, useRef, useState } from "react";

import type { AreaTag, BatchEnrichItem, Quadrant } from "@/bindings";
import { commands } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import {
  useAcceptEnrichAll,
  useBatchEnrichProposal,
} from "@/lib/query";
import { unwrap } from "@/lib/query/client";
import { useToastStore } from "@/lib/toast";

/** 닫힌 세트 옵션(JobsView BatchEnrichPanel에서 미러 — 인라인 이전). */
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

/** terminal 상태 — 도달하면 폴링 중단(INVARIANT #5: 무한 폴링 없음). */
const TERMINAL = new Set(["awaiting_approval", "succeeded", "failed", "cancelled"]);

type Props = {
  /** trigger_enrich_all이 만든 잡 id(폴링 대상). */
  runId: string;
  /** 패널 닫기(부모가 enrichAllRunId를 null로). */
  onClose: () => void;
};

/**
 * EnrichReviewPanel — "전체 제안 실행" 완료 시 **보드 내 인라인** 제안 검토 패널 (Phase 8 #2).
 *
 * 오버레이 모달이 아니다(카드 계속 보임 — 결정 맥락 유지, DESIGN enrich-review-panel). 잡을 1초마다
 * 폴링하다 awaiting_approval에 도달하면 카드별 제안(사분면/영역/근거)을 **수정 가능**하게 보여주고,
 * 사람이 수정 후 `모두 적용`해야 반영된다(자동 적용 절대 금지 — INVARIANT #1). accept 경로는 기존
 * useAcceptEnrichAll(awaiting_approval → accept_enrich_all → suggested_* 힌트만) 그대로 재사용한다.
 *
 * 상태: running=진행 표시 · empty="제안 없음" · error=재시도(잡 reject은 부모가 닫기로 처리) ·
 * partial=skipped 카운트 노출. (Jobs 페이지 BatchEnrichPanel을 점프 없이 인라인으로 이전.)
 */
export function EnrichReviewPanel({ runId, onClose }: Props) {
  const { pushSuccess, pushError } = useToastStore();
  const acceptEnrichAll = useAcceptEnrichAll();

  const [status, setStatus] = useState<string>("proposed");
  const [hasProposal, setHasProposal] = useState(false);
  const [failDetail, setFailDetail] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // awaiting_approval + proposal 있을 때만 카드별 제안 로드(파싱 실패는 즉시 노출).
  const proposalReady = status === "awaiting_approval" && hasProposal;
  const proposal = useBatchEnrichProposal(proposalReady ? runId : null, proposalReady);

  // 편집 가능한 로컬 사본(제안 로드 시 시드).
  const [draft, setDraft] = useState<BatchEnrichItem[] | null>(null);
  useEffect(() => {
    if (proposal.data && !draft) setDraft(proposal.data.items);
  }, [proposal.data, draft]);

  // 폴링(1초 주기, terminal에서 중단 — INVARIANT #5).
  useEffect(() => {
    const poll = async () => {
      try {
        const s = await unwrap(commands.agentRunStatus(runId));
        setStatus(s.status);
        setHasProposal(s.hasProposal);
        if (s.status === "failed") setFailDetail(s.detail ?? "알 수 없는 오류");
        if (TERMINAL.has(s.status) && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (e) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setFailDetail(String(e));
        setStatus("failed");
      }
    };
    void poll();
    intervalRef.current = setInterval(() => void poll(), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

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
          pushSuccess(`제안 ${applied}건 힌트 적용됨 (자동 분류 없음)`);
          onClose();
        },
        onError: (e) => pushError("codex", `적용 실패: ${String(e)}`),
      },
    );
  };

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

      {/* running — 진행 표시(영구 로컬 fallback). */}
      {!TERMINAL.has(status) && (
        <div className="enrich-review-loading">
          <Spinner />
          <span>codex 분석 중… (백그라운드 — 보드는 계속 사용 가능)</span>
        </div>
      )}

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

      {/* 카드별 제안(수정 가능) — 사람이 수정 후 적용해야 반영(자동 적용 금지). */}
      {proposalReady && proposal.data && (
        <>
          <div className="enrich-review-meta">
            미분류 <b>{items.length}</b>개 제안
            {skipped > 0 && <> · 격리(skip) {skipped}개</>} — 수정 후 적용해야 반영(자동 분류 없음).
          </div>

          {items.length === 0 ? (
            <div className="enrich-review-empty">제안 없음 (적용 가능한 카드가 없습니다)</div>
          ) : (
            <div className="enrich-review-rows">
              {items.map((it, i) => (
                <div key={it.id} className="enrich-review-row">
                  <div className="enrich-review-row-title">{it.title ?? it.id}</div>
                  <div className="enrich-review-row-fields">
                    <select
                      className="enrich-review-select"
                      aria-label="제안 사분면"
                      value={it.suggestedQuadrant ?? "unclassified"}
                      onChange={(e) =>
                        setItem(i, { suggestedQuadrant: e.target.value as Quadrant })
                      }
                    >
                      {QUADRANT_OPTS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="enrich-review-select"
                      aria-label="제안 영역"
                      value={it.suggestedArea ?? ""}
                      onChange={(e) =>
                        setItem(i, {
                          suggestedArea: (e.target.value || null) as AreaTag | null,
                        })
                      }
                    >
                      <option value="">(영역 미설정)</option>
                      {AREA_OPTS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
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
          <button
            type="button"
            className="enrich-review-apply"
            disabled={acceptEnrichAll.isPending}
            onClick={handleApplyAll}
          >
            모두 적용 (힌트 반영)
          </button>
        )}
        <button type="button" className="enrich-review-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
