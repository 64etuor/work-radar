import type { UseQueryResult } from "@tanstack/react-query";
import { FileText, Square } from "lucide-react";
import type { AgentRunView } from "@/bindings";
import { JOB_STATUS } from "./jobsConstants";
import { ProposalPanel } from "./ProposalPanel";

export function JobCard({
  run,
  logOpen,
  log,
  onToggleLog,
  onKill,
}: {
  run: AgentRunView;
  logOpen: boolean;
  log: UseQueryResult<string, Error> | undefined;
  onToggleLog: () => void;
  onKill: () => void;
}) {
  const st = JOB_STATUS[run.status];
  // 실행/대기 중에만 kill (awaiting_approval은 프로세스 종료 → accept/reject로 처리).
  const killable = run.status === "running" || run.status === "proposed";

  return (
    <div className="jobs-card">
      <div className="jobs-card-top">
        <span className={`jobs-badge ${st.cls}`}>{st.label}</span>
        <span className="jobs-kind">{run.kind}</span>
        <span className="jobs-engine">{run.engine}</span>
        <span className="jobs-sandbox">{run.sandbox}</span>
        {killable && (
          <button type="button" className="jobs-kill" onClick={onKill}>
            <Square className="size-3" />
            kill
          </button>
        )}
      </div>

      {run.detail && <div className="jobs-detail">{run.detail}</div>}

      <div className="jobs-meta">
        <span title="timeout bound">⏱ {run.timeoutSec}s</span>
        <span title="max turns">↻ {run.maxTurns}턴</span>
        <span title="cost cap">$ {(run.costCapUsd ?? 0).toFixed(2)}</span>
        {run.costTokens != null && <span>· {run.costTokens} tok</span>}
        {run.costUsd != null && <span>· ${run.costUsd.toFixed(4)}</span>}
      </div>

      {run.status === "awaiting_approval" && <ProposalPanel run={run} />}

      <div className="jobs-card-actions">
        <button
          type="button"
          className="jobs-log-toggle"
          onClick={onToggleLog}
        >
          <FileText className="size-3.5" />
          로그 {logOpen ? "닫기" : "보기"}
        </button>
      </div>

      {logOpen && (
        <pre className="jobs-log">
          {log?.isLoading
            ? "로그 불러오는 중…"
            : log?.data?.trim()
              ? log.data
              : "(로그 없음)"}
        </pre>
      )}
    </div>
  );
}
