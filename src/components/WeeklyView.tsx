import "./WeeklyView.css";

import {
  CheckCircle2,
  GitPullRequest,
  Inbox,
  Radar as RadarIcon,
  Repeat,
  Send,
  TrendingDown,
} from "lucide-react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

import type { DebtPoint, WeeklyReview } from "@/bindings";
import { localToday, useWeeklyReview } from "@/lib/query";
import {
  computeWeeklyLifeWheel,
  deriveLifeWheelInsights,
  type LifeWheelConfidence,
} from "@/lib/weeklyLifeWheel";

/** YYYY-MM-DD → M/D (짧은 라벨). 렌더 직전 날짜 포맷 헬퍼(export=테스트 대상). */
// eslint-disable-next-line react-refresh/only-export-components -- 순수 포맷 헬퍼를 테스트에 노출(HMR 무관).
export function md(date: string): string {
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
          <div className="wk-hint">
            집계를 불러오지 못했습니다: {(review.error as Error).message}
          </div>
        )}
        {!data && !review.isError && <div className="wk-hint">집계 중…</div>}

        {data && (
          <>
            {/* 라이프 휠 (주간 작업 차원 레이더) — hero */}
            <LifeWheelHero review={data} />

            {/* 처리량 */}
            <section className="wk-sec">
              <div className="wk-sec-head">
                <Send className="text-wr-subtle size-4" />
                <span className="wk-sec-name">처리량 (지난 7일)</span>
              </div>
              <div className="wk-stats">
                <StatTile
                  icon={<Inbox className="size-4" />}
                  label="캡처"
                  value={data.throughput.captured}
                />
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
                <GitPullRequest className="text-wr-subtle size-4" />
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
                <Repeat className="text-wr-subtle size-4" />
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
                <TrendingDown className="text-wr-subtle size-4" />
                <span className="wk-sec-name">부채 추세 (미분류 · Q1 overdue)</span>
              </div>
              {data.debtTrend.length === 0 ? (
                <div className="wk-hint">
                  추세 데이터가 쌓이는 중입니다. Today 운영 뷰를 열 때마다 그날의 부채가 기록됩니다.
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

/** confidence → 짧은 한글 라벨(배지용). measured는 배지 미표시이므로 호출부에서 거른다. */
const CONFIDENCE_LABEL: Record<LifeWheelConfidence, string> = {
  measured: "측정됨",
  sparse: "표본 빈약",
  empty: "데이터 없음",
};

/** sparse/empty일 때만 작은 배지를 단다(measured는 군더더기 없이 둠). */
function ConfidenceBadge({ confidence }: { confidence: LifeWheelConfidence }) {
  if (confidence === "measured") return null;
  return <span className={`wk-conf wk-conf-${confidence}`}>{CONFIDENCE_LABEL[confidence]}</span>;
}

/**
 * 주간 작업 라이프 휠 hero — 기존 recharts(RadarChart)로 7축 레이더 + 전체 점수/신뢰도 +
 * 인사이트 카드(강점/취약/부채 움직임/루틴). 모든 수치는 `computeWeeklyLifeWheel` 순수 파생.
 * 0/희소 데이터는 helper의 empty/sparse 상태로 표현 — 오해 부르는 100은 만들지 않는다.
 */
export function LifeWheelHero({ review }: { review: WeeklyReview }) {
  const wheel = computeWeeklyLifeWheel(review);
  const insights = deriveLifeWheelInsights(wheel);

  // 레이더 데이터: empty 축은 score=null로 두어 그 꼭짓점을 비운다(0으로 채우지 않음).
  const radarData = wheel.axes.map((a) => ({
    axis: a.label,
    score: a.score,
  }));

  return (
    <section className="wk-sec wk-hero">
      <div className="wk-sec-head">
        <RadarIcon className="text-wr-subtle size-4" />
        <span className="wk-sec-name">라이프 휠 (주간 작업)</span>
        <span className="wk-sec-count">
          {wheel.measuredCount}/{wheel.axes.length}축
        </span>
      </div>

      {wheel.measuredCount === 0 ? (
        <div className="wk-hint">
          이번 주는 아직 집계할 활동이 없습니다. 캡처·완료·루틴 체크가 쌓이면 레이더가 채워집니다.
        </div>
      ) : (
        <div className="wk-hero-grid">
          <div className="wk-radar">
            <ResponsiveContainer width="100%" height={240}>
              <RadarChart data={radarData} margin={{ top: 14, right: 22, bottom: 14, left: 22 }}>
                <PolarGrid stroke="var(--color-wr-border-light)" />
                <PolarAngleAxis
                  dataKey="axis"
                  tick={{ fill: "var(--color-wr-subtle)", fontSize: 10 }}
                />
                <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} tickCount={5} />
                <Radar
                  dataKey="score"
                  stroke="var(--color-wr-accent)"
                  fill="var(--color-wr-accent)"
                  fillOpacity={0.16}
                  isAnimationActive={false}
                  connectNulls={false}
                  dot={{ r: 2, fill: "var(--color-wr-accent)", strokeWidth: 0 }}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          <div className="wk-hero-side">
            <div className="wk-score">
              <span className="wk-score-num">{wheel.overall ?? "—"}</span>
              <span className="wk-score-unit">/100</span>
              <span className="wk-score-cap">전체 주간 점수</span>
              {wheel.measuredCount < wheel.axes.length && (
                <span className="wk-conf wk-conf-sparse">부분 집계</span>
              )}
            </div>

            <div className="wk-insights">
              {insights.best && (
                <InsightCard
                  eyebrow="강점 축"
                  value={insights.best.label}
                  sub={`${insights.best.score}점`}
                  confidence={insights.best.confidence}
                />
              )}
              {/* measured 축이 2개 이상일 때만 취약 축을 별도로 보여준다(best와 중복 방지). */}
              {insights.weakest && wheel.measuredCount >= 2 && (
                <InsightCard
                  eyebrow="취약 축"
                  value={insights.weakest.label}
                  sub={`${insights.weakest.score}점`}
                  confidence={insights.weakest.confidence}
                />
              )}
              {insights.momentum && (
                <InsightCard
                  eyebrow="부채 움직임"
                  value={insights.momentum.score === null ? "—" : insights.momentum.detail}
                  sub={insights.momentum.score === null ? insights.momentum.detail : "정리 모멘텀"}
                  confidence={insights.momentum.confidence}
                />
              )}
              {insights.routine && (
                <InsightCard
                  eyebrow="루틴 이행"
                  value={insights.routine.score === null ? "—" : `${insights.routine.score}%`}
                  sub={insights.routine.detail}
                  confidence={insights.routine.confidence}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** 인사이트 카드 한 장. confidence가 sparse/empty면 배지로 신뢰도를 명시한다. */
function InsightCard({
  eyebrow,
  value,
  sub,
  confidence,
}: {
  eyebrow: string;
  value: string;
  sub: string;
  confidence: LifeWheelConfidence;
}) {
  return (
    <div className="wk-insight">
      <span className="wk-insight-eyebrow">
        {eyebrow}
        <ConfidenceBadge confidence={confidence} />
      </span>
      <span className="wk-insight-val">{value}</span>
      <span className="wk-insight-sub">{sub}</span>
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
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
