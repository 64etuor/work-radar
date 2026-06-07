import "./ControlRoomView.css";

import { Gauge, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { relativeAgo } from "../../lib/controlRoom";
import { computeVitals, type VitalKey } from "../../lib/controlRoomGraph";
import { useControlRoomSnapshot } from "../../lib/query/governance";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Schematic } from "./Schematic";
import { Vitals } from "./Vitals";

export default function ControlRoomView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useControlRoomSnapshot();
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
