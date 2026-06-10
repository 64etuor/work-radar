import type { AcpCommand, HermesMessage, SessionStatus, ToolCallSummary } from "./types";

export type TabId = string;

export interface TabState {
  id: TabId;
  name: string;
  status: SessionStatus;
  messages: HermesMessage[];
  pendingOutbound: OutboundDraft[];
  commandsList: AcpCommand[];
  /** 바인딩된 프로젝트(없으면 null). 바인딩되면 그 프로젝트 레포의 boule-governance MCP가
   *  세션 spawn에 주입된다(Rust가 DB로 레포 경로 해석). */
  projectId: string | null;
}

export interface TabsState {
  tabs: Map<TabId, TabState>;
  activeTabId: TabId | null;
}

export type OutboundDraft = {
  id: string;
  text: string;
  images: string[];
  ts: number;
};

export const EMPTY_TABS_STATE: TabsState = {
  tabs: new Map(),
  activeTabId: null,
};

type Action =
  | { type: "open-tab"; tabId: TabId; defaultName: string; projectId?: string | null }
  | { type: "set-project"; tabId: TabId; projectId: string | null }
  | { type: "close-tab"; tabId: TabId }
  | { type: "set-active"; tabId: TabId }
  | { type: "rename"; tabId: TabId; name: string }
  | { type: "set-status"; tabId: TabId; status: SessionStatus }
  | { type: "user"; tabId: TabId; text: string; images: string[] }
  | { type: "queue-user"; tabId: TabId; draft: OutboundDraft }
  | { type: "drop-queued-user"; tabId: TabId; draftId: string }
  | { type: "agent-chunk"; tabId: TabId; text: string }
  | { type: "agent-tool"; tabId: TabId; tool: ToolCallSummary }
  | { type: "tool-update"; tabId: TabId; id?: string; patch: Partial<ToolCallSummary> }
  | { type: "agent-end"; tabId: TabId; status: "ok" | "cancelled" | "error"; error?: string }
  | { type: "system"; tabId: TabId; text: string; level: "info" | "warn" | "error" }
  | { type: "available-commands"; tabId: TabId; commands: AcpCommand[] }
  | {
      type: "ask-user";
      tabId: TabId;
      requestId: string;
      toolName?: string;
      options: { id: string; label: string }[];
    }
  | { type: "ask-resolve"; tabId: TabId; requestId: string; choice: string }
  | { type: "reset-tab"; tabId: TabId }
  | { type: "load-messages"; tabId: TabId; messages: HermesMessage[] };

export const uid = (): string =>
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
        pendingOutbound: [],
        commandsList: [],
        projectId: a.projectId ?? null,
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

    case "set-project":
      return updateTab(state, a.tabId, (t) => ({ ...t, projectId: a.projectId }));

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

    case "queue-user":
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        pendingOutbound: [...t.pendingOutbound, a.draft],
      }));

    case "drop-queued-user":
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        pendingOutbound: t.pendingOutbound.filter((draft) => draft.id !== a.draftId),
      }));

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
        // Only patch toolCalls on in-flight (not done) assistant messages.
        // Late tool-update events arriving after agent-end must not mutate closed turns.
        messages: t.messages.map((m) =>
          m.role === "assistant" && !m.done
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
        const last = t.messages[t.messages.length - 1];
        const hasInFlight = last && last.role === "assistant" && !last.done;
        if (!hasInFlight) {
          // No in-flight assistant — late event. Do NOT call ensureAssistant (would create
          // a stray done-immediately bubble). For non-ok status append a system warn directly.
          if (a.status !== "ok") {
            return appendMessage(t, {
              id: uid(),
              role: "system",
              text: a.error ?? `turn ${a.status}`,
              level: "warn",
              ts: Date.now(),
            });
          }
          return t; // genuine late ok-end: no-op
        }
        // Close the in-flight assistant turn.
        const closed = {
          ...t,
          messages: [...t.messages.slice(0, -1), { ...last, done: true }],
        };
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

    case "ask-user":
      return updateTab(state, a.tabId, (t) =>
        appendMessage(t, {
          id: uid(),
          role: "ask",
          requestId: a.requestId,
          toolName: a.toolName,
          options: a.options,
          ts: Date.now(),
        }),
      );

    case "ask-resolve":
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        messages: t.messages.map((m) =>
          m.role === "ask" && m.requestId === a.requestId ? { ...m, resolved: a.choice } : m,
        ),
      }));

    case "reset-tab":
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        messages: [],
        pendingOutbound: [],
        status: "idle",
        commandsList: [],
      }));

    case "load-messages":
      return updateTab(state, a.tabId, (t) => ({ ...t, messages: a.messages }));
  }
}

export function pickDefaultName(state: TabsState): string {
  for (let i = 1; i <= 10; i++) {
    const name = `Hermes ${i}`;
    if (!Array.from(state.tabs.values()).some((t) => t.name === name)) return name;
  }
  return `Hermes ${state.tabs.size + 1}`;
}
