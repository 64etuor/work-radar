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
      <div className="jobs-loading">
        <Spinner size="md" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <EmptyState className="jobs-empty">
        아직 잡이 없습니다. 위 테스트 잡으로 스파인을 확인하세요.
      </EmptyState>
    );
  }

  return (
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
  );
}
