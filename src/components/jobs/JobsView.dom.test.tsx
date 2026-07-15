import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunView, AgentStatus } from "@/bindings";

import { JobsView } from "./JobsView";

const mocks: { runs: AgentRunView[] } = vi.hoisted(() => ({ runs: [] }));
const mutate = vi.fn();

vi.mock("@/lib/query", () => ({
  useAgentLogs: () => new Map(),
  useAgentRuns: () => ({
    data: mocks.runs,
    isFetching: false,
    isLoading: false,
  }),
  useCodexStatus: () => ({
    data: { installed: true, authed: true, detail: "codex 준비됨", version: "0.144.4" },
  }),
  useKillAgentRun: () => ({ mutate }),
  useTriggerCodexJob: () => ({ error: null, isPending: false, mutate }),
  useTriggerEchoJob: () => ({ error: null, isPending: false, mutate }),
}));

vi.mock("@/lib/useScrollRestore", () => ({
  useScrollRestore: () => ({ current: null }),
}));

vi.mock("./ProposalPanel", () => ({
  ProposalPanel: () => <div>승인 제안</div>,
}));

function run(status: AgentStatus, overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id: `run-${status}`,
    projectId: null,
    engine: "codex",
    kind: "enrich_batch",
    rail: "suggestion",
    sandbox: "read_only",
    status,
    timeoutSec: 60,
    maxTurns: 8,
    costCapUsd: 1,
    costTokens: 240,
    costUsd: 0.0125,
    repoId: null,
    workdir: null,
    logPath: null,
    detail: status === "failed" ? "인증 토큰을 확인할 수 없어 실행하지 못했습니다." : "작업 요약",
    trigger: null,
    hasProposal: status === "awaiting_approval",
    createdAt: "2026-07-15T02:00:00Z",
    startedAt: "2026-07-15T02:00:01Z",
    heartbeatAt: null,
    recoveryCount: 0,
    finishedAt: status === "succeeded" || status === "failed" ? "2026-07-15T02:00:08Z" : null,
    ackedAt: null,
    ...overrides,
  };
}

describe("JobsView editorial operations ledger", () => {
  it("orients execution around a summary, primary launcher, and semantic run ledger", () => {
    mocks.runs = [run("running"), run("awaiting_approval"), run("failed"), run("succeeded")];

    const html = renderToStaticMarkup(<JobsView />);

    expect(html).toContain("AUTOMATION / RUN LEDGER");
    expect(html).toContain("제안은 검토 후에만 반영됩니다");
    expect(html).toContain('aria-label="활성 작업 1개"');
    expect(html).toContain('aria-label="승인 대기 1개"');
    expect(html).toContain('aria-label="실패 1개"');
    expect(html).toContain('aria-label="완료 1개"');
    expect(html.indexOf("새 작업 실행")).toBeLessThan(html.indexOf("실행 환경 진단"));
    expect(html).toContain('aria-labelledby="jobs-ledger-title"');
    expect(html).toContain('aria-label="실행 중 enrich_batch 실행"');
    expect(html).toContain("<details");
    expect(html).toContain("오류 상세");
  });
});
