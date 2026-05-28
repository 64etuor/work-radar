import { Button } from "@/components/ui/button";

import { HermesChatInput } from "./hermes/HermesChatInput";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesPanel } from "./hermes/HermesPanel";
import { HERMES_TAB_CAP, useHermesTabs } from "./hermes/useHermesTabs";

function EmptyHermesState({ onCreateTab }: { onCreateTab: () => Promise<unknown> }) {
  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
      <Button variant="default" onClick={() => void onCreateTab()}>
        새 탭 시작
      </Button>
    </div>
  );
}

export default function HermesView() {
  const tabs = useHermesTabs();
  const active = tabs.activeTab;

  return (
    <HermesPanel
      isStreaming={tabs.isStreaming}
      onNewTab={tabs.openTab}
      onCloseActive={async () => {
        if (active) await tabs.closeTab(active.id);
      }}
      onRestart={async () => {
        if (active) await tabs.restart(active.id);
      }}
      canCreateTab={tabs.state.tabs.size < HERMES_TAB_CAP}
      activeTabId={active?.id ?? null}
    >
      {active ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <HermesChatLog messages={active.messages} />
          <HermesChatInput
            onSend={(text, images) => void tabs.send(active.id, text, images)}
            onCancel={() => void tabs.cancel(active.id)}
            disabled={active.status === "starting"}
            isStreaming={tabs.isStreaming}
            commandsList={active.commandsList}
          />
        </div>
      ) : (
        <EmptyHermesState onCreateTab={tabs.openTab} />
      )}
    </HermesPanel>
  );
}
