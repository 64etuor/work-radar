import { useQuery } from "@tanstack/react-query";

import { commands } from "../../bindings";
import { unwrap } from "./client";

/** Read-only snapshot of the governance harness derived projections (Control Room). */
export function useControlRoomSnapshot() {
  return useQuery({
    queryKey: ["control-room-snapshot"],
    queryFn: () => unwrap(commands.getControlRoomSnapshot()),
    staleTime: 5_000,
  });
}
