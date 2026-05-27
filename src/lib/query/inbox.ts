import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type InboxItem, type InboxCounts } from "@/bindings";
import { unwrap } from "./client";

export function useInboxItems(source: string | null = null, includeDismissed = false) {
  return useQuery<InboxItem[]>({
    queryKey: ["inboxItems", source, includeDismissed],
    queryFn: () => unwrap(commands.listInboxItems(source, includeDismissed)),
    refetchInterval: 60_000,
  });
}

export function useInboxCounts() {
  return useQuery<InboxCounts>({
    queryKey: ["inboxCounts"],
    queryFn: () => unwrap(commands.inboxCounts()),
    refetchInterval: 60_000,
  });
}

export function useMarkInboxItemRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.markInboxItemRead(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inboxItems"] });
      void qc.invalidateQueries({ queryKey: ["inboxCounts"] });
    },
  });
}

export function useDismissInboxItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.dismissInboxItem(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inboxItems"] });
      void qc.invalidateQueries({ queryKey: ["inboxCounts"] });
    },
  });
}
