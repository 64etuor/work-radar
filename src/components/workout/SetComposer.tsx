import { Plus } from "lucide-react";
import { useState } from "react";

import type { Exercise } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAddWorkoutSet, useExercises } from "@/lib/query";

import {
  isStrength,
  kmToMeters,
  minutesToSeconds,
  MODALITY_LABEL,
  parseOptionalInt,
  parseOptionalNumber,
} from "./workoutFormat";

/**
 * 빠른 세트 입력 — 같은 종목으로 세트를 연달아 쌓는 게 기본 동작이므로 저장 후 종목과 값을
 * **유지**한다(매번 다시 고르게 하면 근력 5세트 입력이 고문이 된다).
 *
 * 근력 종목은 회수×무게, 그 외는 분/거리 축을 보여준다 — 종목의 modality가 어느 축을 쓸지 정한다.
 */
export function SetComposer({ sessionId }: { sessionId: string }) {
  const { data: exercises } = useExercises("", false);
  const addSet = useAddWorkoutSet();

  const [exerciseId, setExerciseId] = useState<string | null>(null);
  const [reps, setReps] = useState("");
  const [weight, setWeight] = useState("");
  const [minutes, setMinutes] = useState("");
  const [km, setKm] = useState("");
  const [rpe, setRpe] = useState("");

  const selected: Exercise | null = exercises?.find((e) => e.id === exerciseId) ?? null;
  const strength = selected == null || isStrength(selected.modality);

  const submit = async () => {
    if (addSet.isPending || exerciseId == null) return;
    const payload = strength
      ? {
          reps: parseOptionalInt(reps),
          weightKg: parseOptionalNumber(weight),
          durationSec: null,
          distanceM: null,
        }
      : {
          reps: null,
          weightKg: null,
          durationSec: minutesToSeconds(minutes),
          distanceM: kmToMeters(km),
        };
    // 백엔드가 "축이 전부 빈 세트"를 거부하므로 여기서도 먼저 막아 왕복을 아낀다.
    if (payload.reps == null && payload.durationSec == null && payload.distanceM == null) return;

    await addSet.mutateAsync({
      sessionId,
      exerciseId,
      ...payload,
      restSec: null,
      rpe: parseOptionalInt(rpe),
      note: null,
    });
    // 종목·무게·RPE는 남긴다 — 다음 세트가 대개 같은 종목의 같은 무게다.
  };

  return (
    <div className="wo-composer">
      <select
        className="wo-select typo-caption-sm"
        value={exerciseId ?? ""}
        aria-label="종목"
        onChange={(e) => setExerciseId(e.target.value || null)}
      >
        <option value="">종목 선택…</option>
        {(exercises ?? []).map((exercise) => (
          <option key={exercise.id} value={exercise.id}>
            {exercise.name} ({MODALITY_LABEL[exercise.modality]})
          </option>
        ))}
      </select>

      {strength ? (
        <>
          <Input
            inputMode="numeric"
            className="wo-composer-num"
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            placeholder="회"
            aria-label="반복 횟수"
          />
          <Input
            inputMode="decimal"
            className="wo-composer-num"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="kg"
            aria-label="무게"
          />
        </>
      ) : (
        <>
          <Input
            inputMode="decimal"
            className="wo-composer-num"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="분"
            aria-label="시간(분)"
          />
          <Input
            inputMode="decimal"
            className="wo-composer-num"
            value={km}
            onChange={(e) => setKm(e.target.value)}
            placeholder="km"
            aria-label="거리(km)"
          />
        </>
      )}

      <Input
        inputMode="numeric"
        className="wo-composer-num"
        value={rpe}
        onChange={(e) => setRpe(e.target.value)}
        placeholder="RPE"
        aria-label="RPE 1-10"
      />

      <Button
        size="sm"
        disabled={addSet.isPending || exerciseId == null}
        onClick={() => void submit()}
      >
        <Plus className="size-4" /> 세트
      </Button>

      {(exercises ?? []).length === 0 && (
        <span className="typo-caption-sm wo-hint">
          종목이 없습니다 — 에이전트(MCP)로 등록하거나 아래 라이브러리에서 추가하세요.
        </span>
      )}
    </div>
  );
}
