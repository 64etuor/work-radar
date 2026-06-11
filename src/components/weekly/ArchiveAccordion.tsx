// src/components/weekly/ArchiveAccordion.tsx
import { Archive, RotateCcw } from "lucide-react";

import type { LifeWheelTagConfig } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { Button } from "@/components/ui/button";
import { useArchivedSnoozed, useRestoreSignal } from "@/lib/query";
import { monthDay } from "@/lib/weekRange";

export function ArchiveAccordion({ tags }: { tags: LifeWheelTagConfig[] }) {
  const list = useArchivedSnoozed();
  const restore = useRestoreSignal();
  const items = list.data ?? [];

  return (
    <details className="wk-accordion">
      <summary className="wk-accordion-head">
        <span className="wk-accordion-title">
          <Archive className="size-4" /> 보관함
          <span className="wk-sec-count">{items.length}</span>
        </span>
        <span className="wk-accordion-hint">펼치기</span>
      </summary>
      <div className="wk-accordion-body">
        {list.isError && (
          <div className="wk-hint">목록을 불러오지 못했습니다: {(list.error as Error).message}</div>
        )}
        {items.length === 0 && !list.isError && (
          <div className="wk-hint">보관(archived)·미루기(snoozed)된 항목이 없습니다.</div>
        )}
        {items.map((s) => (
          <div key={s.id} className="wk-arc-item">
            <div className="wk-arc-body">
              <div className="wk-item-ttl">{s.title}</div>
              <div className="wk-arc-meta">
                <span className={`wk-arc-badge ${s.status}`}>
                  {s.status === "archived" ? "보관됨" : "미룸"}
                </span>
                {s.status === "snoozed" && s.snoozeUntil && (
                  <span className="wk-arc-sub">복귀 {monthDay(s.snoozeUntil)}</span>
                )}
                <KindAreaChips target={s} tags={tags} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 rounded-full"
              title="복원"
              disabled={restore.isPending}
              onClick={() => restore.mutate(s.id)}
            >
              <RotateCcw className="size-3.5" />
              복원
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}
