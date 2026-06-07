import { useMutation, useQueryClient } from "@tanstack/react-query";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { unwrap } from "@/lib/query/client";

/**
 * Hermes 패널 설정 — 패널 위치 리셋.
 * hermesPanelStateSet (A1) 사용. (토글 단축키는 네비게이션/단축키 설정으로 이동됨.)
 */
export function HermesPanelSettings() {
  const qc = useQueryClient();

  const resetPos = useMutation({
    mutationFn: async () =>
      unwrap(commands.hermesPanelStateSet({ x: null, y: null, w: null, h: null, open: false })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hermes-panel-state"] }),
  });

  return (
    <section className="border-border space-y-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">Hermes 패널</h3>
      <Button
        variant="outline"
        size="sm"
        onClick={() => resetPos.mutate()}
        disabled={resetPos.isPending}
      >
        {resetPos.isPending ? "리셋 중…" : "패널 위치 리셋"}
      </Button>
      {resetPos.isError && (
        <p className="text-xs text-[color:var(--destructive)]">
          위치 리셋 실패: {String(resetPos.error)}
        </p>
      )}
    </section>
  );
}
