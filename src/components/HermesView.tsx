import { useEffect, useMemo } from "react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { unwrap } from "@/lib/query/client";

import { HermesChatInput } from "./hermes/HermesChatInput";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesPanel } from "./hermes/HermesPanel";
import { HermesSidebar } from "./hermes/HermesSidebar";
import { useHermesPanelState } from "./hermes/useHermesPanelState";
import {
  selectActiveTab,
  selectIsStreaming,
  selectShowResourceWarning,
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
  const showWarn = useHermesTabsStore(selectShowResourceWarning);
  // Subscribe to the Map reference; derive the array with useMemo so HermesSidebar
  // doesn't re-render on every streaming chunk (Array.from inline would produce a new
  // array identity on every store update).
  const tabsMap = useHermesTabsStore((s) => s.tabs);
  const tabs = useMemo(() => Array.from(tabsMap.values()), [tabsMap]);
  const activeTabId = useHermesTabsStore((s) => s.activeTabId);
  const openTab = useHermesTabsStore((s) => s.openTab);
  const closeTab = useHermesTabsStore((s) => s.closeTab);
  const setActive = useHermesTabsStore((s) => s.setActive);
  const send = useHermesTabsStore((s) => s.send);
  const cancel = useHermesTabsStore((s) => s.cancel);
  const restart = useHermesTabsStore((s) => s.restart);
  const respondAsk = useHermesTabsStore((s) => s.respondAsk);
  const rename = useHermesTabsStore((s) => s.rename);

  // Read panel open state to gate the keyboard handler (see below).
  const { state: panelState } = useHermesPanelState();

  const removeSession = async (id: string) => {
    try {
      await unwrap(commands.hermesAgentCloseTab(id));
    } catch {
      /* best-effort */
    }
    try {
      await unwrap(commands.hermesSessionDelete(id));
    } catch {
      /* best-effort */
    }
    useHermesTabsStore.getState()._dispatch({ type: "close-tab", tabId: id });
    if (useHermesTabsStore.getState().tabs.size === 0) await openTab();
  };

  const onRename = (id: string, name: string) => {
    rename(id, name);
    void unwrap(commands.hermesSessionRename(id, name)).catch(() => {});
  };

  // ⌘N / ⌘W / ⌘1–9 keyboard shortcuts.
  //
  // Gating: HermesView is always mounted (App.tsx:218), so we must explicitly check
  // panelState.open — if the panel is closed the handler returns immediately. This
  // prevents mutating Hermes state invisibly while the panel is hidden.
  //
  // Conflict: useViewShortcuts (src/lib/useViewShortcuts.ts:88) catches ALL metaKey
  // events unconditionally and routes them through the keymap — Cmd+1/2/4–9 navigate
  // views. When we handle a Hermes key we call stopImmediatePropagation() so the view
  // shortcut listener (registered first, in App.tsx) does not also fire. Our listener
  // is appended last so stopImmediatePropagation() here is safe: it only suppresses
  // later-registered listeners, not already-fired earlier ones.
  //
  // ⌘1–9: additionally skip when focus is in an editable element (mirrors
  // useViewShortcuts isEditableTarget guard) — typing "1" in the search box must not
  // switch sessions.
  useEffect(() => {
    const isEditable = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (t as HTMLElement).isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!panelState.open) return;
      if (!(e.metaKey || e.ctrlKey)) return;

      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        e.stopImmediatePropagation();
        void openTab();
      } else if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (activeTabId) void closeTab(activeTabId);
      } else if (/^[1-9]$/.test(e.key) && !isEditable(e.target)) {
        const idx = Number(e.key) - 1;
        const list = Array.from(useHermesTabsStore.getState().tabs.values());
        if (list[idx]) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setActive(list[idx].id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelState.open, activeTabId, openTab, closeTab, setActive]);

  return (
    <HermesPanel
      isStreaming={isStreaming}
      // 헤더 타이틀은 첫 메시지 이후로만 노출 — 빈 상태에선 중앙 워드마크가 정체성 담당.
      showHeaderTitle={(activeTab?.messages.length ?? 0) > 0}
      onRestart={async () => {
        if (activeTab) await restart(activeTab.id);
      }}
    >
      <div className="flex min-h-0 flex-1">
        <HermesSidebar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActive}
          onNew={() => void openTab()}
          onDelete={(id) => void removeSession(id)}
          onRename={onRename}
          showResourceWarning={showWarn}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {activeTab ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <HermesChatLog
                messages={activeTab.messages}
                onRespond={(requestId, optionId, cancelled) =>
                  void respondAsk(activeTab.id, requestId, optionId, cancelled)
                }
              />
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
        </div>
      </div>
    </HermesPanel>
  );
}
