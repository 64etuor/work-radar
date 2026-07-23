import { type CSSProperties, useMemo } from "react";

import type { ReadingHeatmapDay } from "@/bindings";
import { cn } from "@/components/ui/cn";
import { WEEKDAY_SHORT_SUN_FIRST } from "@/lib/localeFormat";

import { monthShortLabel } from "./readingFormat";

/** 연도를 전부 덮는 주 칼럼 수 — 1/1이 토요일인 윤년은 54가 필요하다(53 고정 시 12/31 셀 누락). */
function weekColumns(year: number, jan1Dow: number): number {
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  return Math.ceil((jan1Dow + days) / 7);
}

/** 각 월이 시작하는 주 칼럼(헤더 라벨 위치) — 옵시디언 로직 이식. 12회 순회라 memo 불요. */
function monthStartWeeks(year: number, jan1Dow: number): Map<number, number> {
  const map = new Map<number, number>();
  const jan1 = new Date(year, 0, 1, 12).getTime();
  for (let mi = 0; mi < 12; mi++) {
    const first = new Date(year, mi, 1, 12).getTime();
    const dayOfYear = Math.round((first - jan1) / 86400000);
    map.set(Math.floor((dayOfYear + jan1Dow) / 7), mi);
  }
  return map;
}

function ymd(year: number, monthIdx: number, day: number): string {
  const m = String(monthIdx + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/**
 * GitHub 스타일 연간 히트맵 — 옵시디언 대시보드의 start~finish 보간 대신
 * `reading_sessions` 실측(그날 실제로 읽었는가)으로 채운다. 완독일은 최상위 레벨.
 */
export function ReadingHeatmap({
  days,
  year,
  today,
}: {
  days: ReadingHeatmapDay[];
  year: number;
  today: string;
}) {
  const byDate = useMemo(() => {
    const map = new Map<string, ReadingHeatmapDay>();
    for (const d of days) map.set(d.date, d);
    return map;
  }, [days]);

  const jan1Dow = new Date(year, 0, 1, 12).getDay();
  const weeks = weekColumns(year, jan1Dow);
  const monthStartWeek = monthStartWeeks(year, jan1Dow);

  return (
    <div
      className="rd-heatmap"
      role="img"
      aria-label={`${year}년 독서 히트맵`}
      style={{ "--rd-heatmap-weeks": weeks } as CSSProperties}
    >
      <div className="rd-heatmap-grid">
        <div className="rd-heatmap-header">
          <div className="rd-heatmap-day-label" />
          {Array.from({ length: weeks }, (_, week) => {
            const mi = monthStartWeek.get(week);
            return (
              <div key={week} className="rd-heatmap-month-label typo-label-sm">
                {mi != null ? monthShortLabel(mi + 1) : ""}
              </div>
            );
          })}
        </div>
        {Array.from({ length: 7 }, (_, dow) => (
          <div key={dow} className="rd-heatmap-row">
            <div className="rd-heatmap-day-label typo-label-sm">
              {dow === 1 || dow === 3 || dow === 5 ? WEEKDAY_SHORT_SUN_FIRST[dow] : ""}
            </div>
            {Array.from({ length: weeks }, (_, week) => {
              const dayOffset = week * 7 + dow - jan1Dow;
              const date = new Date(year, 0, 1 + dayOffset, 12);
              if (date.getFullYear() !== year || dayOffset < 0) {
                return <div key={week} className="rd-heatmap-cell is-empty" />;
              }
              const key = ymd(year, date.getMonth(), date.getDate());
              const cell = byDate.get(key);
              const finished = cell?.finished ?? 0;
              const sessions = cell?.sessions ?? 0;
              const title =
                finished > 0
                  ? `${key}: 완독 ${finished}권${sessions > 0 ? ` · 세션 ${sessions}` : ""}`
                  : sessions > 0
                    ? `${key}: 독서 세션 ${sessions}`
                    : key;
              return (
                <div
                  key={week}
                  title={title}
                  className={cn(
                    "rd-heatmap-cell",
                    finished > 0 ? "level-finish" : sessions > 0 ? "level-reading" : "level-0",
                    key > today && "is-future",
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="rd-heatmap-legend typo-label-sm">
        <span>없음</span>
        <div className="rd-heatmap-cell level-0" />
        <div className="rd-heatmap-cell level-reading" />
        <div className="rd-heatmap-cell level-finish" />
        <span>완독</span>
      </div>
    </div>
  );
}
