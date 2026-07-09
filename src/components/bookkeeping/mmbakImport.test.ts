import { describe, expect, it } from "vitest";

import type { BookkeepingSyncJob, ImportBookkeepingMmbakSummary } from "@/bindings";

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
  function summary(
    overrides: Partial<ImportBookkeepingMmbakSummary> = {},
  ): ImportBookkeepingMmbakSummary {
    return {
      scannedCount: 12,
      importedCount: 3,
      duplicateCount: 8,
      skippedCount: 1,
      failedCount: 0,
      flaggedDeletedCount: 0,
      dupProbeSkippedCount: 0,
      backfilledCategoryCount: 0,
      recurringUpsertedCount: 0,
      recurringArchivedCount: 0,
      recurringSkippedCount: 0,
      cursorAfter: "200",
      ...overrides,
    };
  }

  it("summarizes scanned/imported/duplicate/failed counts in Korean", () => {
    expect(formatMmbakImportSummary(summary())).toBe(
      "백업 12건 확인, 3건 추가, 8건 갱신, 0건 실패",
    );
  });

  it("appends the category backfill count only when non-zero", () => {
    expect(formatMmbakImportSummary(summary({ backfilledCategoryCount: 2 }))).toBe(
      "백업 12건 확인, 3건 추가, 8건 갱신, 0건 실패, 2건 분류 보완",
    );
  });

  it("counts recurring upserts and archives together as one 반영 figure", () => {
    expect(
      formatMmbakImportSummary(summary({ recurringUpsertedCount: 2, recurringArchivedCount: 1 })),
    ).toBe("백업 12건 확인, 3건 추가, 8건 갱신, 0건 실패, 고정비 3건 반영");
  });

  it("surfaces unsupported recurring rules instead of dropping them silently", () => {
    expect(formatMmbakImportSummary(summary({ recurringSkippedCount: 3 }))).toBe(
      "백업 12건 확인, 3건 추가, 8건 갱신, 0건 실패, 고정비 3건 미지원(월 반복 지출만 가져옵니다)",
    );
    expect(
      formatMmbakImportSummary(summary({ recurringUpsertedCount: 1, recurringSkippedCount: 2 })),
    ).toBe(
      "백업 12건 확인, 3건 추가, 8건 갱신, 0건 실패, 고정비 1건 반영, 고정비 2건 미지원(월 반복 지출만 가져옵니다)",
    );
  });

  it("omits both recurring clauses when the backup has no repeat rules", () => {
    expect(formatMmbakImportSummary(summary())).not.toContain("고정비");
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
