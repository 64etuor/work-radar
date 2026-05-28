import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useReducer, useState } from "react";

import { commands } from "@/bindings";
import { unwrap } from "@/lib/query/client";

import type { AcpCommand, HermesMessage, SessionStatus, ToolCallSummary } from "./types";

type Action =
  | { type: "user"; text: string; images: string[] }
  | { type: "assistant-chunk"; text: string }
  | { type: "assistant-tool"; tool: ToolCallSummary }
  | { type: "assistant-end"; status: "ok" | "cancelled" | "error"; error?: string }
  | { type: "system"; text: string; level: "info" | "warn" | "error" }
  | { type: "reset" };

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function reducer(state: HermesMessage[], a: Action): HermesMessage[] {
  if (a.type === "reset") return [];
  if (a.type === "user")
    return [...state, { id: uid(), role: "user", text: a.text, images: a.images, ts: Date.now() }];
  if (a.type === "system")
    return [...state, { id: uid(), role: "system", text: a.text, level: a.level, ts: Date.now() }];

  const last = state[state.length - 1];
  const ensureAssistant = (): HermesMessage[] => {
    if (last && last.role === "assistant" && !last.done) return state;
    return [
      ...state,
      { id: uid(), role: "assistant", chunks: [], toolCalls: [], ts: Date.now(), done: false },
    ];
  };

  if (a.type === "assistant-chunk") {
    const s = ensureAssistant();
    const lastA = s[s.length - 1] as Extract<HermesMessage, { role: "assistant" }>;
    return [...s.slice(0, -1), { ...lastA, chunks: [...lastA.chunks, a.text] }];
  }
  if (a.type === "assistant-tool") {
    const s = ensureAssistant();
    const lastA = s[s.length - 1] as Extract<HermesMessage, { role: "assistant" }>;
    return [...s.slice(0, -1), { ...lastA, toolCalls: [...lastA.toolCalls, a.tool] }];
  }
  if (a.type === "assistant-end") {
    const s = ensureAssistant();
    const lastA = s[s.length - 1] as Extract<HermesMessage, { role: "assistant" }>;
    const next: HermesMessage[] = [...s.slice(0, -1), { ...lastA, done: true }];
    if (a.status !== "ok") {
      return [
        ...next,
        {
          id: uid(),
          role: "system",
          text: a.error ?? `turn ${a.status}`,
          level: "warn",
          ts: Date.now(),
        },
      ];
    }
    return next;
  }
  return state;
}

export function useHermesAgent() {
  const [messages, dispatch] = useReducer(reducer, [] as HermesMessage[]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [commandsList, setCommandsList] = useState<AcpCommand[]>([]);

  // Mount-only event subscriptions — StrictMode-safe cancelled-race guard.
  // Each individual listen() await checks `cancelled` and immediately calls its
  // own unlisten if cleanup already fired. This prevents the React 19 StrictMode
  // double-mount from leaving orphaned listeners (first mount's subscriptions
  // cancel themselves before the second mount completes its own setup).
  //
  // NOTE: hermes-agent:turn-end is subscribed here but C2's dispatch_incoming
  // does NOT currently emit it — turn completion is only observable when the
  // underlying session/prompt IPC call resolves, which doesn't surface to the
  // frontend. As a result the last assistant message may stay with done=false
  // indefinitely. D4's smoke test should verify whether a real model response
  // triggers this event; if not, a follow-up can wire turn completion via the
  // IPC return value or a dedicated session/update discriminator.
  useEffect(() => {
    let cancelled = false;
    const cleanups: UnlistenFn[] = [];

    const setup = async <T>(event: string, handler: (e: { payload: T }) => void) => {
      const un = await listen<T>(event, handler);
      if (cancelled) {
        un();
        return;
      }
      cleanups.push(un);
    };

    void (async () => {
      await setup<{ kind?: string; text?: string }>("hermes-agent:chunk", (e) => {
        if (e.payload.kind !== "agent") return;
        dispatch({ type: "assistant-chunk", text: e.payload.text ?? "" });
      });

      // Raw ACP update — camelCase per C2 doc.
      await setup<Record<string, unknown>>("hermes-agent:tool-call", (e) => {
        const p = e.payload as {
          toolCallId?: string;
          title?: string;
          kind?: string;
          status?: string;
        };
        dispatch({
          type: "assistant-tool",
          tool: {
            id: p.toolCallId,
            title: p.title ?? p.kind ?? "tool",
            kind: p.kind,
            status: p.status,
          },
        });
      });

      // turn-end subscription: may never fire — see NOTE above.
      await setup<{ status: "ok" | "cancelled" | "error"; error?: string }>(
        "hermes-agent:turn-end",
        (e) =>
          dispatch({
            type: "assistant-end",
            status: e.payload.status,
            error: e.payload.error,
          }),
      );

      await setup<{ commands: AcpCommand[] }>("hermes-agent:available-commands", (e) =>
        setCommandsList(e.payload.commands ?? []),
      );

      await setup<unknown>("hermes-agent:session-ready", () => setStatus("ready"));

      await setup<{ kind: string; message: string }>("hermes-agent:error", (e) => {
        setStatus("error");
        dispatch({
          type: "system",
          text: `Hermes 오류: ${e.payload.message}`,
          level: "error",
        });
      });
    })().catch((err) => {
      if (!cancelled) {
        setStatus("error");
        dispatch({
          type: "system",
          text: `이벤트 구독 실패: ${(err as Error).message}`,
          level: "error",
        });
      }
    });

    return () => {
      cancelled = true;
      cleanups.forEach((u) => u());
    };
  }, []);

  const start = useCallback(async () => {
    setStatus((prev) => (prev === "ready" || prev === "starting" ? prev : "starting"));
    try {
      await unwrap(commands.hermesAgentStart());
    } catch (e) {
      setStatus("error");
      dispatch({ type: "system", text: `시작 실패: ${(e as Error).message}`, level: "error" });
    }
  }, []);

  const send = useCallback(async (text: string, images: string[] = []) => {
    if (!text.trim() && images.length === 0) return;
    dispatch({ type: "user", text, images });
    try {
      await unwrap(commands.hermesAgentSend(text, images));
    } catch (e) {
      dispatch({
        type: "system",
        text: `송신 실패: ${(e as Error).message}`,
        level: "error",
      });
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await unwrap(commands.hermesAgentCancel());
    } catch {
      // ignore — cancel is best-effort
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      await unwrap(commands.hermesAgentStop());
    } catch {
      // ignore — stop is best-effort before reset
    }
    dispatch({ type: "reset" });
    setStatus("idle");
    await start();
  }, [start]);

  const isStreaming = (() => {
    const last = messages[messages.length - 1];
    return !!last && last.role === "assistant" && !last.done;
  })();

  return { messages, status, commandsList, isStreaming, start, send, cancel, restart };
}
