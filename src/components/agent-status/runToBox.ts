import type { AgentRunView, AgentStatus } from "@/bindings";
import type { BoxState } from "@/lib/agentBar";

import type { SessionBox } from "./shared";

const STATUS_TO_STATE: Record<AgentStatus, BoxState> = {
  proposed: "working",
  running: "working",
  awaiting_approval: "waiting",
  succeeded: "done",
  failed: "error",
  cancelled: "done",
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  proposed: "큐 대기",
  running: "실행 중",
  awaiting_approval: "승인 대기",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

/** SQLite UTC datetime('YYYY-MM-DD HH:MM:SS') → epoch ms. */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** agent_runs(codex 등) 활성 잡 → 세션 박스. 호출부에서 isActive로 필터(종료/취소 잡은 제외). */
export function runToBox(run: AgentRunView): SessionBox {
  const state = STATUS_TO_STATE[run.status];
  return {
    key: `run:${run.id}`,
    engine: run.engine,
    name: run.kind,
    state,
    stateLabel: STATUS_LABEL[run.status],
    // working(running)일 때만 경과 백필 — 종료 잡은 idle width.
    startedMs: run.status === "running" ? parseUtcMs(run.startedAt) : null,
    timeoutSec: run.timeoutSec > 0 ? run.timeoutSec : null,
    title: `${run.engine} · ${run.kind} · ${STATUS_LABEL[run.status]}`,
  };
}
