import "./RoutineTrackingView.css";

import { Flame, Repeat } from "lucide-react";

import type { LifeWheelTagConfig, RoutineFreq, RoutineTrackingItem } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { localToday, useLifeWheelTags, useRoutineTracking } from "@/lib/query";
import { useScrollRestore } from "@/lib/useScrollRestore";
import { useViewSessionState } from "@/lib/useViewSessionState";
import { monthDay } from "@/lib/weekRange";

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

/**
 * 루틴 트래킹 뷰 (Phase 16 #12). 루틴별 이행률(%)·현재 streak·히스토리 히트맵.
 * 전부 로컬 routine_checks 집계 — 자동화/외부 변경 없음(INVARIANT #1/#7).
 */
export function RoutineTrackingView() {
  // 뷰 전환 생존(세션) — 기간 선택/스크롤이 매번 초기화되지 않게.
  const [period, setPeriod] = useViewSessionState<Period>("routinetrack.period", 30);
  const scrollRef = useScrollRestore("routinetrack");
  const tracking = useRoutineTracking(localToday(), period);
  const lifeWheelTags = useLifeWheelTags();
  const items = tracking.data ?? [];

  return (
    <div className="rt">
      <header className="rt-head" data-tauri-drag-region>
        <span className="typo-mono-heading">루틴 트래킹</span>
      </header>

      <div className="rt-scroll" ref={scrollRef}>
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

        {/* 로딩 / 에러 / 빈 상태는 서로 다른 뜻이다 — 첫 fetch 중에 "루틴 없음" CTA를 띄우지 않는다. */}
        {tracking.isLoading && <TrackingSkeleton />}
        {tracking.isError && (
          <div className="rt-hint">
            집계를 불러오지 못했습니다: {(tracking.error as Error).message}
          </div>
        )}
        {!tracking.isLoading && !tracking.isError && items.length === 0 && (
          <EmptyState className="rt-hint">
            활성 루틴이 없습니다. 보드에서 + 루틴으로 추가하세요.
          </EmptyState>
        )}

        <div className="trk-list">
          {items.map((it) => (
            <TrackCard key={it.id} item={it} lifeWheelTags={lifeWheelTags.data ?? []} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 첫 로드 스켈레톤 — trk-card 리듬을 그대로 흉내내 레이아웃 점프를 없앤다(shimmer는 reduced-motion 게이트). */
function TrackingSkeleton() {
  return (
    <div className="rt-skel" aria-label="루틴 트래킹 불러오는 중" aria-busy="true">
      <div className="wr-skeleton" />
      <div className="wr-skeleton" />
      <div className="wr-skeleton" />
    </div>
  );
}

/** 루틴 한 개의 트래킹 카드: 이행률 바 + streak + 히스토리 히트맵 + kind/area 칩(read-only). */
function TrackCard({
  item,
  lifeWheelTags,
}: {
  item: RoutineTrackingItem;
  lifeWheelTags: LifeWheelTagConfig[];
}) {
  return (
    <div className="trk-card">
      <div className="trk-head">
        <span className="trk-ttl">{item.title}</span>
        <span className="badge b-sched">{FREQ_LABEL[item.freq]}</span>
        <KindAreaChips target={item} tags={lifeWheelTags} />
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
              className={cn("trk-cell", h.done && "on")}
              title={`${monthDay(h.date)} ${h.done ? "완료" : "미완료"}`}
            />
          ))}
        </div>
      ) : (
        <div className="trk-empty">
          <Repeat className="size-3.5" />이 기간에 해당 occurrence 없음
        </div>
      )}
    </div>
  );
}
