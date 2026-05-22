import { useEffect, useState } from "react";

import type { AgentRunView, AgentStatus } from "@/bindings";
import { useAgentRuns } from "@/lib/query";
import { useUIStore } from "@/store";

/**
 * 글로벌 에이전트 상태 바 (Phase 20 #16) — 모든 뷰 상단에 상주하는 얇은 스트립.
 *
 * 모든 AI 작업(codex 잡·배치 enrich·CI triage·향후 Hermes)을 한 곳에 stacked 세그먼트로 집계한다.
 * 상태별 색(running/awaiting_approval/failed/succeeded)으로 구분하고, 실행 중 세그먼트는
 * **경과/timeout 비율**로 진행을 표시한다(codex는 실 % 없음 → started_at + timeout_sec 프록시).
 * 클릭 → Jobs 뷰. 활성 잡이 없으면 최소 스트립으로 축소(DESIGN.md: UI를 지배하지 않음).
 *
 * 폴링은 기존 `useAgentRuns`만 재사용한다(활성 잡이 있을 때만 2s 폴링 — 새 폴 도입 없음).
 */

/** 세그먼트로 표시할 최근 잡 최대 개수(바가 과밀해지지 않게 bound). */
const MAX_SEGMENTS = 12;

function isActive(s: AgentStatus): boolean {
  return s === "running" || s === "proposed" || s === "awaiting_approval";
}

/** 상태 → 세그먼트 색 클래스 + 사람이 읽을 라벨(tooltip). */
const SEG: Record<AgentStatus, { cls: string; label: string }> = {
  proposed: { cls: "asb-seg-proposed", label: "큐 대기" },
  running: { cls: "asb-seg-running", label: "실행 중" },
  awaiting_approval: { cls: "asb-seg-awaiting", label: "승인 대기" },
  succeeded: { cls: "asb-seg-succeeded", label: "완료" },
  failed: { cls: "asb-seg-failed", label: "실패" },
  cancelled: { cls: "asb-seg-cancelled", label: "취소됨" },
};

/** SQLite UTC datetime('YYYY-MM-DD HH:MM:SS')을 epoch ms로(타임존 마커 없음 → UTC로 해석). */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** 실행 중 잡의 경과/timeout 진행률(0~1). started_at 없거나 파싱 실패면 0. */
function elapsedRatio(run: AgentRunView, nowMs: number): number {
  const started = parseUtcMs(run.startedAt);
  if (started == null || run.timeoutSec <= 0) return 0;
  const elapsedSec = (nowMs - started) / 1000;
  return Math.max(0, Math.min(1, elapsedSec / run.timeoutSec));
}

export function AgentStatusBar() {
  const { goTo } = useUIStore();
  const runs = useAgentRuns();
  const list = runs.data ?? [];

  const active = list.filter((r) => isActive(r.status));
  const hasActive = active.length > 0;

  // 활성 잡이 있는 동안만 진행률 애니메이션용 시계를 1s 간격으로 틱(폴링과 별개의 UI 시계).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasActive]);

  // 표시 세그먼트: 활성 + 최근 잡(최신순, bound). list는 created_at DESC 정렬.
  const segments = list.slice(0, MAX_SEGMENTS);

  if (segments.length === 0) {
    // 잡이 전혀 없으면 최소 스트립(UI 비지배).
    return (
      <button
        type="button"
        className="asb asb-idle"
        onClick={() => goTo("jobs")}
        title="Agent Jobs 열기"
      >
        <span className="asb-label">Agent</span>
        <span className="asb-idle-text">유휴</span>
      </button>
    );
  }

  return (
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
      <span className="asb-track">
        {segments.map((run) => {
          const seg = SEG[run.status];
          const ratio = run.status === "running" ? elapsedRatio(run, nowMs) : 0;
          return (
            <span
              key={run.id}
              className={`asb-seg ${seg.cls}`}
              title={`${run.kind} · ${seg.label}`}
            >
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
  );
}
