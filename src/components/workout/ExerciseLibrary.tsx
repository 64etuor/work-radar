import { Archive, Pencil, Plus } from "lucide-react";
import { useState } from "react";

import type { ExerciseModality } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useExercises, useSetExerciseArchived, useUpsertExercise } from "@/lib/query";

import { ExerciseEditor } from "./ExerciseEditor";
import { MODALITY_LABEL, parseOptionalNumber, trimNum } from "./workoutFormat";

const MODALITIES: ExerciseModality[] = ["strength", "cardio", "mobility", "sport"];

/**
 * 종목 라이브러리 — 세트 입력이 참조하는 이름·MET의 원본.
 *
 * MET을 비워두면 소모 kcal은 **0으로 표시**된다(추정하지 않는다). 그게 싫으면 값을 채우는 게
 * 정답이고, 그럴듯한 기본값을 몰래 넣는 건 답이 아니다.
 */
export function ExerciseLibrary() {
  const [query, setQuery] = useState("");
  const { data: exercises } = useExercises(query, false);
  const upsert = useUpsertExercise();

  const [name, setName] = useState("");
  const [modality, setModality] = useState<ExerciseModality>("strength");
  const [met, setMet] = useState("");
  const [primaryMuscle, setPrimaryMuscle] = useState("");
  const [equipment, setEquipment] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const add = async () => {
    if (upsert.isPending || name.trim().length === 0) return;
    await upsert.mutateAsync({
      id: null,
      name: name.trim(),
      modality,
      primaryMuscle: primaryMuscle.trim() || null,
      equipment: equipment.trim() || null,
      met: parseOptionalNumber(met),
      source: null,
      sourceRef: null,
    });
    setName("");
    setMet("");
    setPrimaryMuscle("");
    setEquipment("");
  };

  return (
    <section className="wo-section" aria-label="종목 라이브러리">
      <div className="wo-section-head">
        <h2 className="typo-label-lg wo-section-title">종목</h2>
        <Input
          className="wo-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름/별칭 검색"
        />
        <Input
          value={primaryMuscle}
          onChange={(e) => setPrimaryMuscle(e.target.value)}
          placeholder="주요 근육"
          aria-label="주요 근육"
        />
        <Input
          value={equipment}
          onChange={(e) => setEquipment(e.target.value)}
          placeholder="장비"
          aria-label="장비"
        />
      </div>

      <div className="wo-inline-form">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="새 종목 이름"
          aria-label="종목 이름"
        />
        <select
          className="wo-select typo-caption-sm"
          value={modality}
          aria-label="분류"
          onChange={(e) => setModality(e.target.value as ExerciseModality)}
        >
          {MODALITIES.map((m) => (
            <option key={m} value={m}>
              {MODALITY_LABEL[m]}
            </option>
          ))}
        </select>
        <Input
          inputMode="decimal"
          className="wo-composer-num"
          value={met}
          onChange={(e) => setMet(e.target.value)}
          placeholder="MET"
          aria-label="MET 계수"
        />
        <Button variant="outline" size="sm" disabled={upsert.isPending} onClick={() => void add()}>
          <Plus className="size-4" /> 추가
        </Button>
      </div>

      {(exercises ?? []).length > 0 && (
        <ul className="wo-exercise-list">
          {(exercises ?? []).map((exercise) => (
            <li key={exercise.id}>
              <div className="wo-exercise-row">
                <span className="typo-body-md">{exercise.name}</span>
                <Badge variant="outline">{MODALITY_LABEL[exercise.modality]}</Badge>
                <span className="typo-caption-sm">
                  {[
                    exercise.primaryMuscle,
                    exercise.equipment,
                    exercise.met != null ? `MET ${trimNum(exercise.met)}` : "MET 미설정 → 소모 0",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="wo-exercise-aliases typo-caption-sm">
                  {exercise.aliases.join(", ")}
                </span>
                <div className="wo-row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="종목 수정"
                    onClick={() =>
                      setEditingId((current) => (current === exercise.id ? null : exercise.id))
                    }
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <ArchiveButton id={exercise.id} />
                </div>
              </div>
              {editingId === exercise.id && (
                <ExerciseEditor exercise={exercise} onClose={() => setEditingId(null)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ArchiveButton({ id }: { id: string }) {
  const setArchived = useSetExerciseArchived();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="종목 보관"
      disabled={setArchived.isPending}
      onClick={() => void setArchived.mutateAsync({ id, archived: true })}
    >
      <Archive className="size-4" />
    </Button>
  );
}
