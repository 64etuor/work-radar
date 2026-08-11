import type {
  Exercise,
  ExerciseModality,
  PatchWorkoutSessionInput,
  PatchWorkoutSetInput,
  UpsertExerciseInput,
  WorkoutSession,
  WorkoutSessionField,
  WorkoutSet,
  WorkoutSetField,
} from "@/bindings";

export interface ExerciseDraft {
  name: string;
  modality: ExerciseModality;
  primaryMuscle: string;
  equipment: string;
  met: string;
}

export interface WorkoutSessionDraft {
  date: string;
  title: string;
  startedAt: string;
  endedAt: string;
  perceivedExertion: string;
  note: string;
}

export interface WorkoutSetDraft {
  exerciseId: string;
  reps: string;
  weightKg: string;
  durationSec: string;
  distanceM: string;
  restSec: string;
  rpe: string;
  note: string;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Number(trimmed) : null;
}

export function exerciseDraft(exercise: Exercise): ExerciseDraft {
  return {
    name: exercise.name,
    modality: exercise.modality,
    primaryMuscle: exercise.primaryMuscle ?? "",
    equipment: exercise.equipment ?? "",
    met: exercise.met?.toString() ?? "",
  };
}

export function buildExerciseUpdate(exercise: Exercise, draft: ExerciseDraft): UpsertExerciseInput {
  return {
    id: exercise.id,
    name: draft.name.trim(),
    modality: draft.modality,
    primaryMuscle: optionalText(draft.primaryMuscle),
    equipment: optionalText(draft.equipment),
    met: optionalNumber(draft.met),
    source: null,
    sourceRef: exercise.sourceRef,
  };
}

export function workoutSessionDraft(session: WorkoutSession): WorkoutSessionDraft {
  return {
    date: session.date,
    title: session.title ?? "",
    startedAt: session.startedAt ?? "",
    endedAt: session.endedAt ?? "",
    perceivedExertion: session.perceivedExertion?.toString() ?? "",
    note: session.note ?? "",
  };
}

export function buildWorkoutSessionPatch(
  id: string,
  draft: WorkoutSessionDraft,
): PatchWorkoutSessionInput {
  const clear: WorkoutSessionField[] = [];
  if (draft.title.trim().length === 0) clear.push("title");
  if (draft.startedAt.trim().length === 0) clear.push("started_at");
  if (draft.endedAt.trim().length === 0) clear.push("ended_at");
  if (draft.perceivedExertion.trim().length === 0) clear.push("perceived_exertion");
  if (draft.note.trim().length === 0) clear.push("note");

  return {
    id,
    date: draft.date,
    title: optionalText(draft.title),
    startedAt: optionalText(draft.startedAt),
    endedAt: optionalText(draft.endedAt),
    perceivedExertion: optionalNumber(draft.perceivedExertion),
    note: optionalText(draft.note),
    clear,
  };
}

export function workoutSetDraft(set: WorkoutSet): WorkoutSetDraft {
  return {
    exerciseId: set.exerciseId,
    reps: set.reps?.toString() ?? "",
    weightKg: set.weightKg?.toString() ?? "",
    durationSec: set.durationSec?.toString() ?? "",
    distanceM: set.distanceM?.toString() ?? "",
    restSec: set.restSec?.toString() ?? "",
    rpe: set.rpe?.toString() ?? "",
    note: set.note ?? "",
  };
}

export function buildWorkoutSetPatch(id: string, draft: WorkoutSetDraft): PatchWorkoutSetInput {
  const clear: WorkoutSetField[] = [];
  if (draft.reps.trim().length === 0) clear.push("reps");
  if (draft.weightKg.trim().length === 0) clear.push("weight_kg");
  if (draft.durationSec.trim().length === 0) clear.push("duration_sec");
  if (draft.distanceM.trim().length === 0) clear.push("distance_m");
  if (draft.restSec.trim().length === 0) clear.push("rest_sec");
  if (draft.rpe.trim().length === 0) clear.push("rpe");
  if (draft.note.trim().length === 0) clear.push("note");

  return {
    id,
    exerciseId: draft.exerciseId,
    reps: optionalNumber(draft.reps),
    weightKg: optionalNumber(draft.weightKg),
    durationSec: optionalNumber(draft.durationSec),
    distanceM: optionalNumber(draft.distanceM),
    restSec: optionalNumber(draft.restSec),
    rpe: optionalNumber(draft.rpe),
    note: optionalText(draft.note),
    clear,
  };
}
