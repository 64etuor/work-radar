import { useEffect, useState } from "react";
import {
  LayoutGrid,
  MessageCircle,
  Send,
  Sparkles,
  SquareTerminal,
} from "lucide-react";

import type { AgentRunView, AgentStatus, Engine } from "@/bindings";
import { useAgentRuns } from "@/lib/query";
import { useCmuxStatus } from "@/lib/query/cmux";
import { useUIStore } from "@/store";

/**
 * 글로벌 에이전트 상태 바 (Phase 20 #16 / B1 redesign) — 모든 뷰 상단에 상주하는 얇은 스트립.
 *
 * - 활성 잡: engine 아이콘 + kind 라벨 + elapsed 진행 fill + growing min-width.
 * - 유휴: "idle" 텍스트.
 * - cmux 칩: SEPARATE, best-effort, 표시 전용(INVARIANT #1 — 결정 레일 미사용).
 *
 * 폴링: `useAgentRuns`(활성 잡 시 2s), `useCmuxStatus`(15s 느린 별도 폴).
 */

const MAX_SEGMENTS = 12;

function isActive(s: AgentStatus): boolean {
  return s === "running" || s === "proposed" || s === "awaiting_approval";
}

const SEG: Record<AgentStatus, { cls: string; label: string }> = {
  proposed: { cls: "asb-seg-proposed", label: "큐 대기" },
  running: { cls: "asb-seg-running", label: "실행 중" },
  awaiting_approval: { cls: "asb-seg-awaiting", label: "승인 대기" },
  succeeded: { cls: "asb-seg-succeeded", label: "완료" },
  failed: { cls: "asb-seg-failed", label: "실패" },
  cancelled: { cls: "asb-seg-cancelled", label: "취소됨" },
};

/** engine → lucide 아이콘 컴포넌트. hermes: icon mapped but hermes 잡은 현재 agent_runs에 없음. */
function EngineIcon({ engine, size = 10 }: { engine: Engine; size?: number }) {
  switch (engine) {
    case "codex":
      return <SquareTerminal size={size} />;
    case "hermes":
      return <Send size={size} />;
    case "claude":
      return <Sparkles size={size} />;
    default:
      return <MessageCircle size={size} />;
  }
}

/** SQLite UTC datetime('YYYY-MM-DD HH:MM:SS') → epoch ms. */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** 실행 중 잡의 경과/timeout 진행률(0~1). */
function elapsedRatio(run: AgentRunView, nowMs: number): number {
  const started = parseUtcMs(run.startedAt);
  if (started == null || run.timeoutSec <= 0) return 0;
  const elapsedSec = (nowMs - started) / 1000;
  return Math.max(0, Math.min(1, elapsedSec / run.timeoutSec));
}

/**
 * running 세그먼트의 성장 min-width: elapsedRatio가 올라갈수록 6px → 28px.
 * 세그먼트가 시각적으로 커지며 진행을 암시. MAX_SEGMENTS bound 내에서만.
 */
function growingMinWidth(ratio: number): number {
  const MIN_PX = 6;
  const MAX_PX = 28;
  return Math.round(MIN_PX + ratio * (MAX_PX - MIN_PX));
}

export function AgentStatusBar() {
  const { goTo } = useUIStore();
  const runs = useAgentRuns();
  const list = runs.data ?? [];

  const active = list.filter((r) => isActive(r.status));
  const hasActive = active.length > 0;

  // 진행률 애니메이션용 1s UI 시계 (활성 잡이 있을 때만).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasActive]);

  // 표시 세그먼트: 최근 잡 bound (list는 created_at DESC 정렬).
  const segments = list.slice(0, MAX_SEGMENTS);

  // 가장 최근 active 잡 — kind 라벨 표시 대상.
  const latestActive = active[0] ?? null;

  // cmux best-effort 상태 (INVARIANT #1: 표시 전용, 결정 레일 미사용).
  const cmux = useCmuxStatus();
  const cmuxData = cmux.data;
  const showCmux =
    cmuxData?.available === true && cmuxData.workspaces.length > 0;
  const cmuxTooltip = showCmux
    ? cmuxData!.workspaces
        .map((w) => `${w.selected ? "▶ " : "  "}${w.title} (${w.reference})`)
        .join("\n")
    : undefined;

  if (segments.length === 0) {
    return (
      <div className="asb-row">
        <button
          type="button"
          className="asb asb-idle"
          onClick={() => goTo("jobs")}
          title="Agent Jobs 열기"
        >
          <span className="asb-label">Agent</span>
          <span className="asb-idle-text">idle</span>
        </button>
        {showCmux && (
          <CmuxChip count={cmuxData!.workspaces.length} tooltip={cmuxTooltip!} />
        )}
      </div>
    );
  }

  return (
    <div className="asb-row">
      <button
        type="button"
        className={`asb${hasActive ? " asb-busy" : ""}`}
        onClick={() => goTo("jobs")}
        title={
          hasActive
            ? `${active.length}개 실행/대기 중 — Jobs 열기`
            : "Agent Jobs 열기"
        }
      >
        <span className="asb-label">Agent</span>

        {/* 가장 최근 active 잡의 kind 라벨 + engine 아이콘 */}
        {latestActive && (
          <span className="asb-kind-label">
            <EngineIcon engine={latestActive.engine} size={10} />
            <span>{latestActive.kind} 실행 중</span>
          </span>
        )}

        <span className="asb-track">
          {segments.map((run) => {
            const seg = SEG[run.status];
            const ratio =
              run.status === "running" ? elapsedRatio(run, nowMs) : 0;
            const minW =
              run.status === "running" ? growingMinWidth(ratio) : undefined;
            return (
              <span
                key={run.id}
                className={`asb-seg ${seg.cls}`}
                style={minW !== undefined ? { minWidth: minW } : undefined}
                title={`${run.engine} · ${run.kind} · ${seg.label}`}
              >
                {/* engine icon overlay on each segment */}
                <span className="asb-seg-icon">
                  <EngineIcon engine={run.engine} size={8} />
                </span>
                {run.status === "running" && (
                  <span
                    className="asb-seg-fill"
                    style={{ width: `${Math.round(ratio * 100)}%` }}
                  />
                )}
              </span>
            );
          })}
        </span>
        {hasActive && <span className="asb-count">{active.length}</span>}
      </button>

      {/* cmux 칩: 별도 컴포넌트, 표시 전용 (INVARIANT #1). */}
      {showCmux && (
        <CmuxChip count={cmuxData!.workspaces.length} tooltip={cmuxTooltip!} />
      )}
    </div>
  );
}

/** cmux 워크스페이스 표시 칩. 표시 전용 — 어떤 결정 입력에도 사용하지 않음(INVARIANT #1). */
function CmuxChip({ count, tooltip }: { count: number; tooltip: string }) {
  return (
    <span className="asb-cmux-chip" title={tooltip}>
      <LayoutGrid size={10} />
      <span>cmux {count}</span>
    </span>
  );
}
