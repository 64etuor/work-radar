import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PrRadarItem, ReadinessBucket } from "@/bindings";

import type { PrRadarDeskActions, PrRadarDeskStatus } from "./PrRadarDesk";
import { PrRadarDesk } from "./PrRadarDesk";

function prItem(bucket: ReadinessBucket, overrides: Partial<PrRadarItem> = {}): PrRadarItem {
  return {
    repoFullName: "mirrorless/work-radar",
    number: 42,
    title: "Keep the merge queue legible",
    url: "https://github.com/mirrorless/work-radar/pull/42",
    authorLogin: "reviewer",
    bucket,
    ci: "passing",
    hasConflict: false,
    isDraft: false,
    selfChecked: false,
    ageDays: 1,
    projectId: "project-1",
    commentCount: 2,
    isSuspicious: false,
    hasUnreadAlert: false,
    hasCriticalAlert: false,
    aiFlagged: false,
    ...overrides,
  };
}

const actions: PrRadarDeskActions = {
  codexReady: true,
  commentThreshold: 10,
  drafting: false,
  triaging: false,
  escalating: false,
  onSelfcheckDraft: vi.fn(),
  onCiTriage: vi.fn(),
  onAiEscalation: vi.fn(),
  onOpen: vi.fn(),
};

const readyStatus: PrRadarDeskStatus = {
  isFetching: false,
  pollIntervalMinutes: 10,
  noProjects: false,
  pollingErrors: [],
  actionErrors: [],
};

describe("PrRadarDesk", () => {
  it("orders portfolio pressure, readiness buckets, evidence, and contextual actions", () => {
    const items = [
      prItem("merged_cleanup", { number: 5, title: "Clean merged branch" }),
      prItem("stale", { number: 4, title: "Resume 오래 멈춘 변경", ageDays: 12 }),
      prItem("ready", { number: 3, title: "Ship the ready change" }),
      prItem("needs_self_check", { number: 2, title: "Review the draft", isDraft: true }),
      prItem("ci_blocked", {
        number: 1,
        title: "Fix CI before merge",
        ci: "failing",
        hasConflict: true,
        commentCount: 14,
        hasCriticalAlert: true,
      }),
    ];

    const html = renderToStaticMarkup(
      <PrRadarDesk items={items} status={readyStatus} actions={actions} />,
    );

    expect(html).toContain("CODE / MERGE READINESS");
    expect(html).toContain("<h1>PR Radar</h1>");
    expect(html).toContain('aria-label="PR readiness summary"');
    expect(html).toContain("Attention queue");
    expect(html).toContain("Average age");

    const blockedIndex = html.indexOf("CI Blocked");
    const reviewIndex = html.indexOf("Needs Review");
    const readyIndex = html.indexOf("Ready");
    const staleIndex = html.indexOf("Stale");
    const mergedIndex = html.indexOf("Merged Cleanup");

    expect(blockedIndex).toBeGreaterThan(-1);
    expect(blockedIndex).toBeLessThan(reviewIndex);
    expect(reviewIndex).toBeLessThan(readyIndex);
    expect(readyIndex).toBeLessThan(staleIndex);
    expect(staleIndex).toBeLessThan(mergedIndex);
    expect(html).toContain("Fix CI before merge");
    expect(html).toContain("CI 실패");
    expect(html).toContain("충돌");
    expect(html).toContain("@reviewer");
    expect(html).toContain("코드 리뷰");
    expect(html).toContain("CI triage");
    expect(html).toContain("AI escalation");
    expect(html).toContain("열기");
  });

  it("explains initial polling instead of rendering a blank canvas", () => {
    const html = renderToStaticMarkup(
      <PrRadarDesk items={[]} status={{ ...readyStatus, isFetching: true }} actions={actions} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("첫 PR 목록을 불러오는 중입니다");
  });

  it("prioritizes a polling error over the empty state", () => {
    const html = renderToStaticMarkup(
      <PrRadarDesk
        items={[]}
        status={{ ...readyStatus, pollingErrors: ["프로젝트 목록 실패"] }}
        actions={actions}
      />,
    );

    expect(html).toContain("프로젝트 목록 실패");
    expect(html).not.toContain("표시할 PR이 없습니다");
  });

  it("does not offer proposal actions for merged cleanup rows", () => {
    const html = renderToStaticMarkup(
      <PrRadarDesk
        items={[prItem("merged_cleanup", { title: "Clean merged branch" })]}
        status={readyStatus}
        actions={actions}
      />,
    );

    expect(html).not.toContain("코드 리뷰");
    expect(html).not.toContain("CI triage");
    expect(html).not.toContain("AI escalation");
    expect(html).toContain("열기");
  });
});
