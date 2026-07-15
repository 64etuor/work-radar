import "./PrRadarView.css";

import { useQueries, useQueryClient } from "@tanstack/react-query";

import type { PrRadarItem } from "@/bindings";
import type { PrRadarDeskActions, PrRadarDeskStatus } from "@/components/pr-radar/PrRadarDesk";
import { PrRadarDesk } from "@/components/pr-radar/PrRadarDesk";
import {
  fetchPrRadar,
  openExternal,
  PR_RADAR_POLL_MS,
  useCodexStatus,
  useProjects,
  usePrRadarSettings,
  useTriggerCiTriage,
  useTriggerCodexJob,
  useTriggerPrSelfcheck,
} from "@/lib/query";
import { useScrollRestore } from "@/lib/useScrollRestore";
import { useUIStore } from "@/store";

export function PrRadarView() {
  const { goTo } = useUIStore();
  const queryClient = useQueryClient();
  const scrollRef = useScrollRestore("radar");
  const projects = useProjects();
  const projectList = projects.data ?? [];
  const codex = useCodexStatus();
  const settings = usePrRadarSettings();
  const selfcheckDraft = useTriggerPrSelfcheck();
  const ciTriage = useTriggerCiTriage();
  const aiEscalation = useTriggerCodexJob();
  const codexReady = Boolean(codex.data?.installed && codex.data?.authed);

  const results = useQueries({
    queries: projectList.map((project) => ({
      queryKey: ["prRadar", project.id],
      queryFn: async () => {
        const items = await fetchPrRadar(project.id);
        void queryClient.invalidateQueries({ queryKey: ["signals"] });
        return items;
      },
      refetchInterval:
        Math.max(1, settings.data?.pollIntervalMinutes ?? PR_RADAR_POLL_MS / 60_000) * 60_000,
      refetchOnWindowFocus: false,
      retry: 2,
    })),
  });

  const items = results.flatMap((result) => result.data ?? []);
  const isFetching = projects.isFetching || results.some((result) => result.isFetching);
  const pollingErrors = [projects.error, ...results.map((result) => result.error)].filter(
    (error): error is Error => error !== null,
  );
  const noProjects = projects.data !== undefined && projectList.length === 0;

  const status: PrRadarDeskStatus = {
    isFetching,
    pollIntervalMinutes: settings.data?.pollIntervalMinutes ?? 10,
    noProjects,
    pollingErrors:
      pollingErrors.length > 0
        ? [`일부 폴링 실패: ${pollingErrors.map((error) => error.message).join(" · ")}`]
        : [],
    actionErrors: [
      selfcheckDraft.error ? `코드 리뷰 실패: ${selfcheckDraft.error.message}` : null,
      ciTriage.error ? `CI triage 실패: ${ciTriage.error.message}` : null,
      aiEscalation.error ? `AI escalation 실패: ${aiEscalation.error.message}` : null,
    ].filter((message): message is string => message !== null),
  };

  const actions: PrRadarDeskActions = {
    codexReady,
    commentThreshold: settings.data?.commentAlertThreshold ?? 10,
    drafting: selfcheckDraft.isPending,
    triaging: ciTriage.isPending,
    escalating: aiEscalation.isPending,
    onSelfcheckDraft: (item) => {
      selfcheckDraft.mutate(
        {
          projectId: item.projectId,
          repoFullName: item.repoFullName,
          prNumber: item.number,
          prUrl: item.url,
          timeoutSec: 120,
          maxTurns: 8,
          costCapUsd: 1.0,
        },
        { onSuccess: () => goTo("jobs") },
      );
    },
    onCiTriage: (item) => {
      ciTriage.mutate(
        {
          projectId: item.projectId,
          repoFullName: item.repoFullName,
          prNumber: item.number,
          prUrl: item.url,
          timeoutSec: 120,
          maxTurns: 8,
          costCapUsd: 1.0,
        },
        { onSuccess: (output) => goTo(output.escalated ? "board" : "jobs") },
      );
    },
    onAiEscalation: (item) => {
      aiEscalation.mutate(
        {
          projectId: item.projectId,
          repoId: null,
          agentPromptBinding: null,
          prompt: prEscalationPrompt(item),
          timeoutSec: 180,
          maxTurns: 8,
          costCapUsd: 1.0,
        },
        { onSuccess: () => goTo("jobs") },
      );
    },
    onOpen: (item) => void openExternal(item.url),
  };

  return <PrRadarDesk items={items} status={status} actions={actions} scrollRef={scrollRef} />;
}

function prEscalationPrompt(item: PrRadarItem): string {
  return [
    "Analyze this PR Radar escalation and produce an Inbox-ready operational summary.",
    `Repository: ${item.repoFullName}`,
    `PR: #${item.number} ${item.title}`,
    `URL: ${item.url}`,
    `Author: @${item.authorLogin}`,
    `Comments: ${item.commentCount}`,
    `CI: ${item.ci}`,
    `Conflict: ${item.hasConflict}`,
    `Bucket: ${item.bucket}`,
    "Required analysis:",
    "- root cause of code/review friction",
    "- architectural bottlenecks",
    "- repeated review points",
    "- dependency or team ownership candidates",
    "- concrete next action shortcuts",
    "Do not mutate GitHub. Return concise bullets.",
  ].join("\n");
}
