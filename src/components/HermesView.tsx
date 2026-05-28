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
  const activeTab = useHermesTabsStore(selectActiveTab);
  const isStreaming = useHermesTabsStore(selectIsStreaming);
  const tabsSize = useHermesTabsStore((s) => s.tabs.size);
  const cap = useHermesTabsStore((s) => s.cap);
  const openTab = useHermesTabsStore((s) => s.openTab);
  const closeTab = useHermesTabsStore((s) => s.closeTab);
  const send = useHermesTabsStore((s) => s.send);
  const cancel = useHermesTabsStore((s) => s.cancel);
  const restart = useHermesTabsStore((s) => s.restart);

  return (
    <HermesPanel
      isStreaming={isStreaming}
      // 헤더 타이틀은 첫 메시지 이후로만 노출 — 빈 상태에선 중앙 워드마크가 정체성 담당.
      showHeaderTitle={(activeTab?.messages.length ?? 0) > 0}
      onNewTab={openTab}
      onCloseActive={async () => {
        if (activeTab) await closeTab(activeTab.id);
      }}
      onRestart={async () => {
        if (activeTab) await restart(activeTab.id);
      }}
      canCreateTab={tabsSize < cap}
      activeTabId={activeTab?.id ?? null}
    >
      {activeTab ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <HermesChatLog messages={activeTab.messages} />
          <HermesChatInput
            onSend={(text, images) => void send(activeTab.id, text, images)}
            onCancel={() => void cancel(activeTab.id)}
            disabled={activeTab.status === "starting"}
            isStreaming={isStreaming}
            commandsList={activeTab.commandsList}
          />
        </div>
      ) : (
        <EmptyHermesState onCreateTab={openTab} />
      )}
    </HermesPanel>
  );
}
