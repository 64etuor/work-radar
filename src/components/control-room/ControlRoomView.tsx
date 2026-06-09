import "./ControlRoomView.css";

import { AlertTriangle, Gauge, Loader2, Play, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectTickerStatusRow, TickStatusOutcome } from "../../bindings";
import { relativeAgo } from "../../lib/controlRoom";
import { computeVitals, type VitalKey } from "../../lib/controlRoomGraph";
import {
  useControlRoomSnapshot,
  useProjectTickerList,
  useSetTickEnabled,
  useSetTickInterval,
  useTickNow,
} from "../../lib/query/governance";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Switch } from "../ui/switch";
import { Schematic } from "./Schematic";
import { Vitals } from "./Vitals";

export default function ControlRoomView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useControlRoomSnapshot();
  const ticker = useProjectTickerList();
  // Date.now() is impure, so seed "now" once via a lazy initializer; refreshes bump it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [filter, setFilter] = useState<VitalKey | null>(null);

  const stamp = useMemo(() => (data ? relativeAgo(data.generatedAt, nowMs) : ""), [data, nowMs]);
  const vitals = useMemo(() => (data ? computeVitals(data) : null), [data]);
  const total = data
    ? data.tasks.length +
      data.plans.length +
      data.specs.length +
      data.sessions.length +
      data.handoffs.length
    : 0;

  return (
    <div className="cr-view">
      <div className="cr-header">
        <h1 className="inline-flex items-center gap-2 text-lg font-semibold">
          <Gauge size={18} aria-hidden /> Control Room
        </h1>
        <span className="cr-stamp">
          {stamp}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => {
              setNowMs(Date.now());
              void refetch();
            }}
            disabled={isFetching}
          >
            <RefreshCw size={14} className="mr-1" /> 새로고침
          </Button>
        </span>
      </div>

      {vitals && (
        <Vitals
          vitals={vitals}
          active={filter}
          onToggle={(key) => setFilter((cur) => (cur === key ? null : key))}
        />
      )}

      <TickerPanel rows={ticker.data ?? []} nowMs={nowMs} loading={ticker.isLoading} />

      {isLoading && <div className="cr-empty">불러오는 중…</div>}
      {isError && (
        <Card className="p-4">
          <div className="cr-empty">
            거버넌스 상태를 읽지 못했습니다: {String((error as Error)?.message ?? error)}
          </div>
        </Card>
      )}
      {data &&
        (total === 0 ? (
          <Card className="p-4">
            <div className="cr-empty">아직 프로젝션 없음 — 진행 중인 work가 없습니다.</div>
          </Card>
        ) : (
          <Schematic snap={data} filter={filter} />
        ))}
    </div>
  );
}

function TickerPanel({
  rows,
  nowMs,
  loading,
}: {
  rows: ProjectTickerStatusRow[];
  nowMs: number;
  loading: boolean;
}) {
  return (
    <Card className="cr-ticker-card p-4">
      <div className="cr-ticker-head">
        <div>
          <div className="cr-ticker-kicker">Operator clock</div>
          <h2 className="cr-ticker-title">Project ticker</h2>
        </div>
        <Badge variant="outline">{rows.length}</Badge>
      </div>
      {loading ? (
        <div className="cr-empty">티커 상태를 불러오는 중…</div>
      ) : rows.length === 0 ? (
        <div className="cr-empty">프로젝트가 없습니다.</div>
      ) : (
        <div className="cr-ticker-list">
          {rows.map((row) => (
            <TickerRow key={row.projectId} row={row} nowMs={nowMs} />
          ))}
        </div>
      )}
    </Card>
  );
}

function TickerRow({ row, nowMs }: { row: ProjectTickerStatusRow; nowMs: number }) {
  const setEnabled = useSetTickEnabled();
  const setInterval = useSetTickInterval();
  const tickNow = useTickNow();
  const [draft, setDraft] = useState(() => ({
    intervalSec: row.intervalSec,
    value: intervalDraft(row.intervalSec),
  }));
  const draftInterval =
    draft.intervalSec === row.intervalSec ? draft.value : intervalDraft(row.intervalSec);

  const enablingThis = setEnabled.isPending && setEnabled.variables?.projectId === row.projectId;
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
    <div className="cr-ticker-row" data-attention={row.attentionRequired || undefined}>
      <div className="cr-ticker-main">
        <div className="cr-ticker-project">
          <span className="cr-ticker-name">{row.projectName}</span>
          {row.attentionRequired && (
            <Badge variant="destructive" className="cr-ticker-attention">
              <AlertTriangle size={12} aria-hidden />
              waiting on you
            </Badge>
          )}
          {busy && (
            <Badge variant="secondary" className="cr-ticker-running">
              <Loader2 size={12} aria-hidden />
              running
            </Badge>
          )}
        </div>
        {row.tickEnabled && row.autonomyLevel === "manual" && (
          <div className="cr-ticker-note">
            Clock on · autonomy manual — waiting for human gates
          </div>
        )}
      </div>

      <label className="cr-ticker-toggle">
        <span>Enabled</span>
        <Switch
          checked={row.tickEnabled}
          onCheckedChange={(enabled) => setEnabled.mutate({ projectId: row.projectId, enabled })}
          disabled={enablingThis}
          aria-label={`${row.projectName} ticker enabled`}
        />
      </label>

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

      <div className="cr-ticker-meta">
        <OutcomeChip outcome={row.lastOutcome} inProgress={row.inProgress} />
        <span>{relativeTime(row.lastFinishedAt, nowMs, "last")}</span>
        <span>{relativeTime(row.nextDueAt, nowMs, "next")}</span>
      </div>

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
  const label = inProgress ? "in_flight" : outcome ?? "not_run";
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
