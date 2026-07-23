import { Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { ReadingStats } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import { useSetReadingGoal } from "@/lib/query";

import { monthShortLabel, paceInfo } from "./readingFormat";

const RING_SIZE = 132;
const RING_STROKE = 11;

/** 연간 목표 카드 — 프로그레스 링 + 페이스(앞섬/뒤짐) + 월별 완독 차트(옵시디언 이식). */
export function ReadingGoalCard({
  stats,
  year,
  today,
}: {
  stats: ReadingStats | null;
  year: number;
  today: string;
}) {
  const setGoal = useSetReadingGoal();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const goal = stats?.goal ?? null;
  const finished = stats?.finishedInYear ?? 0;
  const monthly = stats?.monthlyFinished ?? Array.from({ length: 12 }, () => 0);
  const curMonth = Number(today.slice(5, 7)) - 1;

  const submitGoal = (e: FormEvent) => {
    e.preventDefault();
    const target = Number(draft);
    if (!Number.isInteger(target) || target < 1 || target > 1000) return;
    setGoal.mutate({ year, targetBooks: target }, { onSuccess: () => setEditing(false) });
  };

  if (goal == null && !editing) {
    return (
      <section className="rd-goal rd-goal-unset" aria-label="연간 목표">
        <div className="typo-body-md rd-card-dim">
          {year}년 독서 목표가 아직 없습니다 — 목표를 정하면 페이스를 추적해 드립니다.
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setDraft("52");
            setEditing(true);
          }}
        >
          목표 설정
        </Button>
      </section>
    );
  }

  if (editing) {
    return (
      <section className="rd-goal rd-goal-unset" aria-label="연간 목표 설정">
        <form className="rd-goal-form" onSubmit={submitGoal}>
          <label className="typo-label-md" htmlFor="rd-goal-input">
            {year}년 목표 권수
          </label>
          <Input
            id="rd-goal-input"
            className="rd-goal-input"
            type="number"
            min={1}
            max={1000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <Button type="submit" disabled={setGoal.isPending}>
            저장
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            취소
          </Button>
        </form>
      </section>
    );
  }

  // goal != null 확정 경로.
  const target = goal?.targetBooks ?? 1;
  const pace = paceInfo(finished, target, today);
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pace.pct / 100) * circumference;
  const maxCount = Math.max(...monthly, pace.monthlyGoal, 1);
  const thisMonthDone = monthly[curMonth] ?? 0;

  return (
    <section className="rd-goal" aria-label="연간 목표">
      <div className="rd-goal-left">
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          role="img"
          aria-label={`올해 완독 ${finished} / 목표 ${target}권`}
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={radius}
            fill="none"
            className="rd-ring-bg"
            strokeWidth={RING_STROKE}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={radius}
            fill="none"
            className="rd-ring-fill"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
          <text x={RING_SIZE / 2} y={RING_SIZE / 2 - 4} textAnchor="middle" className="rd-ring-num">
            {finished}
          </text>
          <text
            x={RING_SIZE / 2}
            y={RING_SIZE / 2 + 18}
            textAnchor="middle"
            className="rd-ring-sub"
          >
            / {target}권
          </text>
        </svg>
        <div className="rd-goal-pace">
          <div className="typo-title-sm">{pace.pct}% 달성</div>
          <div
            className={cn(
              "typo-label-md",
              pace.diff > 0 && "rd-pace-ahead",
              pace.diff < 0 && "rd-pace-behind",
            )}
          >
            {pace.diff > 0
              ? `${pace.diff}권 앞서가는 중`
              : pace.diff < 0
                ? `${Math.abs(pace.diff)}권 뒤처지는 중`
                : "페이스 동일"}
          </div>
          <div className="typo-label-sm rd-card-dim">남은 {pace.remaining}권</div>
          <button
            type="button"
            className="rd-goal-edit typo-label-sm"
            onClick={() => {
              setDraft(String(target));
              setEditing(true);
            }}
          >
            <Pencil size={11} aria-hidden /> 목표 수정
          </button>
        </div>
      </div>

      <div className="rd-goal-right">
        <div className="rd-goal-month">
          <span className="typo-label-md">{monthShortLabel(curMonth + 1)} 독서</span>
          <span className="typo-body-strong">
            {thisMonthDone} <span className="rd-card-dim">/ {pace.monthlyGoal}권</span>
          </span>
          <span className="rd-progress-bar rd-goal-month-bar">
            <span
              className={cn(
                "rd-progress-fill",
                thisMonthDone >= pace.monthlyGoal && "rd-progress-achieved",
              )}
              style={{
                width: `${Math.min((thisMonthDone / pace.monthlyGoal) * 100, 100)}%`,
              }}
            />
          </span>
        </div>
        <div className="rd-goal-chart" role="img" aria-label="월별 완독 수">
          {monthly.map((count, i) => (
            <div key={i} className="rd-chart-col">
              <div className="rd-chart-bar-wrap">
                <div
                  className="rd-chart-goal-line"
                  style={{ bottom: `${(pace.monthlyGoal / maxCount) * 100}%` }}
                />
                <div
                  className={cn(
                    "rd-chart-bar",
                    i === curMonth && "is-current",
                    i > curMonth && "is-future",
                    count >= pace.monthlyGoal && count > 0 && "is-achieved",
                  )}
                  style={{ height: `${maxCount > 0 ? (count / maxCount) * 100 : 0}%` }}
                >
                  {count > 0 && <span className="rd-chart-count typo-label-sm">{count}</span>}
                </div>
              </div>
              <div className="rd-chart-label typo-label-sm">{i + 1}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
