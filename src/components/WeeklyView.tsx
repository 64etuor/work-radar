import {
  CheckCircle2,
  GitPullRequest,
  Inbox,
  Repeat,
  Send,
  TrendingDown,
} from "lucide-react";

import type { DebtPoint } from "@/bindings";
import { localToday, useWeeklyReview } from "@/lib/query";

/** YYYY-MM-DD → M/D (짧은 라벨). */
function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * Weekly review — 지난 7일 회고(Phase 11c). 처리량 / PR 활동 / 루틴 이행률 / 부채 추세.
 * 전부 read 집계(기존 타임스탬프 + debt_snapshots). 외부 변경 없음.
 */
export function WeeklyView() {
  const review = useWeeklyReview(localToday());
  const data = review.data;

  return (
    <div className="wk">
      <header className="wk-head" data-tauri-drag-region>
        <span className="wk-title">Weekly Review</span>
        {data && (
          <span className="wk-range">
            {md(data.start)} – {md(data.end)}
          </span>
        )}
      </header>

      <div className="wk-scroll">
        {review.isError && (
          <div className="wk-hint">집계를 불러오지 못했습니다: {(review.error as Error).message}</div>
        )}
        {!data && !review.isError && <div className="wk-hint">집계 중…</div>}

        {data && (
          <>
            {/* 처리량 */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <Send className="size-4 text-wr-subtle" />
                <span className="wk-sec-name">처리량 (지난 7일)</span>
              </div>
              <div className="wk-stats">
                <StatTile icon={<Inbox className="size-4" />} label="캡처" value={data.throughput.captured} />
                <StatTile
                  icon={<CheckCircle2 className="size-4" />}
                  label="완료"
                  value={data.throughput.completed}
                />
                <StatTile
                  icon={<Send className="size-4" />}
                  label="승격"
                  value={data.throughput.promoted}
                />
              </div>
            </section>

            {/* PR 활동 */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <GitPullRequest className="size-4 text-wr-subtle" />
                <span className="wk-sec-name">PR 활동</span>
              </div>
              <div className="wk-stats">
                <StatTile
                  icon={<GitPullRequest className="size-4" />}
                  label="새 attention"
                  value={data.prActivity.attentionNew}
                />
                <StatTile
                  icon={<CheckCircle2 className="size-4" />}
                  label="정리됨 (≈머지/CI해소)"
                  value={data.prActivity.resolved}
                />
              </div>
            </section>

            {/* 루틴 이행률 */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <Repeat className="size-4 text-wr-subtle" />
                <span className="wk-sec-name">루틴 이행률</span>
                <span className="wk-sec-count">
                  {data.routineAdherence.done}/{data.routineAdherence.due}
                </span>
              </div>
              <div className="wk-bar">
                <div
                  className="wk-bar-fill"
                  style={{ width: `${data.routineAdherence.ratePct}%` }}
                />
                <span className="wk-bar-pct">{data.routineAdherence.ratePct}%</span>
              </div>
            </section>

            {/* 부채 추세 */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <TrendingDown className="size-4 text-wr-subtle" />
                <span className="wk-sec-name">부채 추세 (미분류 · Q1 overdue)</span>
              </div>
              {data.debtTrend.length === 0 ? (
                <div className="wk-hint">
                  추세 데이터가 쌓이는 중입니다 — Today 운영 뷰를 열 때마다 그날의 부채가 기록됩니다.
                </div>
              ) : (
                <DebtTrend points={data.debtTrend} />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
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

/** 일별 미분류·Q1 overdue 미니 막대(전진 누적, 7일 미만이면 있는 만큼). */
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
          <span className="wk-trend-date">{md(p.date)}</span>
        </div>
      ))}
    </div>
  );
}
