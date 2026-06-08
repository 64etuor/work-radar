import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type SetBouleConfigInput_Deserialize } from "../../bindings";
import { unwrap } from "./client";

/** Read-only snapshot of the governance harness derived projections (Control Room). */
export function useControlRoomSnapshot() {
  return useQuery({
    queryKey: ["control-room-snapshot"],
    queryFn: () => unwrap(commands.getControlRoomSnapshot()),
    staleTime: 5_000,
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
