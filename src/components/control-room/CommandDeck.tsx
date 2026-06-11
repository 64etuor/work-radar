import { AlertTriangle, Loader2, Play } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

import type {
  PreflightCheck,
  ProjectTickerStatusRow,
  ReadinessView,
  TickerSchedulerStatus,
  TickStatusOutcome,
} from "../../bindings";
import {
  useSetTickEnabled,
  useSetTickInterval,
  useSetTickLive,
  useTickNow,
} from "../../lib/query/governance";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { InfraBar } from "./InfraBar";
import { ReadinessDetails, ReadinessGatesRow } from "./ReadinessStrip";

/** Per-project command deck: 지금 POSTURE (readiness) · 마지막 TICK (last outcome) · controls,
 *  with the INFRA chip row on the deck's bottom edge. Replaces the all-projects ticker panel —
 *  tabs select the project; this card shows that one project only.
 *
 *  Card 셸은 ControlRoomView의 프로젝트 콘솔(.cr-console)이 소유한다 — 탭(projectbar)은
 *  프로젝트 전환 시 remount되면 안 되므로(키가 projectId) 카드 밖 형제로 남고,
 *  이 컴포넌트는 카드 안의 deck 본문만 그린다. */
export function CommandDeck({
  row,
  readiness,
  infra,
  scheduler,
  nowMs,
}: {
  row: ProjectTickerStatusRow;
  readiness: ReadinessView | undefined;
  infra: PreflightCheck[] | undefined;
  scheduler: TickerSchedulerStatus | null;
  nowMs: number;
}) {
  const reduce = useReducedMotion();
  return (
    <LazyMotion features={domAnimation}>
      <m.div
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
      >
        <div className="cr-deck">
          <div className="cr-deck-zones">
            {readiness !== undefined && (
              <section className="cr-deck-zone" aria-label="지금 POSTURE">
                <div className="cr-deck-kicker">지금 POSTURE</div>
                <ReadinessGatesRow readiness={readiness} />
              </section>
            )}

            <section className="cr-deck-zone" aria-label="마지막 TICK">
              <div className="cr-deck-kicker">마지막 TICK</div>
              <LastTick row={row} nowMs={nowMs} />
            </section>

            <section className="cr-deck-zone cr-deck-controls" aria-label="컨트롤">
              <div className="cr-deck-kicker">컨트롤</div>
              <DeckControls row={row} />
              {row.tickEnabled && row.autonomyLevel === "manual" && (
                <div className="cr-deck-note">
                  Clock on · autonomy manual — 사람 게이트 대기 중 (자동 디스패치 없음)
                </div>
              )}
            </section>
          </div>

          {readiness !== undefined && <ReadinessDetails readiness={readiness} />}

          {infra !== undefined && (
            <div className="cr-deck-infra">
              <InfraBar infra={infra} ticker={row} scheduler={scheduler} />
            </div>
          )}
        </div>
      </m.div>
    </LazyMotion>
  );
}

function LastTick({ row, nowMs }: { row: ProjectTickerStatusRow; nowMs: number }) {
  return (
    <div className="cr-deck-lasttick">
      <OutcomeChip outcome={row.lastOutcome} inProgress={row.inProgress} />
      <span className="cr-deck-time">{relativeTime(row.lastFinishedAt, nowMs, "last")}</span>
      <span className="cr-deck-time">{relativeTime(row.nextDueAt, nowMs, "next")}</span>
      {row.consecutiveFailures > 0 && (
        <Badge
          variant="outline"
          className="cr-deck-failures"
          title="연속 인프라 실패 횟수 — 3회에 도달하면 자동 tick이 멈추고 attention이 켜집니다"
        >
          {row.consecutiveFailures}× fail
        </Badge>
      )}
      {row.attentionRequired && (
        <Badge variant="destructive" className="cr-deck-attention">
          <AlertTriangle size={12} aria-hidden />
          waiting on you
        </Badge>
      )}
    </div>
  );
}

function DeckControls({ row }: { row: ProjectTickerStatusRow }) {
  const setEnabled = useSetTickEnabled();
  const setInterval = useSetTickInterval();
  const setLive = useSetTickLive();
  const tickNow = useTickNow();
  const [draft, setDraft] = useState(() => ({
    intervalSec: row.intervalSec,
    value: intervalDraft(row.intervalSec),
  }));
  const draftInterval =
    draft.intervalSec === row.intervalSec ? draft.value : intervalDraft(row.intervalSec);

  const enablingThis = setEnabled.isPending && setEnabled.variables?.projectId === row.projectId;
  const togglingLive = setLive.isPending && setLive.variables?.projectId === row.projectId;
  const savingInterval =
    setInterval.isPending && setInterval.variables?.projectId === row.projectId;
  const tickingThis = tickNow.isPending && tickNow.variables === row.projectId;
  const busy = row.inProgress || tickingThis;

  const commitInterval = () => {
    const next = parseIntervalDraft(draftInterval);
    setDraft({ intervalSec: next, value: intervalDraft(next) });
    if (next !== row.intervalSec) {
      setInterval.mutate({ projectId: row.projectId, intervalSec: next });
    }
  };

  return (
    <div className="cr-deck-controlrow">
      <div className="cr-ticker-toggle">
        <span>Enabled</span>
        <Switch
          checked={row.tickEnabled}
          onCheckedChange={(enabled) => setEnabled.mutate({ projectId: row.projectId, enabled })}
          disabled={enablingThis}
          aria-label={`${row.projectName} ticker enabled`}
        />
      </div>

      <div
        className="cr-ticker-toggle"
        title="LIVE: 이 프로젝트의 tick/snapshot에 BOULE_CONDUCTOR_MODE/OBSERVER_MODE=live를 주입 — 실제 세션이 spawn됩니다 (프로젝트별 운영자 opt-in)"
      >
        <span>Live</span>
        <Switch
          checked={row.liveEnabled}
          onCheckedChange={(live) => setLive.mutate({ projectId: row.projectId, live })}
          disabled={togglingLive}
          aria-label={`${row.projectName} live mode`}
        />
      </div>

      <label className="cr-ticker-interval">
        <span>Interval</span>
        <input
          value={draftInterval}
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder="manual"
          onChange={(e) => setDraft({ intervalSec: row.intervalSec, value: e.target.value })}
          onBlur={commitInterval}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          disabled={savingInterval}
          aria-label={`${row.projectName} ticker interval seconds`}
        />
      </label>

      <Button
        variant="outline"
        size="sm"
        onClick={() => tickNow.mutate(row.projectId)}
        disabled={busy}
        aria-label={`${row.projectName} tick now`}
      >
        {busy ? <Loader2 size={14} aria-hidden /> : <Play size={14} aria-hidden />}
        Tick now
      </Button>
    </div>
  );
}

function OutcomeChip({
  outcome,
  inProgress,
}: {
  outcome: TickStatusOutcome | null;
  inProgress: boolean;
}) {
  const label = inProgress ? "in_flight" : (outcome ?? "not_run");
  return (
    <Badge variant="outline" className="cr-ticker-outcome" data-outcome={label}>
      {label}
    </Badge>
  );
}

function intervalDraft(intervalSec: number | null): string {
  return intervalSec == null ? "" : String(intervalSec);
}

function parseIntervalDraft(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function relativeTime(value: string | null, nowMs: number, label: "last" | "next"): string {
  if (!value) return `${label} -`;
  const timestamp = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp)) return `${label} unknown`;
  const diffMin = Math.round((timestamp - nowMs) / 60_000);
  const abs = Math.abs(diffMin);
  if (abs === 0) return label === "next" ? `${label} now` : `${label} just now`;
  if (abs < 60) return diffMin > 0 ? `${label} in ${abs}m` : `${label} ${abs}m ago`;
  const hours = Math.round(abs / 60);
  return diffMin > 0 ? `${label} in ${hours}h` : `${label} ${hours}h ago`;
}
