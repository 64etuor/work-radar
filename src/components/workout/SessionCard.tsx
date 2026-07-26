import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { WorkoutSession } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useDeleteWorkoutSession, useRemoveWorkoutSet } from "@/lib/query";

import { SetComposer } from "./SetComposer";
import { shortDate } from "./workoutDates";
import { fmtDistance, fmtDuration, fmtKcal, fmtKg, fmtTonnage, num } from "./workoutFormat";

/** 한 세션 카드 — 접힘 상태는 요약만, 펼치면 세트 목록 + 빠른 입력. */
export function SessionCard({
  session,
  expanded,
  onToggle,
}: {
  session: WorkoutSession;
  expanded: boolean;
  onToggle: () => void;
}) {
  const removeSet = useRemoveWorkoutSet();
  const deleteSession = useDeleteWorkoutSession();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <article className={cn("wo-session", expanded && "is-open")}>
      <button type="button" className="wo-session-head" onClick={onToggle}>
        {expanded ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        <span className="typo-body-strong">{session.title ?? "운동"}</span>
        <span className="typo-caption-sm">{shortDate(session.date)}</span>
        <span className="typo-caption-sm">
          {session.volume.setCount}세트 · {fmtTonnage(session.volume.volumeKg)}
          {num(session.energyKcal) > 0 && ` · ${fmtKcal(session.energyKcal)}`}
        </span>
      </button>

      {expanded && (
        <div className="wo-session-body">
          {session.sets.length === 0 ? (
            <p className="typo-caption-sm wo-hint">아직 세트가 없습니다.</p>
          ) : (
            <ul className="wo-set-list">
              {session.sets.map((set) => (
                <li key={set.id} className="wo-set-row">
                  <span className="wo-set-no typo-label-sm">{set.setNo}</span>
                  <span className="typo-body-md">{set.exerciseName}</span>
                  <span className="typo-label-sm">
                    {set.reps != null
                      ? `${set.reps}회${set.weightKg != null ? ` × ${fmtKg(set.weightKg)}` : ""}`
                      : `${fmtDuration(set.durationSec)}${
                          set.distanceM != null ? ` · ${fmtDistance(set.distanceM)}` : ""
                        }`}
                  </span>
                  <span className="typo-caption-sm wo-set-meta">
                    {set.estimated1rmKg != null && `1RM ~${Math.round(set.estimated1rmKg)}kg`}
                    {set.rpe != null && ` · RPE ${set.rpe}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="세트 삭제"
                    disabled={removeSet.isPending}
                    onClick={() => void removeSet.mutateAsync(set.id)}
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <SetComposer sessionId={session.id} />

          <div className="wo-session-foot">
            <span className="typo-caption-sm wo-hint">
              총 {session.volume.totalReps}회
              {num(session.volume.durationSec) > 0 &&
                ` · ${fmtDuration(session.volume.durationSec)}`}
              {num(session.volume.distanceM) > 0 && ` · ${fmtDistance(session.volume.distanceM)}`}
            </span>
            {confirmingDelete ? (
              <div className="wo-confirm">
                <span className="typo-caption-sm">세션과 모든 세트를 지웁니다.</span>
                <Button
                  variant="destructiveOutline"
                  size="sm"
                  disabled={deleteSession.isPending}
                  onClick={() => void deleteSession.mutateAsync(session.id)}
                >
                  삭제
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  취소
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="size-4" /> 세션 삭제
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
