import type { UseQueryResult } from "@tanstack/react-query";

import type { AgentRunView } from "@/bindings";
import { EmptyState } from "@/components/ui/empty-state";

import { Spinner } from "../Spinner";
import { JobCard } from "./JobCard";

export function JobList({
  runs,
  isLoading = false,
  openLogIds,
  logs,
  onToggleLog,
  onKill,
}: {
  runs: AgentRunView[];
  /** 첫 fetch 중인가 — loading 을 empty("잡 없음" CTA)로 오독하지 않기 위해 분리한다. */
  isLoading?: boolean;
  openLogIds: Set<string>;
  logs: Map<string, UseQueryResult<string, Error>>;
  onToggleLog: (runId: string) => void;
  onKill: (runId: string) => void;
}) {
  if (isLoading) {
    return (
      <section className="jobs-ledger" aria-labelledby="jobs-ledger-title">
        <div className="jobs-list-head">
          <div>
            <span className="jobs-section-kicker">RUN LEDGER</span>
            <h2 id="jobs-ledger-title">최근 실행</h2>
          </div>
        </div>
        <div className="jobs-loading" aria-label="실행 기록 불러오는 중">
          <Spinner size="md" />
          <span className="jobs-loading-line" />
          <span className="jobs-loading-line" />
        </div>
      </section>
    );
  }

  return (
    <section className="jobs-ledger" aria-labelledby="jobs-ledger-title">
      <div className="jobs-list-head">
        <div>
          <span className="jobs-section-kicker">RUN LEDGER</span>
          <h2 id="jobs-ledger-title">최근 실행</h2>
        </div>
        <div className="jobs-list-note">
          <span>{runs.length} RUNS</span>
          <small>상태·한도·결과를 시간순으로 검토합니다.</small>
        </div>
      </div>

      {runs.length === 0 ? (
        <EmptyState className="jobs-empty">
          아직 실행 기록이 없습니다. 새 작업을 실행하거나 진단 경로를 확인해 보세요.
        </EmptyState>
      ) : (
        <div className="jobs-list">
          {runs.map((run) => (
            <JobCard
              key={run.id}
              run={run}
              logOpen={openLogIds.has(run.id)}
              log={logs.get(run.id)}
              onToggleLog={() => onToggleLog(run.id)}
              onKill={() => onKill(run.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
