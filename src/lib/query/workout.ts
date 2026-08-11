import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type AddWorkoutSetInput,
  commands,
  type PatchWorkoutSessionInput,
  type PatchWorkoutSetInput,
  type RecordBodyMetricInput,
  type SetBodyProfileInput,
  type StartWorkoutSessionInput,
  type UpsertExerciseInput,
} from "@/bindings";

import { pushMutationError, unwrap } from "./client";

export const workoutKeys = {
  all: ["workout"] as const,
  sessions: (from: string, to: string) => ["workout", "sessions", from, to] as const,
  session: (id: string) => ["workout", "session", id] as const,
  exercises: (query: string, includeArchived: boolean) =>
    ["workout", "exercises", query, includeArchived] as const,
  volume: (from: string, to: string) => ["workout", "volume", from, to] as const,
  records: (exerciseId: string) => ["workout", "records", exerciseId] as const,
  bodyTrend: (limit: number) => ["workout", "body-trend", limit] as const,
  bodyProfile: ["workout", "body-profile"] as const,
  energy: (date: string) => ["workout", "energy", date] as const,
};

function invalidateWorkout(qc: QueryClient) {
  // 도메인 전체 무효화 — 전부 로컬 SQLite라 재조회가 싸고, 세션↔볼륨↔PR↔에너지처럼 파생이
  // 얽힌 표면에서 부분 무효화가 놓치는 조합이 더 비싸다(diet 헬퍼와 동일 판단).
  return qc.invalidateQueries({ queryKey: workoutKeys.all });
}

function useInvalidateWorkout() {
  const qc = useQueryClient();
  return () => invalidateWorkout(qc);
}

// ── read ──────────────────────────────────────────────────────────────

export function useWorkoutSessions(from: string, to: string) {
  return useQuery({
    queryKey: workoutKeys.sessions(from, to),
    queryFn: () => unwrap(commands.listWorkoutSessions(from, to)),
    enabled: from.length > 0 && to.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useWorkoutSession(id: string | null) {
  return useQuery({
    queryKey: workoutKeys.session(id ?? ""),
    queryFn: () => unwrap(commands.getWorkoutSession(id as string)),
    enabled: id != null,
  });
}

export function useExercises(query: string, includeArchived: boolean) {
  return useQuery({
    queryKey: workoutKeys.exercises(query, includeArchived),
    queryFn: () => unwrap(commands.listExercises(query.length > 0 ? query : null, includeArchived)),
    placeholderData: keepPreviousData,
  });
}

export function useWorkoutVolume(from: string, to: string) {
  return useQuery({
    queryKey: workoutKeys.volume(from, to),
    queryFn: () => unwrap(commands.workoutVolumeSummary(from, to)),
    enabled: from.length > 0 && to.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useExerciseRecords(exerciseId: string | null) {
  return useQuery({
    queryKey: workoutKeys.records(exerciseId ?? ""),
    queryFn: () => unwrap(commands.exercisePersonalRecords(exerciseId)),
  });
}

export function useBodyTrend(limit: number) {
  return useQuery({
    queryKey: workoutKeys.bodyTrend(limit),
    queryFn: () => unwrap(commands.bodyTrend(limit)),
  });
}

export function useBodyProfile() {
  return useQuery({
    queryKey: workoutKeys.bodyProfile,
    queryFn: () => unwrap(commands.getBodyProfile()),
  });
}

export function useDailyEnergyBalance(date: string) {
  return useQuery({
    queryKey: workoutKeys.energy(date),
    queryFn: () => unwrap(commands.dailyEnergyBalance(date)),
    enabled: date.length > 0,
    placeholderData: keepPreviousData,
  });
}

// ── write ─────────────────────────────────────────────────────────────

export function useStartWorkoutSession() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: StartWorkoutSessionInput) => unwrap(commands.startWorkoutSession(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function usePatchWorkoutSession() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: PatchWorkoutSessionInput) => unwrap(commands.patchWorkoutSession(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useDeleteWorkoutSession() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteWorkoutSession(id)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useAddWorkoutSet() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: AddWorkoutSetInput) => unwrap(commands.addWorkoutSet(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function usePatchWorkoutSet() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: PatchWorkoutSetInput) => unwrap(commands.patchWorkoutSet(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useRemoveWorkoutSet() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.removeWorkoutSet(id)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useUpsertExercise() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: UpsertExerciseInput) => unwrap(commands.upsertExercise(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useAddExerciseAlias() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: ({ exerciseId, alias }: { exerciseId: string; alias: string }) =>
      unwrap(commands.addExerciseAlias(exerciseId, alias)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useRemoveExerciseAlias() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: ({ exerciseId, alias }: { exerciseId: string; alias: string }) =>
      unwrap(commands.removeExerciseAlias(exerciseId, alias)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useSetExerciseArchived() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      unwrap(commands.setExerciseArchived(id, archived)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useRecordBodyMetric() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: RecordBodyMetricInput) => unwrap(commands.recordBodyMetric(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}

export function useSetBodyProfile() {
  const invalidate = useInvalidateWorkout();
  return useMutation({
    mutationFn: (input: SetBodyProfileInput) => unwrap(commands.setBodyProfile(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("workout", e, "운동"),
  });
}
