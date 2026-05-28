import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { commands } from "@/bindings";
import { unwrap } from "@/lib/query/client";

import type { AcpCommand, HermesMessage, SessionStatus, ToolCallSummary } from "./types";

type EndStatus = "ok" | "cancelled" | "error";

type Action =
  | { type: "user"; text: string; images: string[] }
  | { type: "assistant-chunk"; text: string }
  | { type: "assistant-tool"; tool: ToolCallSummary }
  | { type: "tool-update"; id?: string; patch: Partial<ToolCallSummary> }
  | { type: "assistant-end"; status: EndStatus; error?: string }
  | { type: "cancel-if-streaming" }
  | { type: "system"; text: string; level: "info" | "warn" | "error" }
  | { type: "reset" };

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const isInProgressStatus = (s?: string) => !s || s === "in_progress" || s === "pending";

function sweepTools(
  tools: ToolCallSummary[],
  status: EndStatus,
): { tools: ToolCallSummary[]; changed: boolean } {
  const terminal = status === "ok" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
  let changed = false;
  const next = tools.map((t) => {
    if (isInProgressStatus(t.status)) {
      changed = true;
      return { ...t, status: terminal };
    }
    return t;
  });
  return { tools: changed ? next : tools, changed };
}

function reducer(state: HermesMessage[], a: Action): HermesMessage[] {
  if (a.type === "reset") return [];
  if (a.type === "user")
    return [...state, { id: uid(), role: "user", text: a.text, images: a.images, ts: Date.now() }];
  if (a.type === "system")
    return [...state, { id: uid(), role: "system", text: a.text, level: a.level, ts: Date.now() }];

  const last = state[state.length - 1];
  const lastIsStreamingAssistant = !!last && last.role === "assistant" && !last.done;
  const ensureAssistant = (): HermesMessage[] => {
    if (lastIsStreamingAssistant) return state;
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
  if (a.type === "tool-update") {
    if (!a.id) return state;
    // 늦은 tool-update 가 이미 종료된(done) assistant 메시지를 다시 진행 중으로
    // 만들지 않도록, in-flight 메시지에 한해서만 패치한다.
    return state.map((m) => {
      if (m.role !== "assistant" || m.done) return m;
      const tools = m.toolCalls.map((t) => (t.id === a.id ? { ...t, ...a.patch } : t));
      return { ...m, toolCalls: tools };
    });
  }
  if (a.type === "cancel-if-streaming") {
    // 진행 중인 턴이 없으면 no-op — 빈 assistant 버블/노이즈 방지.
    if (!lastIsStreamingAssistant) return state;
    const lastA = last as Extract<HermesMessage, { role: "assistant" }>;
    const swept = sweepTools(lastA.toolCalls, "cancelled");
    return [
      ...state.slice(0, -1),
      { ...lastA, toolCalls: swept.tools, done: true },
      { id: uid(), role: "system", text: "취소됨", level: "warn", ts: Date.now() },
    ];
  }
  if (a.type === "assistant-end") {
    // 이미 done 처리된 마지막 assistant 에 대한 중복 turn-end 는 무시.
    if (!lastIsStreamingAssistant) {
      // 단, 직전에 user 만 보낸 상태에서 error 가 오면 시스템 메시지는 남긴다.
      if (a.status !== "ok") {
        const label =
          a.status === "cancelled" ? "취소됨" : a.status === "error" ? "오류" : a.status;
        return [
          ...state,
          {
            id: uid(),
            role: "system",
            text: a.error ?? label,
            level: a.status === "error" ? "error" : "warn",
            ts: Date.now(),
          },
        ];
      }
      return state;
    }
    const lastA = last as Extract<HermesMessage, { role: "assistant" }>;
    const swept = sweepTools(lastA.toolCalls, a.status);
    const next: HermesMessage[] = [
      ...state.slice(0, -1),
      { ...lastA, toolCalls: swept.tools, done: true },
    ];
    if (a.status !== "ok") {
      const label = a.status === "cancelled" ? "취소됨" : a.status === "error" ? "오류" : a.status;
      return [
        ...next,
        {
          id: uid(),
          role: "system",
          text: a.error ?? label,
          level: a.status === "error" ? "error" : "warn",
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

  // Latest snapshots for stable callbacks — avoids stale closures and lets
  // send/cancel inspect live state without re-creating the callback on every render.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const statusRef = useRef(status);
  statusRef.current = status;

  const isStreaming = (() => {
    const last = messages[messages.length - 1];
    return !!last && last.role === "assistant" && !last.done;
  })();

  // Mount-only event subscriptions — StrictMode-safe cancelled-race guard.
  // Each individual listen() await checks `cancelled` and immediately calls its
  // own unlisten if cleanup already fired. This prevents the React 19 StrictMode
  // double-mount from leaving orphaned listeners (first mount's subscriptions
  // cancel themselves before the second mount completes its own setup).
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
            status: p.status ?? "in_progress",
          },
        });
      });

      // tool_call_update: status/title patches over an in-flight tool call.
      await setup<Record<string, unknown>>("hermes-agent:tool-call-update", (e) => {
        const p = e.payload as {
          toolCallId?: string;
          title?: string;
          kind?: string;
          status?: string;
        };
        if (!p.toolCallId) return;
        const patch: Partial<ToolCallSummary> = {};
        if (p.title !== undefined) patch.title = p.title;
        if (p.kind !== undefined) patch.kind = p.kind;
        if (p.status !== undefined) patch.status = p.status;
        dispatch({ type: "tool-update", id: p.toolCallId, patch });
      });

      await setup<{ status: EndStatus; error?: string }>("hermes-agent:turn-end", (e) =>
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
        // 백엔드 에러 발생 시 진행 중인 턴도 함께 닫는다.
        dispatch({ type: "assistant-end", status: "error", error: e.payload.message });
        dispatch({
          type: "system",
          text: `Hermes 오류: ${e.payload.message}`,
          level: "error",
        });
      });

      // All listeners now live. Kick off the session — session-ready event
      // is guaranteed to be caught by the listener registered above.
      if (cancelled) return;
      setStatus("starting");
      try {
        await unwrap(commands.hermesAgentStart());
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          dispatch({
            type: "system",
            text: `시작 실패: ${(e as Error).message}`,
            level: "error",
          });
        }
      }
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
    // 스트리밍 중이면 재진입 금지 — 백엔드에 두 번째 session/prompt 가 겹치지 않도록.
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (last && last.role === "assistant" && !last.done) {
      dispatch({
        type: "system",
        text: "이전 답변이 끝난 뒤 다시 시도하세요.",
        level: "warn",
      });
      return;
    }
    dispatch({ type: "user", text, images });
    try {
      const curr = statusRef.current;
      if (curr === "error" || curr === "idle") {
        // Session is dead or never started — force restart before send.
        try {
          await unwrap(commands.hermesAgentStop());
        } catch {
          // ignore — best-effort cleanup
        }
        setStatus("starting");
        await unwrap(commands.hermesAgentStart());
      }
      await unwrap(commands.hermesAgentSend(text, images));
    } catch (e) {
      // 송신 실패 → 세션이 죽었을 가능성. status 를 error 로 떨궈
      // 다음 send 가 자동 재시작 경로를 타게 한다.
      setStatus("error");
      dispatch({
        type: "system",
        text: `송신 실패: ${(e as Error).message}`,
        level: "error",
      });
    }
  }, []);

  const cancel = useCallback(async () => {
    // 진행 중인 턴이 있을 때만 프런트 상태를 닫는다.
    // 이미 끝났는데 또 누른 경우 (예: 늦은 클릭) 빈 assistant 버블을 만들지 않는다.
    dispatch({ type: "cancel-if-streaming" });
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

  return { messages, status, commandsList, isStreaming, start, send, cancel, restart };
}
