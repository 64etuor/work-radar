import "./WorkoutView.css";

import { Dumbbell, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  localToday,
  useExerciseRecords,
  useStartWorkoutSession,
  useWorkoutSessions,
  useWorkoutVolume,
} from "@/lib/query";
import { useViewSessionState } from "@/lib/useViewSessionState";

import { BodySection } from "./BodySection";
import { ExerciseLibrary } from "./ExerciseLibrary";
import { SessionCard } from "./SessionCard";
import { addDays } from "./workoutDates";
import { fmtKcal, fmtTonnage, num } from "./workoutFormat";

/**
 * 운동 뷰 — **실적 기록 + 체성분**만 다룬다. "무엇을 언제 할 것인가"는 루틴/Today가 소유한다
 * (설계 정본 `docs/plans/2026-07-26-recipe-authoring-workout.md` §8 경계 결정).
 *
 * 에너지 수지는 read-only 파생 표시일 뿐 — 칼로리 목표를 자동으로 바꾸지 않는다.
 */
export function WorkoutView() {
  const today = localToday();
  const from = addDays(today, -27);

  const { data: sessions } = useWorkoutSessions(from, today);
  const { data: volume } = useWorkoutVolume(from, today);
  // PR은 별도 파생 커맨드 — 볼륨 요약과 수명이 다르다(전 기간 최고 기록).
  const { data: records } = useExerciseRecords(null);
  const start = useStartWorkoutSession();
  const [openSessionId, setOpenSessionId] = useViewSessionState<string | null>(
    "workout.session",
    null,
  );
  const [pendingTitle, setPendingTitle] = useState("");

  const todaySessions = (sessions ?? []).filter((s) => s.date === today);
  const past = (sessions ?? []).filter((s) => s.date !== today);

  const startToday = async () => {
    if (start.isPending) return;
    const session = await start.mutateAsync({
      date: today,
      startedAt: null,
      title: pendingTitle.trim() || null,
      note: null,
    });
    setPendingTitle("");
    setOpenSessionId(session.id);
  };

  const kpis = [
    { label: "4주 세션", value: volume?.sessionCount ?? 0 },
    { label: "총 세트", value: volume?.volume.setCount ?? 0 },
    { label: "총 톤수", value: fmtTonnage(volume?.volume.volumeKg) },
    { label: "소모", value: fmtKcal(volume?.energyKcal) },
  ];

  return (
    <div className="wo">
      <header className="wo-head">
        <div className="wo-head-copy">
          <span className="typo-mono-label">WORKOUT</span>
          <h1 className="typo-title-md">운동</h1>
          <p className="typo-body-md">
            한 날의 세션에 세트를 쌓고, 체성분 추이와 에너지 수지를 함께 봅니다. 계획은 루틴이
            담당합니다.
          </p>
        </div>
        <div className="wo-head-actions">
          <Button onClick={() => void startToday()} disabled={start.isPending}>
            <Plus size={15} aria-hidden />
            오늘 세션 시작
          </Button>
        </div>
      </header>

      <div className="wo-body">
        <section className="wo-kpis" aria-label="최근 4주 훈련량">
          {kpis.map((k) => (
            <div key={k.label} className="wo-kpi">
              <div className="wo-kpi-value typo-title-sm">{k.value}</div>
              <div className="wo-kpi-label typo-label-sm">{k.label}</div>
            </div>
          ))}
        </section>

        <BodySection today={today} />

        <section className="wo-section" aria-label="오늘">
          <h2 className="typo-label-lg wo-section-title">오늘</h2>
          {todaySessions.length === 0 ? (
            <EmptyState className="wo-empty" title="오늘 기록 없음">
              위 &ldquo;오늘 세션 시작&rdquo;으로 세션을 열고 세트를 쌓으세요.
            </EmptyState>
          ) : (
            todaySessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                expanded={openSessionId === session.id || todaySessions.length === 1}
                onToggle={() => setOpenSessionId(openSessionId === session.id ? null : session.id)}
              />
            ))
          )}
        </section>

        {volume != null && volume.byExercise.length > 0 && (
          <section className="wo-section" aria-label="종목별 훈련량">
            <h2 className="typo-label-lg wo-section-title">종목별 (4주)</h2>
            <ul className="wo-volume-list">
              {volume.byExercise.slice(0, 8).map((row) => (
                <li key={row.exerciseId} className="wo-volume-row">
                  <span className="typo-body-md">{row.exerciseName}</span>
                  <span className="typo-caption-sm">{row.setCount}세트</span>
                  <span className="typo-label-sm">{fmtTonnage(row.volumeKg)}</span>
                </li>
              ))}
            </ul>
            {records != null && records.length > 0 && (
              <ul className="wo-pr-list">
                {records.slice(0, 6).map((pr) => (
                  <li key={pr.exerciseId} className="wo-pr-row typo-caption-sm">
                    <Dumbbell size={13} aria-hidden />
                    {pr.exerciseName} 추정 1RM <strong>{Math.round(num(pr.best1rmKg))}kg</strong>
                    {pr.achievedOn != null && ` · ${pr.achievedOn}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <ExerciseLibrary />

        <section className="wo-section" aria-label="지난 기록">
          <h2 className="typo-label-lg wo-section-title">
            지난 기록 <span className="wo-count">{past.length}</span>
          </h2>
          {past.length === 0 ? (
            <EmptyState className="wo-empty">최근 4주 기록이 없습니다.</EmptyState>
          ) : (
            past.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                expanded={openSessionId === session.id}
                onToggle={() => setOpenSessionId(openSessionId === session.id ? null : session.id)}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
