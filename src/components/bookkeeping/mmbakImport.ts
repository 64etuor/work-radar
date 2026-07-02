import type { BookkeepingSyncJob, ImportBookkeepingMmbakSummary } from "@/bindings";

/**
 * MoneyManager 백업이 쌓이는 Google Drive 동기화 폴더 힌트(미설정 empty state용).
 * 예: `~/Library/CloudStorage/GoogleDrive-<계정>/내 드라이브/MoneyManager`
 */
export const MMBAK_WATCH_DIR_HINT =
  "머니매니저 백업(.mmbak)이 저장되는 폴더 경로를 입력하세요 — 예: Google Drive 동기화 폴더의 '내 드라이브/MoneyManager'";

/** 감시 폴더 입력 정규화: 공백뿐이면 null(미설정), 아니면 트림된 경로. */
export function normalizeWatchDir(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" ? null : trimmed;
}

/** 최신 백업 임포트 결과 토스트 문구. */
export function formatMmbakImportSummary(summary: ImportBookkeepingMmbakSummary): string {
  const base = `백업 ${summary.scannedCount}건 확인, ${summary.importedCount}건 추가, ${summary.duplicateCount}건 갱신, ${summary.failedCount}건 실패`;
  return summary.backfilledCategoryCount > 0
    ? `${base}, ${summary.backfilledCategoryCount}건 분류 보완`
    : base;
}

/** moneymanager 소스의 가장 최근 sync job (updatedAt 내림차순, 방어적 정렬). */
export function latestMoneyManagerJob(jobs: BookkeepingSyncJob[]): BookkeepingSyncJob | null {
  const mine = jobs.filter((job) => job.source === "moneymanager");
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

/** 최근 가져오기 한 줄 힌트(성공/실패 + 추가 건수 + 시각). */
export function formatMmbakJobHint(job: BookkeepingSyncJob): string {
  const status = job.status === "succeeded" ? "성공" : "실패";
  return `최근 가져오기 ${status} · ${job.importedCount}건 추가 (${job.updatedAt})`;
}
