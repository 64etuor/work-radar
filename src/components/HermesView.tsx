import { Button } from "@/components/ui/button";

import { HermesChatInput } from "./hermes/HermesChatInput";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesPanel } from "./hermes/HermesPanel";
import {
  selectActiveTab,
  selectIsStreaming,
  useHermesTabsStore,
} from "./hermes/useHermesTabsStore";

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
  const tabs = useHermesTabsStore();
  const active = selectActiveTab(tabs);
  const isStreaming = selectIsStreaming(tabs);

  return (
    <HermesPanel
      isStreaming={isStreaming}
      onNewTab={tabs.openTab}
      onCloseActive={async () => {
        if (active) await tabs.closeTab(active.id);
      }}
      onRestart={async () => {
        if (active) await tabs.restart(active.id);
      }}
      canCreateTab={tabs.tabs.size < tabs.cap}
      activeTabId={active?.id ?? null}
    >
      {active ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <HermesChatLog messages={active.messages} />
          <HermesChatInput
            onSend={(text, images) => void tabs.send(active.id, text, images)}
            onCancel={() => void tabs.cancel(active.id)}
            disabled={active.status === "starting"}
            isStreaming={isStreaming}
            commandsList={active.commandsList}
          />
        </div>
      ) : (
        <EmptyHermesState onCreateTab={tabs.openTab} />
      )}
    </HermesPanel>
  );
}
