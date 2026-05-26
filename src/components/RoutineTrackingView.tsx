import { useState } from "react";
import { Flame, Repeat } from "lucide-react";

import type { RoutineFreq, RoutineTrackingItem } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { localToday, useRoutineTracking } from "@/lib/query";

type Period = 7 | 30 | 90;
const PERIODS: { value: Period; label: string }[] = [
  { value: 7, label: "지난 7일" },
  { value: 30, label: "지난 30일" },
  { value: 90, label: "지난 90일" },
];

const FREQ_LABEL: Record<RoutineFreq, string> = {
  daily: "매일",
  weekly: "매주",
  biweekly: "격주",
  monthly: "매월",
};

/** YYYY-MM-DD → M/D. */
function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 루틴 트래킹 뷰 (Phase 16 #12). 루틴별 이행률(%)·현재 streak·히스토리 히트맵.
 * 전부 로컬 routine_checks 집계 — 자동화/외부 변경 없음(INVARIANT #1/#7).
 */
export function RoutineTrackingView() {
  const [period, setPeriod] = useState<Period>(30);
  const tracking = useRoutineTracking(localToday(), period);
  const items = tracking.data ?? [];

  return (
    <div className="rt">
      <header className="rt-head" data-tauri-drag-region>
        <span className="rt-title">루틴 트래킹</span>
        <div className="rt-tabs" />
      </header>

      <div className="rt-scroll">
        <div className="rt-periods">
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              variant="outline"
              size="sm"
              aria-pressed={period === p.value}
              className={cn(
                "rounded-full",
                period === p.value &&
                  "border-wr-accent bg-wr-accent-soft text-wr-accent hover:bg-wr-accent-soft",
              )}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {tracking.isError && (
          <div className="rt-hint">집계를 불러오지 못했습니다: {(tracking.error as Error).message}</div>
        )}
        {!tracking.isError && items.length === 0 && (
          <div className="rt-hint">활성 루틴이 없습니다 — 보드에서 + 루틴으로 추가하세요.</div>
        )}

        <div className="trk-list">
          {items.map((it) => (
            <TrackCard key={it.id} item={it} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 루틴 한 개의 트래킹 카드: 이행률 바 + streak + 히스토리 히트맵. */
function TrackCard({ item }: { item: RoutineTrackingItem }) {
  return (
    <div className="trk-card">
      <div className="trk-head">
        <span className="trk-ttl">{item.title}</span>
        <span className="badge b-sched">{FREQ_LABEL[item.freq]}</span>
        <span className="trk-spacer" />
        <span className="trk-streak" title="현재 연속">
          <Flame className="size-3.5" />
          {item.streak}
        </span>
      </div>

      <div className="trk-rate">
        <div className="trk-bar">
          <div className="trk-bar-fill" style={{ width: `${item.ratePct}%` }} />
        </div>
        <span className="trk-rate-num">{item.ratePct}%</span>
        <span className="trk-rate-sub">
          {item.done}/{item.due}
        </span>
      </div>

      {item.history.length > 0 ? (
        <div className="trk-heat" title="due 날별 체크 여부 (오래된 → 최신)">
          {item.history.map((h) => (
            <span
              key={h.date}
              className={`trk-cell${h.done ? " on" : ""}`}
              title={`${md(h.date)} ${h.done ? "완료" : "미완료"}`}
            />
          ))}
        </div>
      ) : (
        <div className="trk-empty">
          <Repeat className="size-3.5" />
          이 기간에 해당 occurrence 없음
        </div>
      )}
    </div>
  );
}
