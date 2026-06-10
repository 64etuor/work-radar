import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type SetBouleConfigInput_Deserialize } from "../../bindings";
import { unwrap } from "./client";

/** LIVE per-project Control Room snapshot, folded from the project's `.boule/workspace`
 *  events by the read-only `boule snapshot` CLI. Disabled until a projectId is provided. */
export function useProjectControlRoomSnapshot(projectId: string | null) {
  return useQuery({
    queryKey: ["control-room-snapshot", projectId],
    queryFn: () => unwrap(commands.getProjectControlRoomSnapshot(projectId!)),
    enabled: projectId != null,
    staleTime: 2_000,
    refetchInterval: 4_000,
  });
}

const PROJECT_TICKER_LIST_KEY = ["project-ticker-list"] as const;

/** Live per-project ticker state from app SQLite, separate from the Control Room snapshot. */
export function useProjectTickerList() {
  return useQuery({
    queryKey: PROJECT_TICKER_LIST_KEY,
    queryFn: () => unwrap(commands.listProjectTickStatus()),
    refetchInterval: 4_000,
    staleTime: 2_000,
  });
}

/** App-bound scheduler heartbeat (single row). `null` data = scheduler never woke. */
export function useTickerSchedulerStatus() {
  return useQuery({
    queryKey: ["ticker-scheduler-status"],
    queryFn: () => unwrap(commands.getTickerSchedulerStatus()),
    refetchInterval: 4_000,
    staleTime: 2_000,
  });
}

export function useSetTickEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, enabled }: { projectId: string; enabled: boolean }) =>
      unwrap(commands.setProjectTickEnabled(projectId, enabled)),
    onSuccess: (res) => {
      qc.setQueryData(["project-tick-status", res.projectId], res);
      void qc.invalidateQueries({ queryKey: PROJECT_TICKER_LIST_KEY });
    },
  });
}

export function useSetTickInterval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, intervalSec }: { projectId: string; intervalSec: number | null }) =>
      unwrap(commands.setProjectTickInterval(projectId, intervalSec)),
    onSuccess: (res) => {
      qc.setQueryData(["project-tick-status", res.projectId], res);
      void qc.invalidateQueries({ queryKey: PROJECT_TICKER_LIST_KEY });
    },
  });
}

export function useSetTickLive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, live }: { projectId: string; live: boolean }) =>
      unwrap(commands.setProjectTickLive(projectId, live)),
    onSuccess: (res) => {
      qc.setQueryData(["project-tick-status", res.projectId], res);
      void qc.invalidateQueries({ queryKey: PROJECT_TICKER_LIST_KEY });
    },
  });
}

export function useTickNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unwrap(commands.tickProjectNow(projectId)),
    onSuccess: (res) => {
      qc.setQueryData(["project-tick-status", res.status.projectId], res.status);
      void qc.invalidateQueries({ queryKey: PROJECT_TICKER_LIST_KEY });
    },
  });
}

/** A designated local repo's Boule config (kind + autonomyLevel + reviewQuorum + optional
 *  budget/backends/routing/priceTable). Absent file ⇒ per-kind defaults
 *  (`configExists=false`). Disabled until a repoId is provided. */
export function useBouleConfig(repoId: string | null) {
  return useQuery({
    queryKey: ["boule-config", repoId],
    queryFn: () => unwrap(commands.getBouleConfig(repoId!)),
    enabled: repoId != null,
    staleTime: 5_000,
  });
}

/** Persist a local repo's Boule settings knobs; advanced JSON strings are parsed/validated in Rust.
 *  Primes the cache with the returned resolved view. */
export function useSetBouleConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetBouleConfigInput_Deserialize) => unwrap(commands.setBouleConfig(input)),
    onSuccess: (res) => {
      qc.setQueryData(["boule-config", res.repoId], res);
    },
  });
}
