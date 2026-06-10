import { z } from "zod";
import {
  requestSessionOpen,
  markWaiting,
  markBlocked,
  recordPressure,
  requestCheckpoint,
  markHandoffReady,
  requestSessionClose,
  closeSession,
  listSessions,
  sessionTrail,
} from "../../session/handlers.ts";
import { observeSessions, type ObserverAdapter } from "../../session/observer.ts";
import { okOrRefused } from "../response.ts";
import type { ToolContext } from "./context.ts";

export type SessionDeps = {
  observerCfg: { live: boolean };
  observerAdapter: ObserverAdapter;
};

/** Session registry + cmux observer tools: sessions, session, observe_sessions,
 *  request_session_open, mark_session_waiting, mark_session_blocked, record_context_pressure,
 *  request_checkpoint, mark_handoff_ready, request_session_close, close_session. */
export function registerSessionTools(ctx: ToolContext, deps: SessionDeps): void {
  const { server, workspace: WORKSPACE, now: nowFn, rand: randFn } = ctx;
  const { observerCfg: OBSERVER_CFG, observerAdapter } = deps;

  // ── Phase D: Session Registry + cmux Observer ─────────────────────────────────
  // 전부 verdict-free → 실행자-역할 verdict 게이트 비대상(approve/choose류 아님).
  // observe_sessions만 BOULE_OBSERVER_MODE=live에서 reconcile; 그 외엔 무동작 notice.
  server.registerTool(
    "sessions",
    { description: "비종료(non-terminal) session 목록 (read-only)", inputSchema: {} },
    async () => {
      const list = await listSessions(WORKSPACE);
      const text = list.length
        ? list
            .map((s) => `${s.sessionId} [${s.phase}] ${s.ownership} surface=${s.surface ?? "-"}`)
            .join("\n")
        : "(no open sessions)";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "session",
    {
      description: "session 상태 + audit chain (read-only)",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const t = await sessionTrail(WORKSPACE, { sessionId });
      const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${t.sessionId} [${t.phase}] ${t.ownership} surface=${t.surface ?? "-"}\n${chain}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "observe_sessions",
    {
      description:
        "라이브 cmux surface를 읽어 registry와 reconcile (observe/crash/recover/orphan-open) — 상태 변화시에만 1세션당 ≤1 이벤트. session_closed 절대 안 씀(no-auto-close). BOULE_OBSERVER_MODE=live 필요",
      inputSchema: {},
    },
    async () => {
      if (!OBSERVER_CFG.live)
        return {
          content: [
            {
              type: "text",
              text: "observer stub: BOULE_OBSERVER_MODE!=live → cmux 미접근, reconcile 생략",
            },
          ],
        };
      const s = await observeSessions(WORKSPACE, { adapter: observerAdapter }, nowFn(), randFn());
      return {
        content: [
          {
            type: "text",
            text: `observed=${s.observed} crashed=${s.crashed} recovered=${s.recovered} opened=${s.opened}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "request_session_open",
    {
      description:
        "planned 세션을 births (session_open_requested). ownership=user_owned|external_owned(기본 user_owned), surface 선택",
      inputSchema: {
        ownership: z.enum(["user_owned", "external_owned"]).optional(),
        surface: z.string().optional(),
      },
    },
    async ({ ownership, surface }) => {
      const r = await requestSessionOpen(WORKSPACE, { ownership, surface }, nowFn(), randFn());
      return { content: [{ type: "text", text: `session requested (planned): ${r.sessionId}` }] };
    },
  );

  server.registerTool(
    "mark_session_waiting",
    {
      description: "session을 waiting으로 기록 (verdict 없음)",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const r = await markWaiting(WORKSPACE, { sessionId }, nowFn(), randFn());
      return okOrRefused("waiting", r);
    },
  );

  server.registerTool(
    "mark_session_blocked",
    {
      description: "session을 blocked로 기록 (사유)",
      inputSchema: { sessionId: z.string(), reason: z.string() },
    },
    async ({ sessionId, reason }) => {
      const r = await markBlocked(WORKSPACE, { sessionId, reason }, nowFn(), randFn());
      return okOrRefused("blocked", r);
    },
  );

  server.registerTool(
    "record_context_pressure",
    {
      description: "context pressure level 기록 (high|critical만 phase 전진)",
      inputSchema: { sessionId: z.string(), level: z.enum(["low", "medium", "high", "critical"]) },
    },
    async ({ sessionId, level }) => {
      const r = await recordPressure(WORKSPACE, { sessionId, level }, nowFn(), randFn());
      return {
        content: [
          {
            type: "text",
            text: r.ok
              ? `pressure(${level}): ${r.eventId ?? ""}`
              : `REFUSED: ${r.reason ?? "unknown"}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "request_checkpoint",
    { description: "session checkpoint 요청 기록", inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) => {
      const r = await requestCheckpoint(WORKSPACE, { sessionId }, nowFn(), randFn());
      return okOrRefused("checkpoint requested", r);
    },
  );

  server.registerTool(
    "mark_handoff_ready",
    { description: "session handoff ready 기록", inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) => {
      const r = await markHandoffReady(WORKSPACE, { sessionId }, nowFn(), randFn());
      return okOrRefused("handoff ready", r);
    },
  );

  server.registerTool(
    "request_session_close",
    {
      description: "session close 요청 (→ closing; close_session의 게이트)",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const r = await requestSessionClose(WORKSPACE, { sessionId }, nowFn(), randFn());
      return okOrRefused("close requested", r);
    },
  );

  server.registerTool(
    "close_session",
    {
      description:
        "session을 closed로 (terminal) — session_close_requested 이후에만. 유일한 session_closed 경로",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const r = await closeSession(WORKSPACE, { sessionId }, nowFn(), randFn());
      return okOrRefused("closed", r);
    },
  );
}
