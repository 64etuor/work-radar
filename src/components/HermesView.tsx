import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { unwrap } from "@/lib/query/client";
import { useProjects } from "@/lib/query/projects";

import { HermesChatInput } from "./hermes/HermesChatInput";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesPanel } from "./hermes/HermesPanel";
import { HermesSidebar } from "./hermes/HermesSidebar";
import { resolveHermesShortcut } from "./hermes/keyboardShortcuts";
import { confirmDeleteSession } from "./hermes/sessionConfirm";
import { useHermesPanelState } from "./hermes/useHermesPanelState";
import {
  selectActiveQueueCount,
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
  const queueCount = useHermesTabsStore(selectActiveQueueCount);
  const showWarn = useHermesTabsStore(selectShowResourceWarning);
  // Subscribe to the Map reference; derive the array with useMemo so HermesSidebar
  // doesn't re-render on every streaming chunk (Array.from inline would produce a new
  // array identity on every store update).
  const tabsMap = useHermesTabsStore((s) => s.tabs);
  const tabs = useMemo(() => Array.from(tabsMap.values()), [tabsMap]);
  const activeTabId = useHermesTabsStore((s) => s.activeTabId);
  const openTab = useHermesTabsStore((s) => s.openTab);
  const ensureAgent = useHermesTabsStore((s) => s.ensureAgent);
  const setActive = useHermesTabsStore((s) => s.setActive);
  const send = useHermesTabsStore((s) => s.send);
  const cancel = useHermesTabsStore((s) => s.cancel);
  const restart = useHermesTabsStore((s) => s.restart);
  const respondAsk = useHermesTabsStore((s) => s.respondAsk);
  const rename = useHermesTabsStore((s) => s.rename);
  const setSessionProject = useHermesTabsStore((s) => s.setSessionProject);
  const projects = useProjects();

  // Read panel open state to gate the keyboard handler (see below).
  const { state: panelState } = useHermesPanelState();

  // 좌측 세션 사이드바 표시 토글(상단 버튼). localStorage 로 패널 재오픈/재시작에도 유지.
  // 사이드바를 접으면 채팅 단일 컬럼으로 좁게 쓸 수 있다(폰챗 형태). 세션은 닫혀도 그대로 유지된다.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("hermes.sidebarOpen") !== "false",
  );
  const toggleSidebar = () =>
    setSidebarOpen((v) => {
      const next = !v;
      localStorage.setItem("hermes.sidebarOpen", String(next));
      return next;
    });

  const removeSession = async (id: string) => {
    if (!confirmDeleteSession(useHermesTabsStore.getState().tabs.get(id))) return;
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
  // ⌘W: hides the app window only. Closing a Hermes session is an explicit sidebar action.
  //
  // ⌘1–9: additionally skip when focus is in an editable element (mirrors
  // useViewShortcuts isEditableTarget guard) — typing "1" in the search box must not
  // switch sessions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveHermesShortcut(e, {
        panelOpen: panelState.open,
        tabs: Array.from(useHermesTabsStore.getState().tabs.values()),
      });
      if (!action) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      if (action.type === "new-tab") {
        void openTab();
      } else if (action.type === "hide-window") {
        void getCurrentWindow().hide();
      } else {
        setActive(action.tabId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelState.open, activeTabId, openTab, setActive]);

  return (
    <HermesPanel
      isStreaming={isStreaming}
      // 헤더 타이틀은 첫 메시지 이후로만 노출 — 빈 상태에선 중앙 워드마크가 정체성 담당.
      showHeaderTitle={(activeTab?.messages.length ?? 0) > 0}
      onRestart={async () => {
        if (activeTab) await restart(activeTab.id);
      }}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      headerExtra={
        activeTab && (
          // 세션 ↔ 프로젝트 바인딩: 선택하면 그 프로젝트 레포의 boule-governance MCP가
          // 다음 spawn에 주입된다(레포 경로는 Rust가 DB로 해석). 변경 시 child 재시작.
          <Select
            value={activeTab.projectId ?? "none"}
            onValueChange={(value) =>
              void setSessionProject(activeTab.id, value === "none" ? null : value)
            }
          >
            <SelectTrigger
              data-no-drag
              className="h-7 max-w-36 text-xs"
              aria-label="세션 프로젝트 바인딩"
              title="프로젝트를 바인딩하면 이 세션에서 boule 거버넌스 도구(propose_plan 등)를 쓸 수 있습니다"
            >
              <SelectValue placeholder="프로젝트 없음" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">프로젝트 없음</SelectItem>
              {(projects.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
    >
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <HermesSidebar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActive}
            onNew={() => void openTab()}
            onDelete={(id) => void removeSession(id)}
            onRename={onRename}
            showResourceWarning={showWarn}
          />
        )}
        {/* min-w-0 필수: 없으면 긴 툴 호출/코드 블록이 flex 컬럼을 늘려 채팅창 레이아웃이 깨진다. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <HermesChatLog
                // 세션별 remount → 열거나 전환할 때마다 initialScrollRef 가 리셋되어
                // 즉시(instant) 최하단으로 붙는다(스트리밍 중 append 는 같은 mount라 smooth 유지).
                key={activeTab.id}
                messages={activeTab.messages}
                onRespond={(requestId, optionId, cancelled) =>
                  void respondAsk(activeTab.id, requestId, optionId, cancelled)
                }
              />
              <HermesChatInput
                onSend={(text, images) => void send(activeTab.id, text, images)}
                onCancel={() => void cancel(activeTab.id)}
                onFocusInput={() => void ensureAgent(activeTab.id)}
                disabled={false}
                isStreaming={isStreaming}
                queueCount={queueCount}
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
