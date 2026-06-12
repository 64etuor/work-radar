import type { AgentUsage, UsageWindow } from "@/bindings";

import { formatResetAt, formatResetIn, usageTone, usageWindowLabel } from "../../lib/agentUsage";
import { useAgentUsageStatus } from "../../lib/query/agents";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { ClaudeIcon, OpenAiIcon } from "./agentBrandIcons";

/**
 * 헤더 중앙 — claude/codex 사용량 한도 게이지 (5h/주간 + 리셋 카운트다운).
 * 데이터를 못 읽어도 본문을 막지 않는다: 로딩/실패엔 빈 자리만 차지하고,
 * 에이전트별 unavailable은 — 로 표시(사유는 툴팁).
 */
export function AgentUsageStrip() {
  const q = useAgentUsageStatus();
  // 로딩 중에도 빈 자리를 차지해야 3칸 그리드(1fr auto 1fr)의 우측 stamp가 점프하지 않는다.
  if (!q.data) return <div className="cr-usage" aria-hidden />;
  return (
    <TooltipProvider>
      <section className="cr-usage" aria-label="에이전트 사용량 한도">
        <UsageCluster
          brand="claude"
          name="Claude"
          icon={<ClaudeIcon />}
          usage={q.data.claude}
          nowMs={q.dataUpdatedAt}
        />
        <UsageCluster
          brand="codex"
          name="Codex"
          icon={<OpenAiIcon />}
          usage={q.data.codex}
          nowMs={q.dataUpdatedAt}
        />
      </section>
    </TooltipProvider>
  );
}

function UsageCluster({
  brand,
  name,
  icon,
  usage,
  nowMs,
}: {
  brand: "claude" | "codex";
  name: string;
  icon: React.ReactNode;
  usage: AgentUsage;
  nowMs: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cr-usage-chip" data-brand={brand}>
          <span className="cr-usage-icon">{icon}</span>
          <span className="cr-usage-name">{name}</span>
          {usage.available ? (
            usage.windows.map((w) => <UsageGauge key={w.id} window={w} nowMs={nowMs} />)
          ) : (
            <span className="cr-usage-off">—</span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <UsageDetail name={name} usage={usage} nowMs={nowMs} />
      </TooltipContent>
    </Tooltip>
  );
}

/** 툴팁 본문 — 윈도별 사용률+절대 리셋 시각, codex는 세션 기준 시각(stale 가능)도. */
function UsageDetail({ name, usage, nowMs }: { name: string; usage: AgentUsage; nowMs: number }) {
  if (!usage.available) {
    return (
      <div className="cr-usage-tip">
        <div className="cr-usage-tip-title">{name}</div>
        <div className="cr-usage-tip-muted">{usage.detail ?? "사용량을 읽지 못했습니다."}</div>
      </div>
    );
  }
  const asOf = formatResetAt(usage.asOf);
  return (
    <div className="cr-usage-tip">
      <div className="cr-usage-tip-title">{name} 사용량</div>
      {usage.windows.map((w) => {
        if (w.usedPercent == null) return null;
        const resetIn = formatResetIn(w.resetsAt, nowMs);
        const resetAt = formatResetAt(w.resetsAt);
        return (
          <div key={w.id} className="cr-usage-tip-row">
            <span>{w.id === "five_hour" ? "5시간 한도" : "주간 한도"}</span>
            <span className="cr-usage-tip-val">
              {Math.round(w.usedPercent)}%
              {resetAt ? ` · ${resetAt} 리셋${resetIn ? ` (${resetIn} 후)` : ""}` : ""}
            </span>
          </div>
        );
      })}
      {asOf && <div className="cr-usage-tip-muted">{asOf} 세션 기록 기준</div>}
    </div>
  );
}

function UsageGauge({ window: w, nowMs }: { window: UsageWindow; nowMs: number }) {
  // specta는 f64를 nullable로 내보낸다(NaN 비표현) — 백엔드는 항상 유한값을 주지만 방어.
  if (w.usedPercent == null) return null;
  const pct = Math.round(w.usedPercent);
  const tone = usageTone(w.usedPercent);
  const resetIn = formatResetIn(w.resetsAt, nowMs);
  return (
    <div className="cr-usage-win">
      <span className="cr-usage-win-head">
        <span className="cr-usage-win-label">{usageWindowLabel(w.id)}</span>
        <span className="cr-usage-pct">{pct}%</span>
      </span>
      <span className="cr-usage-bar">
        <span className="cr-usage-fill" data-tone={tone} style={{ width: `${pct}%` }} />
      </span>
      <span className="cr-usage-reset">{resetIn ? `↻ ${resetIn}` : " "}</span>
    </div>
  );
}
