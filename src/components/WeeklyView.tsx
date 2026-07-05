import "./WeeklyView.css";

import {
  CheckCircle2,
  Clock,
  GitPullRequest,
  Inbox,
  NotebookPen,
  Repeat,
  Send,
  Target,
  TrendingDown,
} from "lucide-react";
import { useEffect } from "react";

import type { DebtPoint } from "@/bindings";
import { areaLabel } from "@/components/board/boardUtils";
import { ArchiveAccordion } from "@/components/weekly/ArchiveAccordion";
import { LifeOsAdvisorPanel } from "@/components/weekly/LifeOsAdvisorPanel";
import { LifeWheelRadar } from "@/components/weekly/LifeWheelRadar";
import { CompletedList, ReflectionRank } from "@/components/weekly/ReflectionSection";
import { SystemDiagnosis } from "@/components/weekly/SystemDiagnosis";
import { WeekNavigator } from "@/components/weekly/WeekNavigator";
import { WeekScrubber } from "@/components/weekly/WeekScrubber";
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
import { fmtMinutes } from "@/lib/timeTotals";
import { useWeekNav } from "@/lib/useWeekNav";
import { bucketByWeekOffset, monthDay, weekRangeForOffset, WEEKS_WINDOW } from "@/lib/weekRange";
import { useUIStore } from "@/store";

export function WeeklyView() {
  const nav = useWeekNav();
  const goTo = useUIStore((s) => s.goTo);

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
      <header className="wk-head" data-tauri-drag-region>
        <span className="wk-title">Weekly Review</span>
      </header>

      <WeekNavigator
        range={nav.range}
        isCurrent={nav.isCurrent}
        isOldest={nav.isOldest}
        onPrev={nav.prev}
        onNext={nav.next}
        onReset={nav.reset}
      />
      <WeekScrubber
        today={nav.today}
        selectedOffset={nav.offset}
        countByOffset={countByOffset}
        onSelect={nav.goto}
      />

      <div className="wk-scroll">
        {pendingCheckIns > 0 && (
          <button type="button" className="wk-okr-prompt" onClick={() => goTo("mission")}>
            <span className="wk-okr-prompt-main typo-body-strong">
              <Target className="size-4" />
              <span>OKR 체크인 {pendingCheckIns}개 남음</span>
            </span>
            <span className="wk-okr-prompt-link typo-mono-label">Mission으로</span>
          </button>
        )}

        <SystemDiagnosis weekStart={nav.range.start} isCurrent={nav.isCurrent} />
        <LifeOsAdvisorPanel
          weekStart={nav.range.start}
          rangeEnd={nav.range.end}
          quarter={okrQuarter}
        />

        {review.isError && (
          <div className="wk-hint">
            집계를 불러오지 못했습니다: {(review.error as Error).message}
          </div>
        )}

        {/* KPI 스트립: 처리량 + PR 활동 — 전폭 한 줄, 동일 타일 */}
        <div className="wk-kpis">
          <section className="wk-sec">
            <div className="wk-sec-head">
              <Send className="text-wr-subtle size-4" />
              <span className="wk-sec-name">처리량</span>
            </div>
            <div className="wk-stats">
              <StatTile
                icon={<Inbox className="size-4" />}
                label="캡처"
                value={data?.throughput.captured ?? 0}
              />
              <StatTile
                icon={<CheckCircle2 className="size-4" />}
                label="완료"
                value={data?.throughput.completed ?? 0}
              />
              <StatTile
                icon={<Send className="size-4" />}
                label="승격"
                value={data?.throughput.promoted ?? 0}
              />
            </div>
          </section>

          <section className="wk-sec">
            <div className="wk-sec-head">
              <GitPullRequest className="text-wr-subtle size-4" />
              <span className="wk-sec-name">PR 활동</span>
            </div>
            <div className="wk-stats wk-stats-2">
              <StatTile
                icon={<GitPullRequest className="size-4" />}
                label="새 attention"
                value={data?.prActivity.attentionNew ?? 0}
              />
              <StatTile
                icon={<CheckCircle2 className="size-4" />}
                label="정리됨"
                value={data?.prActivity.resolved ?? 0}
              />
            </div>
          </section>

          <section className="wk-sec">
            <div className="wk-sec-head">
              <Clock className="text-wr-subtle size-4" />
              <span className="wk-sec-name">배치 시간</span>
            </div>
            <div className="wk-stats wk-stats-2">
              <StatTile
                icon={<Clock className="size-4" />}
                label="총 배치"
                value={fmtMinutes(data?.timeSpent?.totalMin ?? 0)}
              />
            </div>
            {(data?.timeSpent?.byArea ?? []).length > 0 && (
              <ul className="wk-time-areas">
                {(data?.timeSpent?.byArea ?? []).map((row) => (
                  <li key={row.area ?? "untagged"} className="wk-time-area">
                    <span>{row.area ? areaLabel(row.area) : "미태깅"}</span>
                    <span>{fmtMinutes(row.totalMin)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 2칼럼: 대시보드(좌) · 완료한 일/보관함(우) — 좁은 화면에선 세로 스택 */}
        <div className="wk-cols">
          <div className="wk-col">
            <div className="wk-card">
              <div className="wk-sec-head">
                <span className="wk-sec-name">Life Wheel · 이번 주 활동 분포</span>
              </div>
              <LifeWheelRadar
                weekSignals={radarWeekItems}
                trailingWeeks={radarTrailingWeeks}
                tags={tags}
                onOpenSettings={() => goTo("settings")}
              />
            </div>

            <div className="wk-momentum">
              <div className="wk-sec-head">
                <Repeat className="text-wr-subtle size-4" />
                <span className="wk-sec-name">루틴 이행률</span>
                {data && (
                  <span className="wk-sec-count">
                    {data.routineAdherence.done}/{data.routineAdherence.due}
                  </span>
                )}
              </div>
              <div className="wk-bar">
                <div
                  className="wk-bar-fill"
                  style={{ width: `${data?.routineAdherence.ratePct ?? 0}%` }}
                />
                <span className="wk-bar-pct">{data?.routineAdherence.ratePct ?? 0}%</span>
              </div>
            </div>

            {/* 부채 추세 */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <TrendingDown className="text-wr-subtle size-4" />
                <span className="wk-sec-name">부채 추세 (미분류 · Q1 overdue)</span>
              </div>
              {!data || data.debtTrend.length === 0 ? (
                <div className="wk-hint">추세 데이터가 쌓이는 중입니다.</div>
              ) : (
                <DebtTrend points={data.debtTrend} />
              )}
            </section>

            {/* 회고 랭크(좋아요/싫어요) */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <NotebookPen className="text-wr-subtle size-4" />
                <span className="wk-sec-name">회고</span>
              </div>
              <ReflectionRank items={weekItems} />
            </section>
          </div>

          <div className="wk-col">
            {/* 이 주 완료한 일 */}
            <CompletedList items={weekItems} tags={tags} />

            {/* 보관함(병합·접이식) */}
            <ArchiveAccordion tags={tags} />
          </div>
        </div>
      </div>
    </div>
  );
}

function currentQuarterKey(date = new Date()): string {
  return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="wk-tile">
      <span className="wk-tile-top">
        {icon}
        <span className="wk-tile-label">{label}</span>
      </span>
      <span className="wk-tile-val">{value}</span>
    </div>
  );
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
