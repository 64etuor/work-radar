import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Exercise, ExerciseModality } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAddExerciseAlias, useRemoveExerciseAlias, useUpsertExercise } from "@/lib/query";

import { buildExerciseUpdate, exerciseDraft } from "./workoutEditDrafts";
import { MODALITY_LABEL } from "./workoutFormat";

const MODALITIES: ExerciseModality[] = ["strength", "cardio", "mobility", "sport"];

function isModality(value: string): value is ExerciseModality {
  return MODALITIES.some((modality) => modality === value);
}

export function ExerciseEditor({ exercise, onClose }: { exercise: Exercise; onClose: () => void }) {
  const upsert = useUpsertExercise();
  const addAlias = useAddExerciseAlias();
  const removeAlias = useRemoveExerciseAlias();
  const [draft, setDraft] = useState(() => exerciseDraft(exercise));
  const [alias, setAlias] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.name.trim().length === 0) return;
    upsert.mutate(buildExerciseUpdate(exercise, draft), { onSuccess: onClose });
  };
  const submitAlias = async () => {
    const trimmed = alias.trim();
    if (trimmed.length === 0) return;
    await addAlias.mutateAsync({ exerciseId: exercise.id, alias: trimmed });
    setAlias("");
  };

  return (
    <form className="wo-edit-form wo-exercise-edit" onSubmit={submit}>
      <label>
        <span className="typo-label-sm">이름</span>
        <Input
          required
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </label>
      <label>
        <span className="typo-label-sm">분류</span>
        <select
          className="wo-select typo-caption-sm"
          value={draft.modality}
          onChange={(event) => {
            const value = event.target.value;
            if (isModality(value)) {
              setDraft((current) => ({ ...current, modality: value }));
            }
          }}
        >
          {MODALITIES.map((modality) => (
            <option key={modality} value={modality}>
              {MODALITY_LABEL[modality]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="typo-label-sm">주요 근육</span>
        <Input
          value={draft.primaryMuscle}
          onChange={(event) =>
            setDraft((current) => ({ ...current, primaryMuscle: event.target.value }))
          }
        />
      </label>
      <label>
        <span className="typo-label-sm">장비</span>
        <Input
          value={draft.equipment}
          onChange={(event) =>
            setDraft((current) => ({ ...current, equipment: event.target.value }))
          }
        />
      </label>
      <label>
        <span className="typo-label-sm">MET</span>
        <Input
          type="number"
          min={0}
          step="0.1"
          value={draft.met}
          onChange={(event) => setDraft((current) => ({ ...current, met: event.target.value }))}
        />
      </label>
      <div className="wo-alias-editor wo-edit-wide">
        <span className="typo-label-sm">별칭</span>
        <div className="wo-alias-list">
          {exercise.aliases.map((currentAlias) => (
            <span key={currentAlias} className="wo-alias-chip typo-caption-sm">
              {currentAlias}
              <button
                type="button"
                aria-label={`${currentAlias} 별칭 삭제`}
                disabled={removeAlias.isPending}
                onClick={() => removeAlias.mutate({ exerciseId: exercise.id, alias: currentAlias })}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
        <div className="wo-alias-add">
          <Input
            value={alias}
            placeholder="새 별칭"
            onChange={(event) => setAlias(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={addAlias.isPending || alias.trim().length === 0}
            onClick={() => void submitAlias()}
          >
            <Plus className="size-4" /> 추가
          </Button>
        </div>
      </div>
      <div className="wo-edit-actions">
        <Button
          type="submit"
          size="sm"
          disabled={upsert.isPending || draft.name.trim().length === 0}
        >
          저장
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          취소
        </Button>
      </div>
    </form>
  );
}
