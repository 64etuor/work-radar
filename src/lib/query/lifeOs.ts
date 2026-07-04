import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  commands,
  type CreateMissionHorizonInput,
  type LinkSprintGoalInput,
  type SelectWeeklyFocusInput,
  type UpdateMissionHorizonInput,
  type UpsertGuardrailInput,
} from "@/bindings";

import { unwrap } from "./client";
import { okrKeys } from "./okr";

export const lifeOsKeys = {
  all: ["lifeOs"] as const,
  horizons: ["lifeOs", "horizons"] as const,
  guardrails: (quarter: string) => ["lifeOs", "guardrails", quarter] as const,
  objectiveHorizonLinks: (quarter: string) => ["lifeOs", "objectiveHorizonLinks", quarter] as const,
  weeklyFocus: (weekStart: string) => ["lifeOs", "weeklyFocus", weekStart] as const,
  sprintCycle: ["lifeOs", "sprintCycle"] as const,
};

function invalidateLifeOs(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: lifeOsKeys.all });
}

function invalidateWeeklyFocusConsumers(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["today"] });
  void qc.invalidateQueries({ queryKey: ["weeklyReview"] });
  void qc.invalidateQueries({ queryKey: ["sprintConfig"] });
  void qc.invalidateQueries({ queryKey: ["sprintStatus"] });
  return invalidateLifeOs(qc);
}

export function useMissionHorizons() {
  return useQuery({
    queryKey: lifeOsKeys.horizons,
    queryFn: () => unwrap(commands.listMissionHorizons()),
  });
}

export function useCreateMissionHorizon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMissionHorizonInput) => unwrap(commands.createMissionHorizon(input)),
    onSuccess: () => invalidateLifeOs(qc),
  });
}

export function useUpdateMissionHorizon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMissionHorizonInput) => unwrap(commands.updateMissionHorizon(input)),
    onSuccess: () => invalidateLifeOs(qc),
  });
}

export function useDeleteMissionHorizon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteMissionHorizon(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: okrKeys.all });
      return invalidateLifeOs(qc);
    },
  });
}

export function useGuardrails(quarter: string) {
  return useQuery({
    queryKey: lifeOsKeys.guardrails(quarter),
    queryFn: () => unwrap(commands.listGuardrails(quarter)),
    enabled: quarter.length > 0,
  });
}

export function useUpsertGuardrail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertGuardrailInput) => unwrap(commands.upsertGuardrail(input)),
    onSuccess: () => invalidateLifeOs(qc),
  });
}

export function useDeleteGuardrail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteGuardrail(id)),
    onSuccess: () => invalidateLifeOs(qc),
  });
}

export function useObjectiveHorizonLinks(quarter: string) {
  return useQuery({
    queryKey: lifeOsKeys.objectiveHorizonLinks(quarter),
    queryFn: () => unwrap(commands.listObjectiveHorizonLinks(quarter)),
    enabled: quarter.length > 0,
  });
}

export function useLinkObjectiveHorizon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ objectiveId, horizonId }: { objectiveId: string; horizonId: string }) =>
      unwrap(commands.linkObjectiveHorizon(objectiveId, horizonId)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: okrKeys.all });
      return invalidateLifeOs(qc);
    },
  });
}

export function useUnlinkObjectiveHorizon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ objectiveId, horizonId }: { objectiveId: string; horizonId: string }) =>
      unwrap(commands.unlinkObjectiveHorizon(objectiveId, horizonId)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: okrKeys.all });
      return invalidateLifeOs(qc);
    },
  });
}

export function useSelectedWeeklyFocus(weekStart: string) {
  return useQuery({
    queryKey: lifeOsKeys.weeklyFocus(weekStart),
    queryFn: () => unwrap(commands.selectedWeeklyFocus(weekStart)),
    enabled: weekStart.length > 0,
  });
}

export function useSelectWeeklyFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SelectWeeklyFocusInput) => unwrap(commands.selectWeeklyFocus(input)),
    onSuccess: () => invalidateWeeklyFocusConsumers(qc),
  });
}

export function useCurrentSprintCycle() {
  return useQuery({
    queryKey: lifeOsKeys.sprintCycle,
    queryFn: () => unwrap(commands.currentSprintCycle()),
    staleTime: 60_000,
  });
}

export function useLinkSprintGoalToWeeklyFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkSprintGoalInput) => unwrap(commands.linkSprintGoalToWeeklyFocus(input)),
    onSuccess: () => invalidateWeeklyFocusConsumers(qc),
  });
}
