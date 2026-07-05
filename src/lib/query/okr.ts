import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateKeyResultInput,
  type CreateObjectiveInput,
  type OkrConfidence,
  type UpdateKeyResultInput,
  type UpdateObjectiveInput,
} from "@/bindings";

import { unwrap } from "./client";

export const okrKeys = {
  all: ["okr"] as const,
  mission: ["okr", "mission"] as const,
  objectives: (quarter: string) => ["okr", "objectives", quarter] as const,
  checkIns: (quarter: string) => ["okr", "checkIns", quarter] as const,
  signalStats: (quarter: string) => ["okr", "signalStats", quarter] as const,
};

function invalidateOkr(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: okrKeys.all });
}

/** KR ↔ 루틴 연결/해제 — 연결하면 진행이 루틴 완료에서 쿼리타임 파생(수동 입력 대체). */
export function useSetKeyResultRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, routineId }: { id: string; routineId: string | null }) =>
      unwrap(commands.setKeyResultRoutine(id, routineId)),
    onSuccess: () => void invalidateOkr(qc),
  });
}

export function useMission() {
  return useQuery({
    queryKey: okrKeys.mission,
    queryFn: () => unwrap(commands.getMission()),
  });
}

export function useSetMission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ statement, note }: { statement: string; note: string | null }) =>
      unwrap(commands.setMission(statement, note)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useObjectives(quarter: string) {
  return useQuery({
    queryKey: okrKeys.objectives(quarter),
    queryFn: () => unwrap(commands.listObjectives(quarter)),
    enabled: quarter.length > 0,
  });
}

export function useObjectiveSignalStats(quarter: string) {
  return useQuery({
    queryKey: okrKeys.signalStats(quarter),
    queryFn: () => unwrap(commands.objectiveSignalStats(quarter)),
    enabled: quarter.length > 0,
  });
}

export function useOkrCheckIns(quarter: string) {
  return useQuery({
    queryKey: okrKeys.checkIns(quarter),
    queryFn: () => unwrap(commands.listCheckIns(quarter)),
    enabled: quarter.length > 0,
  });
}

export function useCreateObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateObjectiveInput) => unwrap(commands.createObjective(input)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useUpdateObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateObjectiveInput) => unwrap(commands.updateObjective(input)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useCloseObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reflection }: { id: string; reflection: string | null }) =>
      unwrap(commands.closeObjective(id, reflection)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useDeleteObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteObjective(id)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useCreateKeyResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateKeyResultInput) => unwrap(commands.createKeyResult(input)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useUpdateKeyResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateKeyResultInput) => unwrap(commands.updateKeyResult(input)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useDeleteKeyResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteKeyResult(id)),
    onSuccess: () => invalidateOkr(qc),
  });
}

export function useUpsertOkrCheckIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      keyResultId,
      weekStart,
      confidence,
      note,
    }: {
      keyResultId: string;
      weekStart: string;
      confidence: OkrConfidence;
      note: string | null;
    }) => unwrap(commands.upsertCheckIn(keyResultId, weekStart, confidence, note)),
    onSuccess: () => invalidateOkr(qc),
  });
}
