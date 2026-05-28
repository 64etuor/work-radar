import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { unwrap } from "@/lib/query/client";

import { HotkeyCapture } from "./HotkeyCapture";

/**
 * Hermes 패널 설정 — 토글 단축키 캡처 + 패널 위치 리셋.
 * hermesGetToggleHotkey / hermesSetToggleHotkey (A2) + hermesPanelStateSet (A1) 사용.
 */
export function HermesPanelSettings() {
  const qc = useQueryClient();

  const hotkey = useQuery({
    queryKey: ["hermes-toggle-hotkey"],
    queryFn: async () => unwrap(commands.hermesGetToggleHotkey()),
  });

  const setHotkey = useMutation({
    mutationFn: async (spec: string) => unwrap(commands.hermesSetToggleHotkey(spec)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hermes-toggle-hotkey"] }),
  });

  const resetPos = useMutation({
    mutationFn: async () =>
      unwrap(commands.hermesPanelStateSet({ x: null, y: null, w: null, h: null, open: false })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hermes-panel-state"] }),
  });

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">Hermes 패널</h3>
      <HotkeyCapture
        value={hotkey.data ?? "Cmd+Shift+Space"}
        onChange={(spec) => setHotkey.mutate(spec)}
        label="토글 단축키"
        description="패널을 열고 닫는 OS 글로벌 단축키"
      />
      {setHotkey.isError && (
        <p className="text-xs text-[color:var(--destructive)]">
          단축키 등록 실패 — 다른 앱이나 nav 단축키와 충돌일 수 있습니다.
        </p>
      )}
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
