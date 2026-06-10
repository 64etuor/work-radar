// src/components/weekly/LifeWheelRadar.tsx
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { computeRadarAxes, radarRenderMode } from "@/lib/lifeWheelRadar";

const SERIES_CURRENT = "var(--color-wr-green, #3f7d5e)";
const SERIES_AVG = "var(--color-wr-subtle, #c9c9c4)";

interface Props {
  weekSignals: WorkSignal[]; // 선택 주 완료 신호
  trailingWeeks: WorkSignal[][]; // 직전 4주(각 주 신호 배열)
  tags: LifeWheelTagConfig[];
  onOpenSettings: () => void; // N=0 딥링크
}

export function LifeWheelRadar({ weekSignals, trailingWeeks, tags, onOpenSettings }: Props) {
  const mode = radarRenderMode(tags);

  if (mode === "empty") {
    return (
      <div className="wk-radar-empty">
        Life Wheel 태그가 없습니다.{" "}
        <button type="button" className="wk-link" onClick={onOpenSettings}>
          설정에서 추가
        </button>
      </div>
    );
  }

  const cur = computeRadarAxes(weekSignals, tags);
  const avgRaw = trailingWeeks.map((wk) => computeRadarAxes(wk, tags));
  // 축 key 정렬은 computeRadarAxes가 동일 → index 정렬 일치
  const data = cur.map((axis, i) => {
    const avg =
      avgRaw.length === 0
        ? 0
        : avgRaw.reduce((sum, wk) => sum + (wk[i]?.count ?? 0), 0) / avgRaw.length;
    return { axis: axis.label, current: axis.count, average: Number(avg.toFixed(2)) };
  });
  const max = Math.max(1, ...data.map((d) => Math.max(d.current, d.average)));

  if (mode === "bars") {
    // N=1~2: 레이더 폴리곤 불가 → 수평 바
    return (
      <div className="wk-radar-bars">
        {data.map((d) => (
          <div key={d.axis} className="wk-bar-row">
            <span className="wk-bar-axis">{d.axis}</span>
            <div className="wk-bar-track">
              <i className="wk-bar-cur" style={{ width: `${(d.current / max) * 100}%` }} />
            </div>
            <span className="wk-bar-num">{d.current}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="wk-radar">
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="var(--color-wr-border-light, #ececea)" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{ fill: "var(--color-wr-subtle, #6b6b6b)", fontSize: 11 }}
          />
          <PolarRadiusAxis domain={[0, max]} tick={false} axisLine={false} />
          <Radar
            name="4주 평균"
            dataKey="average"
            stroke={SERIES_AVG}
            fill={SERIES_AVG}
            fillOpacity={0.12}
          />
          <Radar
            name="이번 주"
            dataKey="current"
            stroke={SERIES_CURRENT}
            fill={SERIES_CURRENT}
            fillOpacity={0.18}
          />
        </RadarChart>
      </ResponsiveContainer>
      <div className="wk-radar-legend">
        <span>
          <i className="wk-dot" style={{ background: SERIES_CURRENT }} />
          이번 주
        </span>
        <span>
          <i className="wk-dot" style={{ background: SERIES_AVG }} />
          4주 평균
        </span>
      </div>
    </div>
  );
}
