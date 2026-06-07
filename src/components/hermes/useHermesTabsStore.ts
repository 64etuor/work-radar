/**
 * Global zustand store for Hermes multi-session tabs.
 *
 * This file owns two things:
 *  1. `useHermesTabsStore` — zustand selector-compatible store wrapping tabsReducer.
 *  2. `useHermesTabsBootstrap` — mount-once effect that registers the 7 Tauri event
 *     listeners and fetches cap from the backend. Must be called EXACTLY ONCE in App.tsx.
 *
 * HermesView and AgentStatusBar both subscribe via store selectors — no prop drilling,
 * no duplicate listener registrations.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { create } from "zustand";

import { commands } from "@/bindings";
import { unwrap } from "@/lib/query/client";

import { autoTitleFrom, rowsToMessages, shouldAutoTitle } from "./sessionList";
import type { AcpCommand, ToolCallSummary } from "./types";
import {
  EMPTY_TABS_STATE,
  HERMES_TAB_CAP_FALLBACK,
  type TabId,
  tabsReducer,
  type TabsState,
  uid,
} from "./useHermesTabs";

// ── Store shape ──────────────────────────────────────────────────────────────

interface HermesTabsActions {
  /** Open a new tab (cap check + backend IPC). Returns assigned tabId or null on cap/error. */
  openTab: () => Promise<TabId | null>;
  closeTab: (tabId: TabId) => Promise<void>;
  setActive: (tabId: TabId) => void;
  rename: (tabId: TabId, name: string) => void;
  send: (tabId: TabId, text: string, images?: string[]) => Promise<void>;
  cancel: (tabId: TabId) => Promise<void>;
  restart: (tabId: TabId) => Promise<void>;
  /** Route an ask-user card choice to the agent + optimistically mark resolved.
   *  cancelled=true → dismiss (sends ACP cancelled outcome). */
  respondAsk: (
    tabId: TabId,
    requestId: string,
    optionId: string,
    cancelled: boolean,
  ) => Promise<void>;
  /** Internal — used by bootstrap. Not for external callers. */
  _dispatch: (action: Parameters<typeof tabsReducer>[1]) => void;
}

type HermesTabsStore = TabsState & HermesTabsActions;

export const useHermesTabsStore = create<HermesTabsStore>((set, get) => {
  const dispatch = (action: Parameters<typeof tabsReducer>[1]) =>
    set((s) => tabsReducer(s, action));

  return {
    ...EMPTY_TABS_STATE,

    _dispatch: dispatch,

    openTab: async () => {
      const s = get();
      if (s.tabs.size >= s.cap) return null;
      const tabId = uid();
      try {
        await unwrap(commands.hermesAgentOpenTab(tabId));
        await unwrap(commands.hermesSessionCreate(tabId, "새 세션"));
        dispatch({ type: "open-tab", tabId, defaultName: "새 세션" });
        return tabId;
      } catch (e) {
        const active = get().activeTabId;
        if (active) {
          dispatch({
            type: "system",
            tabId: active,
            text: `세션 생성 실패: ${(e as Error).message}`,
            level: "error",
          });
        }
        return null;
      }
    },

    closeTab: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentCloseTab(tabId));
      } catch {
        /* best-effort */
      }
      try {
        await unwrap(commands.hermesSessionArchive(tabId));
      } catch {
        /* best-effort */
      }
      dispatch({ type: "close-tab", tabId });
      if (get().tabs.size === 0) {
        await get().openTab();
      }
    },

    setActive: (tabId) => {
      dispatch({ type: "set-active", tabId });
      const tab = get().tabs.get(tabId);
      if (tab && tab.messages.length === 0) {
        void commands.hermesSessionMessages(tabId).then((res) => {
          if (res.status === "ok" && res.data.length > 0) {
            dispatch({ type: "load-messages", tabId, messages: rowsToMessages(res.data) });
          }
        });
      }
    },

    rename: (tabId, name) => {
      dispatch({ type: "rename", tabId, name });
    },

    send: async (tabId, text, images = []) => {
      if (!text.trim() && images.length === 0) return;
      dispatch({ type: "user", tabId, text, images });
      dispatch({ type: "set-status", tabId, status: "starting" });
      // 영속: user 메시지 + 자동 제목(첫 메시지일 때)
      void unwrap(commands.hermesMessageAppend(tabId, "user", text, null)).catch(() => {});
      const tab = get().tabs.get(tabId);
      if (tab && shouldAutoTitle(tab.name) && text.trim()) {
        const title = autoTitleFrom(text);
        dispatch({ type: "rename", tabId, name: title });
        void unwrap(commands.hermesSessionRename(tabId, title)).catch(() => {});
      }
      try {
        await unwrap(commands.hermesAgentSend(tabId, text, images));
      } catch (e) {
        dispatch({
          type: "system",
          tabId,
          text: `송신 실패: ${(e as Error).message}`,
          level: "error",
        });
        dispatch({ type: "set-status", tabId, status: "error" });
      }
    },

    cancel: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentCancel(tabId));
      } catch {
        // best-effort
      }
    },

    restart: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentCloseTab(tabId));
      } catch {
        // best-effort
      }
      dispatch({ type: "reset-tab", tabId });
      try {
        await unwrap(commands.hermesAgentOpenTab(tabId));
      } catch {
        // ignore
      }
    },

    respondAsk: async (tabId, requestId, optionId, cancelled) => {
      const choice = cancelled ? "cancelled" : optionId;
      // Optimistic: mark resolved immediately so the card disables on tap.
      dispatch({ type: "ask-resolve", tabId, requestId, choice });
      try {
        await unwrap(commands.hermesAskUserRespond(tabId, requestId, optionId, cancelled));
      } catch (e) {
        dispatch({
          type: "system",
          tabId,
          text: `응답 송신 실패: ${(e as Error).message}`,
          level: "error",
        });
      }
    },
  };
});

// ── Bootstrap hook — mount ONCE in App.tsx ───────────────────────────────────

/**
 * Registers the 7 Tauri hermes-agent:* event listeners and fetches `cap` from the
 * backend. Must be called exactly once (App.tsx, above <AgentStatusBar />).
 *
 * StrictMode / double-mount safe: uses `cancelled` flag + per-await guard pattern
 * (same as original useHermesTabs).
 */
// Module-level flag: ensures the default "always 1 tab" auto-open fires exactly
// once across React StrictMode double-mount. Page reload resets the module.
let didOpenDefaultTab = false;

export function useHermesTabsBootstrap() {
  useEffect(() => {
    let cancelled = false;
    const cleanups: UnlistenFn[] = [];

    const dispatch = useHermesTabsStore.getState()._dispatch;

    const ensureDefaultTab = async () => {
      if (didOpenDefaultTab) return;
      if (useHermesTabsStore.getState().tabs.size > 0) {
        didOpenDefaultTab = true;
        return;
      }
      didOpenDefaultTab = true;
      await useHermesTabsStore.getState().openTab();
    };

    type WithTab<T> = T & { tabId?: string };

    const setup = async <T>(event: string, handler: (e: { payload: WithTab<T> }) => void) => {
      const un = await listen<WithTab<T>>(event, handler);
      if (cancelled) {
        un();
        return;
      }
      cleanups.push(un);
    };

    // 부팅: DB에서 세션 목록 복원. 없으면 빈 세션 1개 생성.
    void (async () => {
      const res = await commands.hermesSessionsList();
      if (cancelled) return;
      if (res.status === "ok" && res.data.length > 0) {
        for (const row of res.data) {
          dispatch({ type: "open-tab", tabId: row.id, defaultName: row.name });
        }
        const firstId = res.data[0].id;
        dispatch({ type: "set-active", tabId: firstId });
        // 활성 세션 메시지 lazy-load
        const msgs = await commands.hermesSessionMessages(firstId);
        if (!cancelled && msgs.status === "ok") {
          dispatch({ type: "load-messages", tabId: firstId, messages: rowsToMessages(msgs.data) });
        }
      } else {
        await ensureDefaultTab();
      }
    })();

    void (async () => {
      await setup<{ kind?: string; text?: string }>("hermes-agent:chunk", (e) => {
        if (!e.payload.tabId) return;
        if (e.payload.kind !== "agent") return;
        dispatch({ type: "agent-chunk", tabId: e.payload.tabId, text: e.payload.text ?? "" });
      });

      await setup<Record<string, unknown>>("hermes-agent:tool-call", (e) => {
        const p = e.payload;
        if (!p.tabId) return;
        dispatch({
          type: "agent-tool",
          tabId: p.tabId as string,
          tool: {
            id: p.toolCallId as string | undefined,
            title: (p.title as string) ?? (p.kind as string) ?? "tool",
            kind: p.kind as string | undefined,
            status: (p.status as string) ?? "in_progress",
          },
        });
      });

      await setup<Record<string, unknown>>("hermes-agent:tool-call-update", (e) => {
        const p = e.payload;
        if (!p.tabId || !p.toolCallId) return;
        const patch: Partial<ToolCallSummary> = {};
        if (p.title !== undefined) patch.title = p.title as string;
        if (p.kind !== undefined) patch.kind = p.kind as string;
        if (p.status !== undefined) patch.status = p.status as string;
        dispatch({
          type: "tool-update",
          tabId: p.tabId as string,
          id: p.toolCallId as string,
          patch,
        });
      });

      await setup<{ status: "ok" | "cancelled" | "error"; error?: string }>(
        "hermes-agent:turn-end",
        (e) => {
          const tabId = e.payload.tabId;
          if (!tabId) return;
          dispatch({
            type: "agent-end",
            tabId,
            status: e.payload.status,
            error: e.payload.error,
          });
          // 영속: 방금 닫힌 assistant 메시지 1개를 DB에 append.
          const tab = useHermesTabsStore.getState().tabs.get(tabId);
          if (tab) {
            let lastContent: string | undefined;
            let lastToolCalls: ToolCallSummary[] | undefined;
            for (let i = tab.messages.length - 1; i >= 0; i--) {
              const m = tab.messages[i];
              if (m.role === "assistant") {
                lastContent = m.chunks.join("");
                lastToolCalls = m.toolCalls;
                break;
              }
            }
            if (lastContent !== undefined || lastToolCalls !== undefined) {
              const content = lastContent ?? "";
              const toolJson =
                lastToolCalls && lastToolCalls.length ? JSON.stringify(lastToolCalls) : null;
              if (content || toolJson) {
                void unwrap(
                  commands.hermesMessageAppend(tabId, "assistant", content, toolJson),
                ).catch(() => {});
              }
            }
          }
        },
      );

      await setup<{ commands: AcpCommand[] }>("hermes-agent:available-commands", (e) => {
        if (!e.payload.tabId) return;
        dispatch({
          type: "available-commands",
          tabId: e.payload.tabId,
          commands: e.payload.commands ?? [],
        });
      });

      await setup<unknown>("hermes-agent:session-ready", (e) => {
        const tabId = (e.payload as { tabId?: string } | null)?.tabId;
        if (!tabId) return;
        dispatch({ type: "set-status", tabId, status: "ready" });
      });

      await setup<{ kind: string; message: string }>("hermes-agent:error", (e) => {
        if (!e.payload.tabId) return;
        dispatch({ type: "set-status", tabId: e.payload.tabId, status: "error" });
        dispatch({
          type: "system",
          tabId: e.payload.tabId,
          text: `Hermes 오류: ${e.payload.message}`,
          level: "error",
        });
      });

      await setup<{
        requestId?: string;
        toolName?: string;
        options?: { id: string; label: string }[];
      }>("hermes-agent:ask-user", (e) => {
        if (!e.payload.tabId || !e.payload.requestId) return;
        dispatch({
          type: "ask-user",
          tabId: e.payload.tabId,
          requestId: e.payload.requestId,
          toolName: e.payload.toolName,
          options: e.payload.options ?? [],
        });
      });
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((u) => u());
    };
  }, []);
}

// ── Derived selectors (convenience) ─────────────────────────────────────────

/** Returns the active TabState or null. */
export function selectActiveTab(s: TabsState) {
  return s.activeTabId ? (s.tabs.get(s.activeTabId) ?? null) : null;
}

/** Returns true when the active tab has an in-flight (not done) assistant message. */
export function selectIsStreaming(s: TabsState): boolean {
  const active = selectActiveTab(s);
  if (!active) return false;
  const last = active.messages[active.messages.length - 1];
  return !!last && last.role === "assistant" && !last.done;
}

// Re-export cap fallback so callers don't need to import from useHermesTabs directly.
export { HERMES_TAB_CAP_FALLBACK };
