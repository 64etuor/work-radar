import "./JobsView.css";

import { useState } from "react";

import {
  useAgentLogs,
  useAgentRuns,
  useCodexStatus,
  useKillAgentRun,
  useTriggerCodexJob,
  useTriggerEchoJob,
} from "@/lib/query";
import { useScrollRestore } from "@/lib/useScrollRestore";

import { CodexStatusBanner } from "./CodexStatusBanner";
import { JobControls } from "./JobControls";
import { JobList } from "./JobList";
import { isActiveJobStatus } from "./jobsConstants";
import { JobsHeader } from "./JobsHeader";

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
  for (const run of list) {
    if (openLogIds.has(run.id)) openLogIdList.push(run.id);
  }
  const logs = useAgentLogs(openLogIdList);
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;
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
      />

      <div className="jobs-scroll" ref={scrollRef}>
        <CodexStatusBanner
          ready={codexReady}
          detail={codex.data?.detail}
          version={codex.data?.version}
        />
        <JobControls
          codexReady={codexReady}
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
