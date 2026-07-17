import "./AgentRunModal.css";
import "@/components/jobs/JobsView.css";

import { useState } from "react";

import { JobCard } from "@/components/jobs/JobCard";
import { JOB_STATUS } from "@/components/jobs/jobsConstants";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAckAgentRun, useAgentLogs, useAgentRuns, useKillAgentRun } from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * 글로벌 agent_runs 결과 모달 — 에이전트 상태 바 박스 클릭으로만 열린다(자동 오픈 없음).
 *
 * 모든 내부 codex 잡(echo / enrich_batch / triage_ci / draft_pr_selfcheck 등)에
 * 동일한 진입점을 제공한다. `JobCard`를 그대로 재사용해 status 별 표시(badge/detail/log/cost)와
 * awaiting_approval 시 `ProposalPanel` per-kind 디스패치를 한 곳에서 처리한다.
 *
 * INVARIANT #1: 표시 전용 — 어떤 결정도 자동 적용하지 않는다. awaiting_approval accept는 사람이.
 * 모달 close 시 SQLite SSOT(`agent_runs.acked_at`)에 무조건 마킹한다. 활성 잡은 표시 로직이
 * 우선 노출하므로 ack가 와도 보이고, 종료되는 순간 acked로 바에서 자동으로 사라진다.
 * 이전 localStorage 정책(`ackedRunIds`)은 cap-trim/캐시 클리어 회귀 때문에 폐기됨.
 */
export function AgentRunModal() {
  const openAgentRunId = useUIStore((s) => s.openAgentRunId);
  const setOpen = useUIStore((s) => s.setOpenAgentRunId);
  const ackAgentRun = useAckAgentRun();

  const runs = useAgentRuns();
  const run = runs.data?.find((r) => r.id === openAgentRunId) ?? null;
  const killAgentRun = useKillAgentRun();

  const [logOpen, setLogOpen] = useState(false);
  // 로그 펼친 동안에만 폴링 — JobsView와 동일 패턴(INVARIANT #5 bounded).
  const logIds = logOpen && openAgentRunId ? [openAgentRunId] : [];
  // 잡이 running/proposed일 때만 로그도 폴링 — terminal 잡은 로그가 더 변하지 않는다.
  const isRunActive = run?.status === "running" || run?.status === "proposed";
  const activeLogRunIds =
    isRunActive && openAgentRunId ? new Set([openAgentRunId]) : new Set<string>();
  const logs = useAgentLogs(logIds, activeLogRunIds);

  const handleOpenChange = (next: boolean) => {
    if (next) return;
    if (openAgentRunId) ackAgentRun.mutate(openAgentRunId);
    setOpen(null);
    setLogOpen(false);
  };

  if (!openAgentRunId) return null;

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent className="agent-run-dialog" aria-describedby={undefined}>
        <div className="agent-run-modal jobs">
          <div className="agent-run-head">
            <DialogTitle className="agent-run-title">에이전트 결과</DialogTitle>
            {run && <span className="agent-run-kind">{run.kind}</span>}
            {/* 헤더에서 상태 즉시 식별 — JobCard 배지와 동일 톤(JOB_STATUS 재사용). */}
            {run && (
              <span className={`jobs-badge agent-run-status ${JOB_STATUS[run.status].cls}`}>
                {JOB_STATUS[run.status].label}
              </span>
            )}
          </div>
          <div className="agent-run-scroll">
            {!run ? (
              <div className="agent-run-empty">
                잡 정보를 찾을 수 없습니다. 이미 정리되었거나 동기화 중일 수 있습니다.
              </div>
            ) : (
              <JobCard
                run={run}
                logOpen={logOpen}
                log={logs.get(run.id)}
                onToggleLog={() => setLogOpen((v) => !v)}
                onKill={() => killAgentRun.mutate(run.id)}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
