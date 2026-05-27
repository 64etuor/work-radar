import type { AgentRunView } from "@/bindings";
import { JobCard } from "./JobCard";

export function JobList({
  runs,
  onKill,
}: {
  runs: AgentRunView[];
  onKill: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="jobs-empty">
        아직 잡이 없습니다 — 위 테스트 잡으로 스파인을 확인하세요.
      </div>
    );
  }

  return (
    <div className="jobs-list">
      {runs.map((run) => (
        <JobCard key={run.id} run={run} onKill={() => onKill(run.id)} />
      ))}
    </div>
  );
}
