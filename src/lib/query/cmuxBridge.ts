// cmux notification bridge snapshot — read-only observer surface.
//
// INVARIANT #1: bridge data is display/control-plane context only. Telegram/Slack
// routing remains owned by the existing local hooks; Work Radar does not become a
// second getUpdates consumer or a message injector through this hook.

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/bindings";

import { unwrap } from "./client";

const CMUX_BRIDGE_POLL_MS = 30_000;

export function useCmuxBridgeSnapshot() {
  return useQuery({
    queryKey: ["cmuxBridgeSnapshot"],
    queryFn: () => unwrap(commands.cmuxBridgeSnapshot()),
    refetchInterval: CMUX_BRIDGE_POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
