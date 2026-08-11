import { type FormEvent, useState } from "react";

import type { Exercise, WorkoutSet } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePatchWorkoutSet } from "@/lib/query";

import { buildWorkoutSetPatch, workoutSetDraft } from "./workoutEditDrafts";

type NumericSetField = "reps" | "weightKg" | "durationSec" | "distanceM" | "restSec" | "rpe";

const NUMERIC_SET_FIELDS: {
  key: NumericSetField;
  label: string;
  step: string;
}[] = [
  { key: "reps", label: "횟수", step: "1" },
  { key: "weightKg", label: "중량 kg", step: "0.01" },
  { key: "durationSec", label: "시간 초", step: "1" },
  { key: "distanceM", label: "거리 m", step: "0.01" },
  { key: "restSec", label: "휴식 초", step: "1" },
  { key: "rpe", label: "RPE", step: "1" },
];

export function WorkoutSetEditor({
  set,
  exercises,
  onClose,
}: {
  set: WorkoutSet;
  exercises: Exercise[];
  onClose: () => void;
}) {
  const patchSet = usePatchWorkoutSet();
  const [draft, setDraft] = useState(() => workoutSetDraft(set));
  const hasAxis =
    draft.reps.trim().length > 0 ||
    draft.durationSec.trim().length > 0 ||
    draft.distanceM.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasAxis) return;
    patchSet.mutate(buildWorkoutSetPatch(set.id, draft), {
      onSuccess: onClose,
    });
  };

  return (
    <form className="wo-edit-form wo-set-edit" onSubmit={submit}>
      <label className="wo-edit-wide">
        <span className="typo-label-sm">종목</span>
        <select
          className="wo-select typo-caption-sm"
          value={draft.exerciseId}
          onChange={(event) =>
            setDraft((current) => ({ ...current, exerciseId: event.target.value }))
          }
        >
          {exercises.map((exercise) => (
            <option key={exercise.id} value={exercise.id}>
              {exercise.name}
            </option>
          ))}
        </select>
      </label>
      {NUMERIC_SET_FIELDS.map(({ key, label, step }) => (
        <label key={key}>
          <span className="typo-label-sm">{label}</span>
          <Input
            type="number"
            min={0}
            max={key === "rpe" ? 10 : undefined}
            step={step}
            value={draft[key]}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
          />
        </label>
      ))}
      <label className="wo-edit-wide">
        <span className="typo-label-sm">메모</span>
        <Input
          value={draft.note}
          onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
        />
      </label>
      {!hasAxis && (
        <span className="typo-caption-sm wo-hint">횟수·시간·거리 중 하나는 필요합니다.</span>
      )}
      <div className="wo-edit-actions">
        <Button type="submit" size="sm" disabled={patchSet.isPending || !hasAxis}>
          저장
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          취소
        </Button>
      </div>
    </form>
  );
}
