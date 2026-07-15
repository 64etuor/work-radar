import { describe, expect, it } from "vitest";

import type { PrRadarItem, ReadinessBucket } from "@/bindings";

import { summarizePrRadar } from "./prRadarModel";

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

describe("summarizePrRadar", () => {
  it("derives readiness pressure without double-counting alerts inside the attention queue", () => {
    const items = [
      prItem("ci_blocked", {
        number: 1,
        ageDays: 12,
        hasCriticalAlert: true,
        isSuspicious: true,
      }),
      prItem("needs_self_check", { number: 2, ageDays: 4, aiFlagged: true }),
      prItem("ready", { number: 3, ageDays: 1 }),
      prItem("stale", { number: 4, ageDays: 9 }),
      prItem("merged_cleanup", { number: 5, ageDays: 0 }),
    ];

    const summary = summarizePrRadar(items);

    expect(summary.total).toBe(5);
    expect(summary.attention).toBe(3);
    expect(summary.critical).toBe(1);
    expect(summary.suspicious).toBe(2);
    expect(summary.averageAgeDays).toBe(5);
    expect(summary.counts).toEqual({
      ci_blocked: 1,
      needs_self_check: 1,
      ready: 1,
      stale: 1,
      merged_cleanup: 1,
    });
  });
});
