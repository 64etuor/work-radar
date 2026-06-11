import type { AgentUsage, UsageWindow } from "@/bindings";

import { formatResetAt, formatResetIn, usageTone, usageWindowLabel } from "../../lib/agentUsage";
import { useAgentUsageStatus } from "../../lib/query/agents";

/**
 * 헤더 중앙 — claude/codex 사용량 한도 게이지 (5h/주간 + 리셋 카운트다운).
 * 데이터를 못 읽어도 본문을 막지 않는다: 로딩/실패엔 아무것도 안 그리고,
 * 에이전트별 unavailable은 — 로 표시(사유는 툴팁).
 */
export function AgentUsageStrip() {
  const q = useAgentUsageStatus();
  // 로딩 중에도 빈 자리를 차지해야 3칸 그리드(1fr auto 1fr)의 우측 stamp가 점프하지 않는다.
  if (!q.data) return <div className="cr-usage" aria-hidden />;
  return (
    <div className="cr-usage" role="group" aria-label="에이전트 사용량 한도">
      <UsageCluster name="Claude" usage={q.data.claude} nowMs={q.dataUpdatedAt} />
      <span className="cr-usage-divider" aria-hidden />
      <UsageCluster name="Codex" usage={q.data.codex} nowMs={q.dataUpdatedAt} />
    </div>
  );
}

function UsageCluster({ name, usage, nowMs }: { name: string; usage: AgentUsage; nowMs: number }) {
  // codex는 마지막 세션 이벤트 기준이라 stale할 수 있다 — 기준 시각을 툴팁으로 노출.
  const asOf = formatResetAt(usage.asOf);
  return (
    <div className="cr-usage-cluster" title={asOf ? `${asOf} 세션 기록 기준` : undefined}>
      <span className="cr-usage-name">{name}</span>
      {usage.available ? (
        usage.windows.map((w) => <UsageGauge key={w.id} window={w} nowMs={nowMs} />)
      ) : (
        <span className="cr-usage-off" title={usage.detail ?? undefined}>
          —
        </span>
      )}
    </div>
  );
}

function UsageGauge({ window: w, nowMs }: { window: UsageWindow; nowMs: number }) {
  // specta는 f64를 nullable로 내보낸다(NaN 비표현) — 백엔드는 항상 유한값을 주지만 방어.
  if (w.usedPercent == null) return null;
  const pct = Math.round(w.usedPercent);
  const tone = usageTone(w.usedPercent);
  const resetIn = formatResetIn(w.resetsAt, nowMs);
  const resetAt = formatResetAt(w.resetsAt);
  const label = usageWindowLabel(w.id);
  const tip = [
    `${label === "5H" ? "5시간" : "주간"} 한도 ${pct}% 사용`,
    resetAt ? `${resetAt} 리셋` : null,
  ]
    .filter(Boolean)
    .join(" — ");
  return (
    <div className="cr-usage-win" title={tip}>
      <span className="cr-usage-win-head">
        <span className="cr-usage-win-label">{label}</span>
        <span className="cr-usage-pct">{pct}%</span>
      </span>
      <span className="cr-usage-bar">
        <span className="cr-usage-fill" data-tone={tone} style={{ width: `${pct}%` }} />
      </span>
      <span className="cr-usage-reset">{resetIn ? `↻ ${resetIn}` : " "}</span>
    </div>
  );
}
