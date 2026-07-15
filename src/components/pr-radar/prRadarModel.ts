import type { PrRadarItem, ReadinessBucket } from "@/bindings";

export type PrRadarBucketDescriptor = Readonly<{
  key: ReadinessBucket;
  label: string;
  hint: string;
}>;

export const PR_RADAR_BUCKETS: readonly PrRadarBucketDescriptor[] = [
  { key: "ci_blocked", label: "CI Blocked", hint: "CI 실패·충돌 — 머지 막힘" },
  { key: "needs_self_check", label: "Needs Review", hint: "코드 리뷰 필요 / draft" },
  { key: "ready", label: "Ready", hint: "머지 준비됨" },
  { key: "stale", label: "Stale", hint: "오래 멈춤" },
  { key: "merged_cleanup", label: "Merged Cleanup", hint: "머지됨 — 정리" },
];

export type GroupedPrRadarItems = Readonly<Record<ReadinessBucket, readonly PrRadarItem[]>>;

export type PrRadarSummary = Readonly<{
  total: number;
  attention: number;
  critical: number;
  suspicious: number;
  averageAgeDays: number;
  counts: Readonly<Record<ReadinessBucket, number>>;
}>;

export function groupPrRadarItems(items: readonly PrRadarItem[]): GroupedPrRadarItems {
  const grouped: Record<ReadinessBucket, PrRadarItem[]> = {
    ci_blocked: [],
    needs_self_check: [],
    ready: [],
    stale: [],
    merged_cleanup: [],
  };

  for (const item of items) grouped[item.bucket].push(item);

  return grouped;
}

export function summarizePrRadar(items: readonly PrRadarItem[]): PrRadarSummary {
  const grouped = groupPrRadarItems(items);
  const counts: Record<ReadinessBucket, number> = {
    ci_blocked: grouped.ci_blocked.length,
    needs_self_check: grouped.needs_self_check.length,
    ready: grouped.ready.length,
    stale: grouped.stale.length,
    merged_cleanup: grouped.merged_cleanup.length,
  };

  return {
    total: items.length,
    attention: counts.ci_blocked + counts.needs_self_check + counts.stale,
    critical: items.filter((item) => item.hasCriticalAlert).length,
    suspicious: items.filter((item) => item.isSuspicious || item.aiFlagged).length,
    averageAgeDays:
      items.length === 0
        ? 0
        : Math.round(items.reduce((sum, item) => sum + item.ageDays, 0) / items.length),
    counts,
  };
}
