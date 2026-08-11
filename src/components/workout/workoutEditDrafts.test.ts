import { describe, expect, it } from "vitest";

import type { Exercise, WorkoutSession, WorkoutSet } from "@/bindings";

import {
  buildExerciseUpdate,
  buildWorkoutSessionPatch,
  buildWorkoutSetPatch,
  exerciseDraft,
  workoutSessionDraft,
  workoutSetDraft,
} from "./workoutEditDrafts";

const exercise: Exercise = {
  id: "exercise-1",
  name: "백스쿼트",
  modality: "strength",
  primaryMuscle: "대퇴사두",
  equipment: "바벨",
  met: 5,
  source: "manual",
  sourceRef: null,
  archived: false,
  aliases: ["스쿼트"],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const set: WorkoutSet = {
  id: "set-1",
  sessionId: "session-1",
  exerciseId: "exercise-1",
  exerciseName: "백스쿼트",
  modality: "strength",
  setNo: 1,
  sortRank: 0,
  reps: 5,
  weightKg: 80,
  durationSec: null,
  distanceM: null,
  restSec: 120,
  rpe: 8,
  note: "워밍업",
  estimated1rmKg: 93,
};

const session: WorkoutSession = {
  id: "session-1",
  date: "2026-07-01",
  startedAt: "09:00",
  endedAt: "10:00",
  title: "하체",
  perceivedExertion: 8,
  note: "좋았음",
  sets: [set],
  volume: { setCount: 1, totalReps: 5, volumeKg: 400, durationSec: 0, distanceM: 0 },
  energyKcal: 100,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

describe("workout edit drafts", () => {
  it("exercise edit exposes every mutable library field", () => {
    expect(exerciseDraft(exercise)).toEqual({
      name: "백스쿼트",
      modality: "strength",
      primaryMuscle: "대퇴사두",
      equipment: "바벨",
      met: "5",
    });
    expect(buildExerciseUpdate(exercise, exerciseDraft(exercise))).toMatchObject({
      id: "exercise-1",
      name: "백스쿼트",
      modality: "strength",
      primaryMuscle: "대퇴사두",
      equipment: "바벨",
      met: 5,
    });
  });

  it("session edit emits clear fields for optional values erased by the user", () => {
    const draft = workoutSessionDraft(session);
    expect(buildWorkoutSessionPatch(session.id, { ...draft, note: "", endedAt: "" })).toEqual({
      id: "session-1",
      date: "2026-07-01",
      title: "하체",
      startedAt: "09:00",
      endedAt: null,
      perceivedExertion: 8,
      note: null,
      clear: ["ended_at", "note"],
    });
  });

  it("set edit keeps the set id and clears axes erased by the user", () => {
    const draft = workoutSetDraft(set);
    expect(buildWorkoutSetPatch(set.id, { ...draft, reps: "", weightKg: "", note: "" })).toEqual({
      id: "set-1",
      exerciseId: "exercise-1",
      reps: null,
      weightKg: null,
      durationSec: null,
      distanceM: null,
      restSec: 120,
      rpe: 8,
      note: null,
      clear: ["reps", "weight_kg", "duration_sec", "distance_m", "note"],
    });
  });
});
