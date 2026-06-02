import type { InboxItem } from "@/bindings";
import type { View } from "@/store";

/**
 * Inbox 트레이 그룹/라우팅 순수 헬퍼. 표시 전용(INVARIANT #1) — 어떤 결정도 주입하지 않는다.
 * 소스 목록은 하드코딩하지 않는다: 데이터에 등장한 source로 섹션을 동적 구성한다(점진 추가).
 */

/** 심각도 정렬 랭크(작을수록 위). migration 0024 CHECK: info/success/warning/critical. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  success: 3,
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 99;
}

/** source 키 → 표시 라벨. 미지정 소스는 키 그대로(점진 추가시 자동 노출). */
export function labelSource(source: string): string {
  if (source === "pr_radar") return "PR Radar";
  if (source === "notification") return "Mac 알림";
  if (source === "agent") return "Agent";
  return source;
}

/** 행 클릭 시 이동할 뷰(없으면 null). 표시 전용 네비게이션. */
export function inferTargetView(item: InboxItem): View | null {
  if (item.relatedEntityType === "pr" || item.source === "pr_radar") return "radar";
  if (item.relatedEntityType === "agent" || item.source === "agent") return "jobs";
  if (item.relatedEntityType === "worktree") return "worktree";
  if (item.source === "notification") return null;
  return "today";
}

export type InboxSourceGroup = {
  source: string;
  label: string;
  items: InboxItem[];
  /** 그룹 내 미읽음 개수(섹션 헤더 배지). */
  unread: number;
  /** 그룹 내 최고 심각도 랭크(섹션 정렬 기준). */
  topSeverityRank: number;
};

/**
 * source별 섹션으로 그룹핑. 입력 순서를 각 그룹 내에서 보존(이미 서버가 unread/severity/updated 정렬).
 * 섹션 정렬: 최고 심각도 → 미읽음 많은 순 → source 키(안정). 빈 입력 → 빈 배열.
 */
export function groupInboxBySource(items: InboxItem[]): InboxSourceGroup[] {
  const bySource = new Map<string, InboxItem[]>();
  for (const item of items) {
    const arr = bySource.get(item.source);
    if (arr) arr.push(item);
    else bySource.set(item.source, [item]);
  }

  const groups: InboxSourceGroup[] = [];
  for (const [source, groupItems] of bySource) {
    const topSeverityRank = groupItems.reduce(
      (min, i) => Math.min(min, severityRank(i.severity)),
      99,
    );
    const unread = groupItems.filter((i) => i.unread).length;
    groups.push({ source, label: labelSource(source), items: groupItems, unread, topSeverityRank });
  }

  groups.sort(
    (a, b) =>
      a.topSeverityRank - b.topSeverityRank ||
      b.unread - a.unread ||
      a.source.localeCompare(b.source),
  );
  return groups;
}
