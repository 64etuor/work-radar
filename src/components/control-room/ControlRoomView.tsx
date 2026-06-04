import "./ControlRoomView.css";

import { Gauge, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import type { ControlRoomSnapshot, SessionRow } from "../../bindings";
import { bucketSessions, relativeAgo, type StatusTone, statusTone } from "../../lib/controlRoom";
import { useControlRoomSnapshot } from "../../lib/query/governance";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

function Dot({ tone }: { tone: StatusTone }) {
  return <span className="cr-dot" data-tone={tone} aria-hidden />;
}

function SystemOverview({ snap }: { snap: ControlRoomSnapshot }) {
  const blocked = snap.orchestrator.tasks.filter((t) => t.hasOpenBlock).length;
  const pressure = snap.sessions.filter((s) => statusTone(s.phase) === "pressure").length;
  const pendingHandoffs = snap.handoffs.filter((h) => h.phase === "pending").length;
  const counts: Array<[string, number]> = [
    ["Tasks", snap.tasks.length],
    ["Plans", snap.plans.length],
    ["Specs", snap.specs.length],
    ["Sessions", snap.sessions.length],
    ["Handoffs", snap.handoffs.length],
  ];
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-base font-medium">System Overview</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {counts.map(([label, n]) => (
          <Badge key={label} variant="outline">
            {label}: {n}
          </Badge>
        ))}
      </div>
      <div className="cr-row">
        <span>
          <Dot tone="blocked" /> Blocked tasks
        </span>
        <span>{blocked}</span>
      </div>
      <div className="cr-row">
        <span>
          <Dot tone="pressure" /> Sessions under pressure
        </span>
        <span>{pressure}</span>
      </div>
      <div className="cr-row">
        <span>
          <Dot tone="pressure" /> Handoffs pending
        </span>
        <span>{pendingHandoffs}</span>
      </div>
    </Card>
  );
}

function SessionRowLine({ s }: { s: SessionRow }) {
  return (
    <div className="cr-row">
      <span>
        <Dot tone={statusTone(s.phase)} />
        {s.surface ?? s.sessionId}
      </span>
      <span className="cr-id">{s.taskId ?? "—"}</span>
    </div>
  );
}

function SessionBoard({ snap }: { snap: ControlRoomSnapshot }) {
  const buckets = useMemo(() => bucketSessions(snap.sessions), [snap.sessions]);
  const cols: Array<[string, SessionRow[]]> = [
    ["Active", buckets.active],
    ["Needs attention", buckets.waiting],
    ["Pressure", buckets.pressure],
    ["Terminal", buckets.terminal],
  ];
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-base font-medium">Agent Session Board</h2>
      {snap.sessions.length === 0 && <div className="cr-empty">세션 프로젝션 없음</div>}
      {cols.map(([label, rows]) =>
        rows.length ? (
          <div key={label}>
            <div className="cr-id mt-2 text-xs tracking-wide uppercase">{label}</div>
            {rows.map((s) => (
              <SessionRowLine key={s.sessionId} s={s} />
            ))}
          </div>
        ) : null,
      )}
    </Card>
  );
}

function HandoffQueue({ snap }: { snap: ControlRoomSnapshot }) {
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-base font-medium">Handoff Queue</h2>
      {snap.handoffs.length === 0 && <div className="cr-empty">핸드오프 없음</div>}
      {snap.handoffs.map((h) => (
        <div key={h.handoffId} className="cr-row">
          <span>
            <Dot tone={statusTone(h.phase)} />
            {h.phase}
          </span>
          <span className="cr-id">{h.sessionId}</span>
        </div>
      ))}
    </Card>
  );
}

function WorkLists({ snap }: { snap: ControlRoomSnapshot }) {
  const blockedTaskIds = new Set(
    snap.orchestrator.tasks.filter((t) => t.hasOpenBlock).map((t) => t.taskId),
  );
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-base font-medium">Work Lists</h2>
      <div className="cr-id text-xs tracking-wide uppercase">Tasks</div>
      {snap.tasks.length === 0 && <div className="cr-empty">태스크 없음</div>}
      {snap.tasks.map((t) => (
        <div key={t.taskId} className="cr-row">
          <span>
            <Dot tone={statusTone(t.phase)} />
            {t.title}
          </span>
          <span>
            {blockedTaskIds.has(t.taskId) && (
              <Badge variant="outline" className="mr-1">
                blocked
              </Badge>
            )}
            <span className="cr-id">{t.phase}</span>
          </span>
        </div>
      ))}
      <div className="cr-id mt-2 text-xs tracking-wide uppercase">Plans</div>
      {snap.plans.length === 0 && <div className="cr-empty">플랜 없음</div>}
      {snap.plans.map((p) => (
        <div key={p.planId} className="cr-row">
          <span>
            <Dot tone={statusTone(p.phase)} />
            {p.title}
          </span>
          <span className="cr-id">{p.phase}</span>
        </div>
      ))}
      <div className="cr-id mt-2 text-xs tracking-wide uppercase">Specs</div>
      {snap.specs.length === 0 && <div className="cr-empty">스펙 없음</div>}
      {snap.specs.map((sp) => (
        <div key={sp.specId} className="cr-row">
          <span>
            <Dot tone={statusTone(sp.phase)} />
            {sp.title}
          </span>
          <span className="cr-id">{sp.phase}</span>
        </div>
      ))}
    </Card>
  );
}

export default function ControlRoomView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useControlRoomSnapshot();
  // Date.now() is impure, so it cannot run during render (react-hooks/purity).
  // Seed "now" once via a lazy state initializer; refreshes bump it on refetch.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const stamp = useMemo(() => (data ? relativeAgo(data.generatedAt, nowMs) : ""), [data, nowMs]);

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

      {isLoading && <div className="cr-empty">불러오는 중…</div>}
      {isError && (
        <Card className="p-4">
          <div className="cr-empty">
            거버넌스 상태를 읽지 못했습니다: {String((error as Error)?.message ?? error)}
          </div>
        </Card>
      )}
      {data && (
        <div className="cr-grid">
          <SystemOverview snap={data} />
          <SessionBoard snap={data} />
          <HandoffQueue snap={data} />
          <WorkLists snap={data} />
        </div>
      )}
    </div>
  );
}
