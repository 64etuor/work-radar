import { Check, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { commands, type PendingAction } from "@/bindings";
import { Button } from "@/components/ui/button";

import { formatActionKind, groupPendingByOrigin } from "./pendingActions";

export function PendingActionsPanel() {
  const [actions, setActions] = useState<PendingAction[]>([]);
  const load = useCallback(async () => {
    const res = await commands.listPendingActions();
    if (res.status === "ok") setActions(res.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (id: string, approve: boolean) => {
      const res = approve
        ? await commands.approveExternalAction(id)
        : await commands.rejectExternalAction(id);
      if (res.status === "ok") await load();
    },
    [load],
  );

  if (actions.length === 0) return null;
  const groups = [...groupPendingByOrigin(actions).entries()];

  return (
    <section aria-label="승인 대기 외부 액션" className="flex flex-col gap-3">
      {groups.map(([origin, items]) => (
        <div key={origin} className="flex flex-col gap-2">
          <p className="text-muted-foreground typo-label-sm">{origin}</p>
          {items.map((a) => (
            <div
              key={a.id}
              className="border-border flex items-start justify-between gap-2 rounded-md border p-2"
            >
              <div className="min-w-0">
                <p className="typo-title-sm">{formatActionKind(a.kind)}</p>
                {a.preview ? (
                  <p className="text-muted-foreground typo-caption-sm truncate">{a.preview}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="승인"
                  className="size-7 p-0"
                  onClick={() => void decide(a.id, true)}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="거절"
                  className="size-7 p-0"
                  onClick={() => void decide(a.id, false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
