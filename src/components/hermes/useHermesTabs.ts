import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer } from "react";

import { commands } from "@/bindings";
import { unwrap } from "@/lib/query/client";

import type { AcpCommand, HermesMessage, SessionStatus, ToolCallSummary } from "./types";

export type TabId = string;

export interface TabState {
  id: TabId;
  name: string;
  status: SessionStatus;
  messages: HermesMessage[];
  commandsList: AcpCommand[];
}

export interface TabsState {
  tabs: Map<TabId, TabState>;
  activeTabId: TabId | null;
}

export const EMPTY_TABS_STATE: TabsState = {
  tabs: new Map(),
  activeTabId: null,
};

export const HERMES_TAB_CAP = 3;

type Action =
  | { type: "open-tab"; tabId: TabId; defaultName: string }
  | { type: "close-tab"; tabId: TabId }
  | { type: "set-active"; tabId: TabId }
  | { type: "rename"; tabId: TabId; name: string }
  | { type: "set-status"; tabId: TabId; status: SessionStatus }
  | { type: "user"; tabId: TabId; text: string; images: string[] }
  | { type: "agent-chunk"; tabId: TabId; text: string }
  | { type: "agent-tool"; tabId: TabId; tool: ToolCallSummary }
  | { type: "tool-update"; tabId: TabId; id?: string; patch: Partial<ToolCallSummary> }
  | { type: "agent-end"; tabId: TabId; status: "ok" | "cancelled" | "error"; error?: string }
  | { type: "system"; tabId: TabId; text: string; level: "info" | "warn" | "error" }
  | { type: "available-commands"; tabId: TabId; commands: AcpCommand[] }
  | { type: "reset-tab"; tabId: TabId };

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function updateTab(state: TabsState, tabId: TabId, fn: (t: TabState) => TabState): TabsState {
  const t = state.tabs.get(tabId);
  if (!t) return state;
  const next = new Map(state.tabs);
  next.set(tabId, fn(t));
  return { ...state, tabs: next };
}

function appendMessage(t: TabState, m: HermesMessage): TabState {
  return { ...t, messages: [...t.messages, m] };
}

function ensureAssistant(t: TabState): TabState {
  const last = t.messages[t.messages.length - 1];
  if (last && last.role === "assistant" && !last.done) return t;
  return appendMessage(t, {
    id: uid(),
    role: "assistant",
    chunks: [],
    toolCalls: [],
    ts: Date.now(),
    done: false,
  });
}

export function tabsReducer(state: TabsState, a: Action): TabsState {
  switch (a.type) {
    case "open-tab": {
      if (state.tabs.has(a.tabId)) return state;
      const next = new Map(state.tabs);
      next.set(a.tabId, {
        id: a.tabId,
        name: a.defaultName,
        status: "idle",
        messages: [],
        commandsList: [],
      });
      return {
        tabs: next,
        activeTabId: state.activeTabId ?? a.tabId,
      };
    }
    case "close-tab": {
      if (!state.tabs.has(a.tabId)) return state;
      const next = new Map(state.tabs);
      next.delete(a.tabId);
      let activeTabId = state.activeTabId;
      if (activeTabId === a.tabId) {
        activeTabId = next.size > 0 ? Array.from(next.keys())[0] : null;
      }
      return { tabs: next, activeTabId };
    }
    case "set-active":
      return state.tabs.has(a.tabId) ? { ...state, activeTabId: a.tabId } : state;

    case "rename":
      return updateTab(state, a.tabId, (t) => ({ ...t, name: a.name }));

    case "set-status":
      return updateTab(state, a.tabId, (t) => ({ ...t, status: a.status }));

    case "user":
      return updateTab(state, a.tabId, (t) =>
        appendMessage(t, {
          id: uid(),
          role: "user",
          text: a.text,
          images: a.images,
          ts: Date.now(),
        }),
      );

    case "system":
      return updateTab(state, a.tabId, (t) =>
        appendMessage(t, {
          id: uid(),
          role: "system",
          text: a.text,
          level: a.level,
          ts: Date.now(),
        }),
      );

    case "agent-chunk": {
      return updateTab(state, a.tabId, (t) => {
        const ensured = ensureAssistant(t);
        const last = ensured.messages[ensured.messages.length - 1];
        if (!last || last.role !== "assistant") return ensured;
        const updated = { ...last, chunks: [...last.chunks, a.text] };
        return { ...ensured, messages: [...ensured.messages.slice(0, -1), updated] };
      });
    }

    case "agent-tool": {
      return updateTab(state, a.tabId, (t) => {
        const ensured = ensureAssistant(t);
        const last = ensured.messages[ensured.messages.length - 1];
        if (!last || last.role !== "assistant") return ensured;
        const updated = { ...last, toolCalls: [...last.toolCalls, a.tool] };
        return { ...ensured, messages: [...ensured.messages.slice(0, -1), updated] };
      });
    }

    case "tool-update": {
      if (!a.id) return state;
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        messages: t.messages.map((m) =>
          m.role === "assistant"
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) => (tc.id === a.id ? { ...tc, ...a.patch } : tc)),
              }
            : m,
        ),
      }));
    }

    case "agent-end": {
      return updateTab(state, a.tabId, (t) => {
        const ensured = ensureAssistant(t);
        const last = ensured.messages[ensured.messages.length - 1];
        const closed =
          last && last.role === "assistant"
            ? { ...ensured, messages: [...ensured.messages.slice(0, -1), { ...last, done: true }] }
            : ensured;
        if (a.status !== "ok") {
          return appendMessage(closed, {
            id: uid(),
            role: "system",
            text: a.error ?? `turn ${a.status}`,
            level: "warn",
            ts: Date.now(),
          });
        }
        return closed;
      });
    }

    case "available-commands":
      return updateTab(state, a.tabId, (t) => ({ ...t, commandsList: a.commands }));

    case "reset-tab":
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        messages: [],
        status: "idle",
        commandsList: [],
      }));
  }
}

function pickDefaultName(state: TabsState): string {
  for (let i = 1; i <= 10; i++) {
    const name = `Hermes ${i}`;
    if (!Array.from(state.tabs.values()).some((t) => t.name === name)) return name;
  }
  return `Hermes ${state.tabs.size + 1}`;
}

export function useHermesTabs() {
  const [state, dispatch] = useReducer(tabsReducer, EMPTY_TABS_STATE);

  useEffect(() => {
    let cancelled = false;
    const cleanups: UnlistenFn[] = [];

    type WithTab<T> = T & { tabId?: string };

    const setup = async <T>(event: string, handler: (e: { payload: WithTab<T> }) => void) => {
      const un = await listen<WithTab<T>>(event, handler);
      if (cancelled) {
        un();
        return;
      }
      cleanups.push(un);
    };

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
          if (!e.payload.tabId) return;
          dispatch({
            type: "agent-end",
            tabId: e.payload.tabId,
            status: e.payload.status,
            error: e.payload.error,
          });
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
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((u) => u());
    };
  }, []);

  const openTab = useCallback(async (): Promise<TabId | null> => {
    if (state.tabs.size >= HERMES_TAB_CAP) return null;
    const tabId = uid();
    const defaultName = pickDefaultName(state);
    let assignedId: TabId | null = null;
    try {
      await unwrap(commands.hermesAgentOpenTab(tabId));
      dispatch({ type: "open-tab", tabId, defaultName });
      assignedId = tabId;
    } catch (e) {
      if (state.activeTabId) {
        dispatch({
          type: "system",
          tabId: state.activeTabId,
          text: `탭 생성 실패: ${(e as Error).message}`,
          level: "error",
        });
      }
    }
    return assignedId;
  }, [state]);

  const closeTab = useCallback(async (tabId: TabId) => {
    try {
      await unwrap(commands.hermesAgentCloseTab(tabId));
    } catch {
      // best-effort
    }
    dispatch({ type: "close-tab", tabId });
  }, []);

  const send = useCallback(async (tabId: TabId, text: string, images: string[] = []) => {
    if (!text.trim() && images.length === 0) return;
    dispatch({ type: "user", tabId, text, images });
    dispatch({ type: "set-status", tabId, status: "starting" });
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
  }, []);

  const cancel = useCallback(async (tabId: TabId) => {
    try {
      await unwrap(commands.hermesAgentCancel(tabId));
    } catch {
      // best-effort
    }
  }, []);

  const restart = useCallback(async (tabId: TabId) => {
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
  }, []);

  const setActive = useCallback((tabId: TabId) => {
    dispatch({ type: "set-active", tabId });
  }, []);

  const rename = useCallback((tabId: TabId, name: string) => {
    dispatch({ type: "rename", tabId, name });
  }, []);

  const activeTab = state.activeTabId ? (state.tabs.get(state.activeTabId) ?? null) : null;

  const isStreaming = useMemo(() => {
    if (!activeTab) return false;
    const last = activeTab.messages[activeTab.messages.length - 1];
    return !!last && last.role === "assistant" && !last.done;
  }, [activeTab]);

  return {
    state,
    activeTab,
    isStreaming,
    openTab,
    closeTab,
    setActive,
    send,
    cancel,
    restart,
    rename,
  };
}
