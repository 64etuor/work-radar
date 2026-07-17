import "./JobsView.css";

import { useState } from "react";

import type { AgentRunView } from "@/bindings";
import {
  useAgentLogs,
  useAgentRuns,
  useCodexStatus,
  useKillAgentRun,
  useTriggerCodexJob,
  useTriggerEchoJob,
} from "@/lib/query";
import { useScrollRestore } from "@/lib/useScrollRestore";

import { JobControls } from "./JobControls";
import { JobList } from "./JobList";
import { isActiveJobStatus } from "./jobsConstants";
import { JobsHeader } from "./JobsHeader";

function summarizeRuns(runs: AgentRunView[]) {
  return runs.reduce(
    (summary, run) => {
      if (run.status === "proposed" || run.status === "running") summary.active += 1;
      if (run.status === "awaiting_approval") summary.approval += 1;
      if (run.status === "failed") summary.failed += 1;
      if (run.status === "succeeded") summary.completed += 1;
      return summary;
    },
    { active: 0, approval: 0, failed: 0, completed: 0 },
  );
}

/**
 * Jobs (Agent 스파인, Phase 7) — 잡 큐를 표시하고 테스트 잡을 트리거한다. 모든 잡은 bound되며
 * (timeout/max_turns/cost_cap/kill, INVARIANT #5) agent_runs에 영속된다(INVARIANT #7).
 * codex 미설치/미인증이면 codex 트리거는 비활성(graceful degrade) — 나머지(echo·목록·kill)는 정상.
 */
export function JobsView() {
  const runs = useAgentRuns();
  const codex = useCodexStatus();
  const echoJob = useTriggerEchoJob();
  const codexJob = useTriggerCodexJob();
  const killJob = useKillAgentRun();

  const [prompt, setPrompt] = useState("");
  const [openLogIds, setOpenLogIds] = useState<Set<string>>(new Set());
  const scrollRef = useScrollRestore("jobs");
  const list = runs.data ?? [];
  const openLogIdList: string[] = [];
  const activeLogRunIds = new Set<string>();
  for (const run of list) {
    if (!openLogIds.has(run.id)) continue;
    openLogIdList.push(run.id);
    // 로그 폴링은 running/proposed 동안만 — 종료된 잡 로그는 더 변하지 않는다.
    if (run.status === "running" || run.status === "proposed") activeLogRunIds.add(run.id);
  }
  const logs = useAgentLogs(openLogIdList, activeLogRunIds);
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;
  const summary = summarizeRuns(list);
  const toggleLog = (runId: string) => {
    setOpenLogIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div className="jobs">
      <JobsHeader
        fetching={runs.isFetching}
        tracking={list.some((r) => isActiveJobStatus(r.status))}
        summary={summary}
      />

      <div className="jobs-scroll" ref={scrollRef}>
        <JobControls
          codexReady={codexReady}
          codexDetail={codex.data?.detail}
          codexVersion={codex.data?.version}
          prompt={prompt}
          echoJob={echoJob}
          codexJob={codexJob}
          onPromptChange={setPrompt}
          onCodexSuccess={() => setPrompt("")}
        />
        <JobList
          runs={list}
          isLoading={runs.isLoading}
          openLogIds={openLogIds}
          logs={logs}
          onToggleLog={toggleLog}
          onKill={(runId) => killJob.mutate(runId)}
        />
      </div>
    </div>
  );
}
