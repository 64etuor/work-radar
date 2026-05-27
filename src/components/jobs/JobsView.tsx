import { useState } from "react";
import "./JobsView.css";

import {
  useAgentRuns,
  useCodexStatus,
  useKillAgentRun,
  useTriggerCodexJob,
  useTriggerEchoJob,
} from "@/lib/query";
import { CodexStatusBanner } from "./CodexStatusBanner";
import { JobControls } from "./JobControls";
import { JobList } from "./JobList";
import { JobsHeader } from "./JobsHeader";
import { isActiveJobStatus } from "./jobsConstants";

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
  const list = runs.data ?? [];
  const codexReady = !!codex.data?.installed && !!codex.data?.authed;

  return (
    <div className="jobs">
      <JobsHeader
        fetching={runs.isFetching}
        tracking={list.some((r) => isActiveJobStatus(r.status))}
      />

      <div className="jobs-scroll">
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
        <JobList runs={list} onKill={(runId) => killJob.mutate(runId)} />
      </div>
    </div>
  );
}
