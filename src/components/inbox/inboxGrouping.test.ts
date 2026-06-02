import { describe, expect, it } from "vitest";

import type { InboxItem } from "@/bindings";

import { groupInboxBySource, inferTargetView, labelSource } from "./inboxGrouping";

function item(partial: Partial<InboxItem> & Pick<InboxItem, "source">): InboxItem {
  return {
    id: partial.id ?? `${partial.source}-${Math.random()}`,
    projectId: null,
    source: partial.source,
    sourceId: partial.sourceId ?? null,
    groupKey: partial.groupKey ?? null,
    title: partial.title ?? "t",
    body: partial.body ?? "",
    summary: partial.summary ?? null,
    priority: partial.priority ?? "normal",
    severity: partial.severity ?? "info",
    status: partial.status ?? "open",
    unread: partial.unread ?? true,
    relatedEntityType: partial.relatedEntityType ?? null,
    relatedEntityId: partial.relatedEntityId ?? null,
    actionPayload: partial.actionPayload ?? null,
    readAt: null,
    dismissedAt: null,
    createdAt: "2026-06-02 00:00:00",
    updatedAt: "2026-06-02 00:00:00",
  };
}

describe("groupInboxBySource", () => {
  it("returns [] for empty input", () => {
    expect(groupInboxBySource([])).toEqual([]);
  });

  it("groups a single source into one section preserving item order", () => {
    const items = [
      item({ source: "pr_radar", id: "a", severity: "warning" }),
      item({ source: "pr_radar", id: "b", severity: "critical" }),
    ];
    const groups = groupInboxBySource(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe("pr_radar");
    expect(groups[0].label).toBe("PR Radar");
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("splits multiple sources into separate sections", () => {
    const groups = groupInboxBySource([
      item({ source: "pr_radar" }),
      item({ source: "notification" }),
      item({ source: "pr_radar" }),
    ]);
    expect(groups.map((g) => g.source).sort()).toEqual(["notification", "pr_radar"]);
    const pr = groups.find((g) => g.source === "pr_radar");
    expect(pr?.items).toHaveLength(2);
  });

  it("orders sections by top severity, then unread count, then source key", () => {
    const groups = groupInboxBySource([
      // notification: only info, 1 unread
      item({ source: "notification", severity: "info", unread: true }),
      // pr_radar: has a critical → should sort first
      item({ source: "pr_radar", severity: "critical", unread: false }),
      item({ source: "pr_radar", severity: "info", unread: true }),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["pr_radar", "notification"]);
    expect(groups[0].topSeverityRank).toBe(0);
    expect(groups[0].unread).toBe(1);
  });

  it("breaks severity/unread ties by source key for stable ordering", () => {
    const groups = groupInboxBySource([
      item({ source: "zeta", severity: "info", unread: true }),
      item({ source: "alpha", severity: "info", unread: true }),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["alpha", "zeta"]);
  });

  it("exposes unknown sources verbatim (incremental sources need no roster)", () => {
    const groups = groupInboxBySource([item({ source: "future_source" })]);
    expect(groups[0].label).toBe("future_source");
  });
});

describe("labelSource", () => {
  it("maps known sources and passes unknown through", () => {
    expect(labelSource("pr_radar")).toBe("PR Radar");
    expect(labelSource("notification")).toBe("Mac 알림");
    expect(labelSource("agent")).toBe("Agent");
    expect(labelSource("whatever")).toBe("whatever");
  });
});

describe("inferTargetView", () => {
  it("routes pr_radar/pr → radar, agent → jobs, notification → null", () => {
    expect(inferTargetView(item({ source: "pr_radar" }))).toBe("radar");
    expect(inferTargetView(item({ source: "agent" }))).toBe("jobs");
    expect(inferTargetView(item({ source: "notification" }))).toBeNull();
    expect(inferTargetView(item({ source: "x", relatedEntityType: "worktree" }))).toBe("worktree");
    expect(inferTargetView(item({ source: "x" }))).toBe("today");
  });
});
