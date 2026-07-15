import "./RoutineTrackingView.css";

import { CheckCircle2, Flame, Repeat, TrendingUp } from "lucide-react";

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
const PERIODS: readonly { readonly value: Period; readonly label: string }[] = [
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

type TrackingSummary = {
  readonly adherencePct: number;
  readonly done: number;
  readonly due: number;
  readonly activeStreaks: number;
  readonly longestStreak: number;
};

function summarizeTracking(items: readonly RoutineTrackingItem[]): TrackingSummary {
  const totals = items.reduce(
    (summary, item) => ({
      done: summary.done + item.done,
      due: summary.due + item.due,
      activeStreaks: summary.activeStreaks + (item.streak > 0 ? 1 : 0),
      longestStreak: Math.max(summary.longestStreak, item.streak),
    }),
    { done: 0, due: 0, activeStreaks: 0, longestStreak: 0 },
  );

  return {
    ...totals,
    adherencePct: totals.due === 0 ? 0 : Math.round((totals.done / totals.due) * 100),
  };
}

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
  const summary = summarizeTracking(items);

  return (
    <div className="rt">
      <header className="rt-head" data-tauri-drag-region>
        <div className="rt-head-copy">
          <span className="typo-mono-label">HABITS / CONSISTENCY</span>
          <h1 className="typo-title-md">루틴 트래킹</h1>
          <p className="typo-body-md">정한 루틴이 실제 반복으로 이어졌는지 기간별로 확인합니다.</p>
        </div>

        <div className="rt-periods" aria-label="집계 기간">
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
      </header>

      <div className="rt-scroll" ref={scrollRef}>
        <div className="rt-inner">
          {!tracking.isLoading && !tracking.isError && items.length > 0 && (
            <TrackingScorecard summary={summary} />
          )}

          {/* 로딩 / 에러 / 빈 상태는 서로 다른 뜻이다 — 첫 fetch 중에 "루틴 없음" CTA를 띄우지 않는다. */}
          {tracking.isLoading && <TrackingSkeleton />}
          {tracking.isError && (
            <section className="rt-error" role="alert">
              <strong className="typo-label-sm">루틴 집계를 불러오지 못했습니다.</strong>
              <p className="typo-caption-sm">
                {tracking.error instanceof Error
                  ? tracking.error.message
                  : String(tracking.error ?? "알 수 없는 오류")}
              </p>
            </section>
          )}
          {!tracking.isLoading && !tracking.isError && items.length === 0 && (
            <EmptyState className="rt-hint">
              활성 루틴이 없습니다. 보드에서 + 루틴으로 추가하세요.
            </EmptyState>
          )}

          {items.length > 0 && (
            <section className="trk-section" aria-labelledby="routine-performance-title">
              <div className="trk-section-head">
                <div>
                  <span className="typo-mono-label">ROUTINE PERFORMANCE</span>
                  <h2 id="routine-performance-title" className="typo-title-md">
                    루틴별 성과
                  </h2>
                </div>
                <span className="trk-section-count typo-mono-label">{items.length}개 활성</span>
              </div>
              <div className="trk-columns typo-mono-label" aria-hidden="true">
                <span>루틴</span>
                <span>이행률</span>
                <span>연속</span>
                <span>기록</span>
              </div>
              <div className="trk-list">
                {items.map((it) => (
                  <RoutineRow key={it.id} item={it} lifeWheelTags={lifeWheelTags.data ?? []} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function TrackingScorecard({ summary }: { summary: TrackingSummary }) {
  return (
    <section className="rt-summary" aria-label="루틴 성과 요약">
      <div className="rt-metric" aria-label={`전체 이행률 ${summary.adherencePct}%`}>
        <span className="rt-metric-label typo-mono-label">
          <TrendingUp className="size-3.5" /> 전체 이행률
        </span>
        <strong className="rt-metric-value typo-title-md">{summary.adherencePct}%</strong>
        <span className="rt-metric-detail typo-caption-sm">예정 기록 기준</span>
      </div>
      <div className="rt-metric" aria-label={`완료 기록 ${summary.done}/${summary.due}`}>
        <span className="rt-metric-label typo-mono-label">
          <CheckCircle2 className="size-3.5" /> 완료 기록
        </span>
        <strong className="rt-metric-value typo-title-md">
          {summary.done}
          <small> / {summary.due}</small>
        </strong>
        <span className="rt-metric-detail typo-caption-sm">완료 / 예정</span>
      </div>
      <div className="rt-metric" aria-label={`연속 달성 중인 루틴 ${summary.activeStreaks}개`}>
        <span className="rt-metric-label typo-mono-label">
          <Flame className="size-3.5" /> 연속 달성
        </span>
        <strong className="rt-metric-value typo-title-md">{summary.activeStreaks}개</strong>
        <span className="rt-metric-detail typo-caption-sm">
          최장 {summary.longestStreak}회 연속
        </span>
      </div>
    </section>
  );
}

/** 첫 로드 스켈레톤 — 최종 scorecard + row 지오메트리를 유지한다. */
function TrackingSkeleton() {
  return (
    <div className="rt-skel" aria-label="루틴 트래킹 불러오는 중" aria-busy="true">
      <div className="rt-skel-summary wr-skeleton" />
      <div className="rt-skel-row wr-skeleton" />
      <div className="rt-skel-row wr-skeleton" />
    </div>
  );
}

/** 루틴 한 개의 성과 행: 이행률 + streak + 히스토리 + kind/area 칩(read-only). */
function RoutineRow({
  item,
  lifeWheelTags,
}: {
  item: RoutineTrackingItem;
  lifeWheelTags: LifeWheelTagConfig[];
}) {
  return (
    <article className="trk-row" aria-label={`${item.title} 루틴 성과`}>
      <div className="trk-meta">
        <span className="trk-ttl typo-body-strong">{item.title}</span>
        <div className="trk-tags">
          <span className="badge b-sched">{FREQ_LABEL[item.freq]}</span>
          <KindAreaChips target={item} tags={lifeWheelTags} />
        </div>
      </div>

      <div className="trk-rate">
        <div className="trk-rate-copy">
          <span className="trk-rate-num">{item.ratePct}%</span>
          <span className="trk-rate-sub">
            {item.done}/{item.due}
          </span>
        </div>
        <div
          className="trk-bar"
          role="progressbar"
          aria-label={`${item.title} 이행률`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={item.ratePct}
        >
          <div className="trk-bar-fill" style={{ width: `${item.ratePct}%` }} />
        </div>
      </div>

      <div className="trk-streak" title="현재 연속">
        <span className="trk-streak-value">
          <Flame className="size-3.5" />
          {item.streak}
        </span>
        <span className="trk-streak-label typo-caption-sm">회 연속</span>
      </div>

      {item.history.length > 0 ? (
        <div className="trk-heat" aria-label="예정 날짜별 기록">
          {item.history.map((h) => (
            <span
              key={h.date}
              className={cn("trk-cell", h.done && "on")}
              title={`${monthDay(h.date)} ${h.done ? "완료" : "미완료"}`}
              aria-label={`${monthDay(h.date)} ${h.done ? "완료" : "미완료"}`}
              role="img"
            />
          ))}
        </div>
      ) : (
        <div className="trk-empty">
          <Repeat className="size-3.5" />이 기간에 예정된 기록 없음
        </div>
      )}
    </article>
  );
}
