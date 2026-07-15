import "./WeeklyView.css";

import { Target, TrendingDown } from "lucide-react";
import { useEffect } from "react";

import type { DebtPoint } from "@/bindings";
import { ArchiveAccordion } from "@/components/weekly/ArchiveAccordion";
import { LifeOsAdvisorPanel } from "@/components/weekly/LifeOsAdvisorPanel";
import { LifeWheelRadar } from "@/components/weekly/LifeWheelRadar";
import { CompletedList, ReflectionRank } from "@/components/weekly/ReflectionSection";
import { SystemDiagnosis } from "@/components/weekly/SystemDiagnosis";
import { WeeklyBriefingHeader } from "@/components/weekly/WeeklyBriefingHeader";
import { WeeklyEvidence } from "@/components/weekly/WeeklyEvidence";
import { bucketRoutineDoneByOffset } from "@/lib/lifeWheelRadar";
import { uncheckedKrCount, weekStartMonday } from "@/lib/okr";
import {
  useCompleted,
  useLifeWheelTags,
  useObjectives,
  useOkrCheckIns,
  useRoutineTracking,
  useWeeklyReview,
} from "@/lib/query";
import { useScrollRestore } from "@/lib/useScrollRestore";
import { useWeekNav } from "@/lib/useWeekNav";
import { bucketByWeekOffset, monthDay, weekRangeForOffset, WEEKS_WINDOW } from "@/lib/weekRange";
import { useUIStore } from "@/store";

export function WeeklyView() {
  const nav = useWeekNav();
  const goTo = useUIStore((s) => s.goTo);
  const scrollRef = useScrollRestore("weekly");

  // 선택 주 KPI/PR/루틴/부채
  const review = useWeeklyReview(nav.range.end);
  const data = review.data;

  // 12주 완료 신호 1회 — 스크러바·레이더·회고 공용
  const windowStart = weekRangeForOffset(nav.today, -(WEEKS_WINDOW - 1)).start;
  const completed = useCompleted(windowStart, nav.today);
  const allItems = completed.data ?? [];

  const tagsQ = useLifeWheelTags();
  const tags = tagsQ.data ?? [];
  const okrQuarter = currentQuarterKey();
  const okrObjectives = useObjectives(okrQuarter);
  const okrCheckIns = useOkrCheckIns(okrQuarter);
  const pendingCheckIns = uncheckedKrCount(
    okrObjectives.data ?? [],
    okrCheckIns.data ?? [],
    weekStartMonday(),
  );

  // 주별 버킷: offset → 그 주에 완료된 신호[]
  const byOffset = bucketByWeekOffset(
    allItems.flatMap((s) => (s.todayDoneAt ? [{ date: s.todayDoneAt, value: s }] : [])),
    nav.today,
  );

  const countByOffset: Record<number, number> = {};
  byOffset.forEach((v, k) => (countByOffset[k] = v.length));

  const weekItems = byOffset.get(nav.offset) ?? [];

  // 루틴 완료 occurrence — 레이더는 카드 + 루틴을 함께 활동 분포로 집계
  const tracking = useRoutineTracking(nav.today, WEEKS_WINDOW * 7);
  const routineByOffset = bucketRoutineDoneByOffset(tracking.data ?? [], nav.today);
  const radarWeekItems = [...weekItems, ...(routineByOffset.get(nav.offset) ?? [])];
  const radarTrailingWeeks = [nav.offset - 1, nav.offset - 2, nav.offset - 3, nav.offset - 4].map(
    (o) => [...(byOffset.get(o) ?? []), ...(routineByOffset.get(o) ?? [])],
  );

  // 키보드 ←/→ (입력 포커스 시 무시)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          (el as HTMLElement).isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nav.prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nav.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  return (
    <div className="wk">
      <WeeklyBriefingHeader
        range={nav.range}
        isCurrent={nav.isCurrent}
        isOldest={nav.isOldest}
        today={nav.today}
        selectedOffset={nav.offset}
        countByOffset={countByOffset}
        onPrev={nav.prev}
        onNext={nav.next}
        onReset={nav.reset}
        onSelect={nav.goto}
      />

      <div className="wk-scroll" ref={scrollRef}>
        {pendingCheckIns > 0 && (
          <button type="button" className="wk-okr-prompt" onClick={() => goTo("mission")}>
            <span className="wk-okr-prompt-main typo-body-strong">
              <Target className="size-4" />
              <span>OKR 체크인 {pendingCheckIns}개 남음</span>
            </span>
            <span className="wk-okr-prompt-link typo-mono-label">Mission으로</span>
          </button>
        )}

        <section className="wk-direction" aria-labelledby="wk-direction-title">
          <div className="wk-section-title">
            <span className="wk-section-kicker">DIRECTION</span>
            <h2 id="wk-direction-title">이번 주 방향</h2>
            <p>주간 목표와 스프린트를 맞추고, 추천은 검토 후 직접 확정합니다.</p>
          </div>
          <div className="wk-direction-grid">
            <SystemDiagnosis weekStart={nav.range.start} isCurrent={nav.isCurrent} />
            <LifeOsAdvisorPanel
              weekStart={nav.range.start}
              rangeEnd={nav.range.end}
              quarter={okrQuarter}
            />
          </div>
        </section>

        {review.isError && (
          <div className="wk-hint">
            집계를 불러오지 못했습니다: {(review.error as Error).message}
          </div>
        )}

        <WeeklyEvidence review={data} />

        <div className="wk-review-grid">
          <section className="wk-review-section" aria-labelledby="wk-balance-title">
            <div className="wk-section-title">
              <span className="wk-section-kicker">BALANCE</span>
              <h2 id="wk-balance-title">균형과 부채</h2>
              <p>활동이 향한 곳과 밀린 일이 남긴 압력을 함께 봅니다.</p>
            </div>
            <div className="wk-review-stack">
              <section className="wk-review-panel" aria-labelledby="wk-life-wheel-title">
                <div className="wk-subsection-head">
                  <span>ACTIVITY DISTRIBUTION</span>
                  <h3 id="wk-life-wheel-title">Life Wheel</h3>
                </div>
                <LifeWheelRadar
                  weekSignals={radarWeekItems}
                  trailingWeeks={radarTrailingWeeks}
                  tags={tags}
                  onOpenSettings={() => goTo("settings")}
                />
              </section>

              <section className="wk-review-panel" aria-labelledby="wk-debt-title">
                <div className="wk-subsection-head wk-subsection-head-icon">
                  <TrendingDown className="size-4" />
                  <div>
                    <span>WORK DEBT</span>
                    <h3 id="wk-debt-title">부채 추세</h3>
                  </div>
                  <small>미분류 · Q1 overdue</small>
                </div>
                {!data || data.debtTrend.length === 0 ? (
                  <div className="wk-hint">추세 데이터가 쌓이는 중입니다.</div>
                ) : (
                  <DebtTrend points={data.debtTrend} />
                )}
              </section>
            </div>
          </section>

          <section className="wk-review-section" aria-labelledby="wk-reflection-title">
            <div className="wk-section-title">
              <span className="wk-section-kicker">REFLECTION</span>
              <h2 id="wk-reflection-title">완료와 회고</h2>
              <p>완료한 증거에서 임팩트와 아쉬움을 직접 표시합니다.</p>
            </div>
            <div className="wk-review-stack">
              <CompletedList items={weekItems} tags={tags} />

              <section className="wk-review-panel" aria-labelledby="wk-rank-title">
                <div className="wk-subsection-head">
                  <span>IMPACT / REGRET</span>
                  <h3 id="wk-rank-title">임팩트와 아쉬움</h3>
                </div>
                <ReflectionRank items={weekItems} />
              </section>

              <ArchiveAccordion tags={tags} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function currentQuarterKey(date = new Date()): string {
  return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}

function DebtTrend({ points }: { points: DebtPoint[] }) {
  const max = Math.max(1, ...points.map((p) => Math.max(p.unclassified, p.q1Overdue)));
  return (
    <div className="wk-trend">
      {points.map((p) => (
        <div key={p.date} className="wk-trend-col">
          <div className="wk-trend-bars">
            <div
              className="wk-trend-bar wk-trend-uncl"
              style={{ height: `${(p.unclassified / max) * 100}%` }}
              title={`미분류 ${p.unclassified}`}
            />
            <div
              className="wk-trend-bar wk-trend-q1"
              style={{ height: `${(p.q1Overdue / max) * 100}%` }}
              title={`Q1 overdue ${p.q1Overdue}`}
            />
          </div>
          <span className="wk-trend-date">{monthDay(p.date)}</span>
        </div>
      ))}
    </div>
  );
}
