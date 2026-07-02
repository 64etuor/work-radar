import { describe, expect, it } from "vitest";

import type { BookkeepingSyncJob } from "@/bindings";

import {
  formatMmbakImportSummary,
  formatMmbakJobHint,
  latestMoneyManagerJob,
  normalizeWatchDir,
} from "./mmbakImport";

function job(overrides: Partial<BookkeepingSyncJob>): BookkeepingSyncJob {
  return {
    id: "job-1",
    source: "moneymanager",
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    sanitizedErrorCode: null,
    sanitizedErrorMessage: null,
    scannedCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    reviewNeededCount: 0,
    failedCount: 0,
    cursorBefore: null,
    cursorAfter: null,
    createdAt: "2026-07-01 00:00:00",
    updatedAt: "2026-07-01 00:00:00",
    ...overrides,
  };
}

describe("normalizeWatchDir", () => {
  it("maps empty/whitespace input to null (unset)", () => {
    expect(normalizeWatchDir("")).toBeNull();
    expect(normalizeWatchDir("   ")).toBeNull();
  });

  it("keeps a trimmed path", () => {
    expect(normalizeWatchDir("  /Users/me/Drive/MoneyManager  ")).toBe(
      "/Users/me/Drive/MoneyManager",
    );
  });
});

describe("formatMmbakImportSummary", () => {
  it("summarizes scanned/imported/duplicate/failed counts in Korean", () => {
    expect(
      formatMmbakImportSummary({
        scannedCount: 12,
        importedCount: 3,
        duplicateCount: 8,
        skippedCount: 1,
        failedCount: 0,
        flaggedDeletedCount: 0,
        dupProbeSkippedCount: 0,
        cursorAfter: "200",
      }),
    ).toBe("백업 12건 확인, 3건 추가, 8건 갱신, 0건 실패");
  });
});

describe("latestMoneyManagerJob", () => {
  it("returns null when there is no moneymanager job", () => {
    expect(latestMoneyManagerJob([])).toBeNull();
    expect(latestMoneyManagerJob([job({ source: "gmail" })])).toBeNull();
  });

  it("picks the newest moneymanager job by updatedAt, ignoring other sources", () => {
    const older = job({ id: "old", updatedAt: "2026-07-01 00:00:00" });
    const newer = job({ id: "new", updatedAt: "2026-07-02 09:00:00" });
    const gmail = job({ id: "gmail", source: "gmail", updatedAt: "2026-07-03 00:00:00" });
    expect(latestMoneyManagerJob([older, gmail, newer])?.id).toBe("new");
  });
});

describe("formatMmbakJobHint", () => {
  it("labels succeeded jobs as 성공 with imported count and timestamp", () => {
    expect(formatMmbakJobHint(job({ importedCount: 5, updatedAt: "2026-07-02 09:00:00" }))).toBe(
      "최근 가져오기 성공 · 5건 추가 (2026-07-02 09:00:00)",
    );
  });

  it("labels failed jobs as 실패", () => {
    expect(formatMmbakJobHint(job({ status: "failed" }))).toBe(
      "최근 가져오기 실패 · 0건 추가 (2026-07-01 00:00:00)",
    );
  });
});
