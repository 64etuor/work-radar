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

import { commands, type HermesSessionRow } from "@/bindings";
import { unwrap } from "@/lib/query/client";

import { autoTitleFrom, rowsToMessages, shouldAutoTitle } from "./sessionList";
import type { AcpCommand, ToolCallSummary } from "./types";
import {
  EMPTY_TABS_STATE,
  type OutboundDraft,
  type TabId,
  tabsReducer,
  type TabsState,
  type TabState,
  uid,
} from "./useHermesTabs";

// ── Store shape ──────────────────────────────────────────────────────────────

interface HermesTabsActions {
  /** Open a new tab (cap check + backend IPC). Returns assigned tabId or null on cap/error. */
  openTab: () => Promise<TabId | null>;
  closeTab: (tabId: TabId) => Promise<void>;
  /** ACP 에이전트를 미리 spawn(멱등) — `/` 슬래시 명령(available-commands)이 첫 전송 전에
   *  로드되도록 한다. 입력창 포커스 시 호출. */
  ensureAgent: (tabId: TabId) => Promise<void>;
  setActive: (tabId: TabId) => void;
  rename: (tabId: TabId, name: string) => void;
  send: (tabId: TabId, text: string, images?: string[]) => Promise<void>;
  drainQueued: (tabId: TabId) => Promise<void>;
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

type RestoredSessionCandidate = {
  id: string;
  messageCount?: number;
};

export function chooseRestoredActiveSession<T extends RestoredSessionCandidate>(
  sessions: T[],
  nonEmptyIds?: Set<string>,
): string | null {
  const nonEmpty = sessions.find((session) =>
    nonEmptyIds ? nonEmptyIds.has(session.id) : (session.messageCount ?? 0) > 0,
  );
  return nonEmpty?.id ?? sessions[0]?.id ?? null;
}

function isTabBusy(tab: TabState): boolean {
  if (tab.status === "starting") return true;
  const last = tab.messages[tab.messages.length - 1];
  return !!last && last.role === "assistant" && !last.done;
}

export const useHermesTabsStore = create<HermesTabsStore>((set, get) => {
  const dispatch = (action: Parameters<typeof tabsReducer>[1]) =>
    set((s) => tabsReducer(s, action));
  const drainingTabs = new Set<TabId>();

  const sendNow = async (tabId: TabId, draft: OutboundDraft): Promise<boolean> => {
    dispatch({ type: "user", tabId, text: draft.text, images: draft.images });
    dispatch({ type: "set-status", tabId, status: "starting" });
    // 영속: user 메시지 + 자동 제목(첫 메시지일 때)
    void unwrap(commands.hermesMessageAppend(tabId, "user", draft.text, null)).catch(() => {});
    const tab = get().tabs.get(tabId);
    if (tab && shouldAutoTitle(tab.name) && draft.text.trim()) {
      const title = autoTitleFrom(draft.text);
      dispatch({ type: "rename", tabId, name: title });
      void unwrap(commands.hermesSessionRename(tabId, title)).catch(() => {});
    }
    try {
      await unwrap(commands.hermesAgentSend(tabId, draft.text, draft.images));
      return true;
    } catch (e) {
      dispatch({
        type: "system",
        tabId,
        text: `송신 실패: ${(e as Error).message}`,
        level: "error",
      });
      dispatch({ type: "set-status", tabId, status: "error" });
      return false;
    }
  };

  return {
    ...EMPTY_TABS_STATE,

    _dispatch: dispatch,

    openTab: async () => {
      const tabId = uid();
      // 낙관적(Linear식): UI에 새 세션을 즉시 표시 + 활성화하고, 느린 백엔드는 뒤에서 처리한다.
      // (전엔 ACP 에이전트 spawn[느림]을 await 한 뒤에야 탭이 떠 "새 세션" 클릭 반응이 느렸다.)
      // dispatch 는 동기 → 클릭 즉시 리렌더로 새 세션이 뜬다.
      dispatch({ type: "open-tab", tabId, defaultName: "새 세션" });
      dispatch({ type: "set-active", tabId });
      // 세션 행 생성은 await(빠름) — 이후 메시지 append 의 FK 안전 확보. 실패는 한 줄 노출.
      try {
        await unwrap(commands.hermesSessionCreate(tabId, "새 세션"));
      } catch (e) {
        dispatch({
          type: "system",
          tabId,
          text: `세션 저장 실패: ${(e as Error).message}`,
          level: "error",
        });
      }
      // 에이전트 spawn(느림)은 백그라운드 — `/` 명령 로드용. 전송은 send 가 lazy-spawn 보장.
      void unwrap(commands.hermesAgentOpenTab(tabId)).catch(() => {});
      return tabId;
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

    ensureAgent: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentOpenTab(tabId));
      } catch {
        /* best-effort — 명령 로드 실패해도 채팅엔 영향 없음 */
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
      const tab = get().tabs.get(tabId);
      const draft: OutboundDraft = {
        id: uid(),
        text,
        images,
        ts: Date.now(),
      };
      if (tab && isTabBusy(tab)) {
        dispatch({ type: "queue-user", tabId, draft });
        return;
      }
      const ok = await sendNow(tabId, draft);
      if (ok) {
        await get().drainQueued(tabId);
      }
    },

    drainQueued: async (tabId) => {
      if (drainingTabs.has(tabId)) return;
      drainingTabs.add(tabId);
      try {
        while (true) {
          const tab = get().tabs.get(tabId);
          if (!tab || isTabBusy(tab) || tab.pendingOutbound.length === 0) return;
          const draft = tab.pendingOutbound[0];
          dispatch({ type: "drop-queued-user", tabId, draftId: draft.id });
          const ok = await sendNow(tabId, draft);
          if (!ok) return;
        }
      } finally {
        drainingTabs.delete(tabId);
      }
    },

    cancel: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentCancel(tabId));
      } catch {
        // best-effort
      }
      // 낙관적: 취소 후 입력 재활성화. 보통 turn-end(cancelled)가 와서 ready 로 정규화하지만,
      // 에이전트가 죽어 turn-end 가 안 오는 경우에도 "starting" 고착으로 입력이 막히지 않게 한다.
      dispatch({ type: "set-status", tabId, status: "ready" });
      void get().drainQueued(tabId);
    },

    // 에이전트 프로세스만 재시작한다(ACP child kill→respawn). **대화 기록은 보존**한다 —
    // reset-tab(메시지 wipe)을 호출하지 않는다. 다음 전송 때 Slice 5 replay 가 직전 맥락을
    // 다시 먹여 이어간다. (이전 버그: 이 버튼이 reset-tab 으로 대화를 날려 "초기화"처럼 보였음.)
    restart: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentCloseTab(tabId));
      } catch {
        // best-effort
      }
      dispatch({ type: "set-status", tabId, status: "idle" });
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

    // 부팅: DB에서 세션 목록 복원.
    // 다중 프로세스(GUI + --mcp-stdio)가 같은 DB를 공유해 list 가 일시 실패할 수 있다 → bounded
    // retry. **list 가 실패했을 때 빈 세션을 만들지 않는다**(전엔 실패 시 ensureDefaultTab 가 stray
    // "새 세션"을 만들어 실제 세션이 안 보이는 것처럼 됐다 — "또 아무것도 안 보임"). 진짜 빈
    // DB(ok+0건)일 때만 기본 세션을 만든다.
    void (async () => {
      let listed: HermesSessionRow[] | null = null;
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        const res = await commands.hermesSessionsList();
        if (cancelled) return;
        if (res.status === "ok") {
          listed = res.data;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
      if (cancelled) return;
      if (listed === null) return; // 영구 실패: 폴루션 방지(빈 세션 안 만듦). 다음 실행에서 복원.
      if (listed.length === 0) {
        await ensureDefaultTab();
        return;
      }
      for (const row of listed) {
        dispatch({ type: "open-tab", tabId: row.id, defaultName: row.name });
      }
      const firstId = chooseRestoredActiveSession(listed);
      if (!firstId) return;
      dispatch({ type: "set-active", tabId: firstId });
      // 활성 세션 먼저 로드(빠른 채팅 표시). 나머지는 백그라운드 순차 로드 — 동시 N쿼리 spike가
      // 다중 프로세스 DB 경합을 키워 활성 세션 표시까지 지연시키던 것을 피한다(프리뷰는 곧 채워짐).
      const activeMsgs = await commands.hermesSessionMessages(firstId);
      if (!cancelled && activeMsgs.status === "ok" && activeMsgs.data.length > 0) {
        dispatch({
          type: "load-messages",
          tabId: firstId,
          messages: rowsToMessages(activeMsgs.data),
        });
      }
      void (async () => {
        for (const row of listed) {
          if (cancelled) return;
          if (row.id === firstId) continue;
          const msgs = await commands.hermesSessionMessages(row.id);
          if (!cancelled && msgs.status === "ok" && msgs.data.length > 0) {
            dispatch({ type: "load-messages", tabId: row.id, messages: rowsToMessages(msgs.data) });
          }
        }
      })();
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
          // 턴 종료 시 세션 상태를 정규화한다. session-ready 는 spawn 1회만 오므로(2번째
          // 턴부터·취소 시 status 가 "starting"에 고착 → 입력창 disabled). 종료마다 ready 로
          // 되돌려 입력을 다시 활성화한다(실패 턴은 error). (cancel→입력 불가 버그의 근본 원인.)
          dispatch({
            type: "set-status",
            tabId,
            status: e.payload.status === "error" ? "error" : "ready",
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
          void useHermesTabsStore.getState().drainQueued(tabId);
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
  if (active.status === "starting") return true;
  const last = active.messages[active.messages.length - 1];
  return !!last && last.role === "assistant" && !last.done;
}

export function selectActiveQueueCount(s: TabsState): number {
  return selectActiveTab(s)?.pendingOutbound.length ?? 0;
}

/** 동시 실행(슬롯 점유) 세션 수가 임계 이상인지. 백엔드 holder 크기와 1:1은 아니지만
 *  FE가 추적하는 활성 탭 수의 근사로 충분(경고 전용, 차단 아님). */
export const LIVE_SESSION_WARN_THRESHOLD = 8;
export function selectShowResourceWarning(s: TabsState): boolean {
  return s.tabs.size >= LIVE_SESSION_WARN_THRESHOLD;
}
