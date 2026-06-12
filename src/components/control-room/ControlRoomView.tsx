import "./ControlRoomView.css";

import { Gauge, RefreshCw } from "lucide-react";
import { useState } from "react";

import { pickActiveProjectId, relativeAgo } from "../../lib/controlRoom";
import { computeVitals, type VitalKey } from "../../lib/controlRoomGraph";
import {
  useProjectControlRoomSnapshot,
  useProjectTickerList,
  useTickerSchedulerStatus,
} from "../../lib/query/governance";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { AgentUsageStrip } from "./AgentUsageStrip";
import { CommandDeck } from "./CommandDeck";
import { FlowSchematic } from "./FlowSchematic";
import { MergeBacklog } from "./MergeBacklog";
import { ProjectTabs } from "./ProjectTabs";
import { RepoCoverage } from "./RepoCoverage";
import { Vitals } from "./Vitals";

export default function ControlRoomView() {
  const ticker = useProjectTickerList();
  const scheduler = useTickerSchedulerStatus();
  // Which project's governance state to show. The snapshot is per-project (folded LIVE from
  // that repo's .boule/workspace), so the user picks one; default = first available project.
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const rows = ticker.data ?? [];
  const activeProjectId = pickActiveProjectId(
    rows.map((r) => r.projectId),
    selectedProject,
  );
  const activeTicker = rows.find((row) => row.projectId === activeProjectId) ?? null;
  const { data, isLoading, isError, error, refetch, isFetching } =
    useProjectControlRoomSnapshot(activeProjectId);
  // Date.now() is impure, so seed "now" once via a lazy initializer; refreshes bump it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [filter, setFilter] = useState<VitalKey | null>(null);

  const stamp = data ? relativeAgo(data.generatedAt, nowMs) : "";
  const vitals = data ? computeVitals(data) : null;
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
        <AgentUsageStrip />
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

      {!ticker.isLoading && rows.length === 0 && (
        <Card className="p-4">
          <div className="cr-empty">프로젝트가 없습니다 — 설정에서 프로젝트를 추가하세요.</div>
        </Card>
      )}

      {rows.length > 0 && (
        // 프로젝트 콘솔: 선택(탭+레포 coverage)과 그 프로젝트의 deck을 한 카드로 묶는다 —
        // 선택 UI는 헤더 chrome이 아니라 콘텐츠 소속. 탭은 카드 안 첫 행이지만 deck의
        // projectId key 밖에 있어 탭 전환 시 remount되지 않는다(슬라이딩 인디케이터 보존).
        <Card className="cr-console p-4">
          <div className="cr-projectbar">
            <ProjectTabs
              rows={rows}
              activeProjectId={activeProjectId}
              onSelect={setSelectedProject}
            />
            <span className="cr-projectbar-chips">
              <MergeBacklog branches={data?.unmergedPlanBranches} />
              <RepoCoverage covered={data?.coveredRepo} />
            </span>
          </div>
          {activeTicker && (
            // key = remount per project: DeckControls' interval draft state must reset on tab
            // switch (without it, two projects sharing the same intervalSec leak an uncommitted
            // draft across tabs — and a blur would silently write it to the OTHER project).
            <CommandDeck
              key={activeTicker.projectId}
              row={activeTicker}
              readiness={data?.readiness}
              infra={data?.infra}
              scheduler={scheduler.data ?? null}
              nowMs={nowMs}
            />
          )}
        </Card>
      )}

      {isLoading && <div className="cr-empty">불러오는 중…</div>}
      {isError && (
        <Card className="p-4">
          <div className="cr-empty">
            거버넌스 상태를 읽지 못했습니다: {String((error as Error)?.message ?? error)}
          </div>
        </Card>
      )}
      {data && (
        <>
          {vitals && (
            <Vitals
              vitals={vitals}
              active={filter}
              onToggle={(key) => setFilter((cur) => (cur === key ? null : key))}
            />
          )}
          {total === 0 ? (
            <GhostPipeline />
          ) : (
            // key = remount per project so React Flow re-runs fitView on tab switch.
            <FlowSchematic key={activeProjectId ?? "none"} snap={data} filter={filter} />
          )}
        </>
      )}
    </div>
  );
}

/** Empty-state skeleton: a ghost of the 5-lane pipeline so the canvas never reads as
 *  broken/blank — dashed placeholder cards with a quiet shimmer (reduced-motion gated),
 *  hint text below. Pure markup; no React Flow mount for zero nodes. */
function GhostPipeline() {
  const lanes = ["SPEC", "PLAN", "TASK", "SESSION", "HANDOFF"];
  return (
    <div className="cr-ghost" aria-label="진행 중인 work 없음">
      <div className="cr-ghost-row" aria-hidden>
        {lanes.map((lane, i) => (
          <div key={lane} className="cr-ghost-lane">
            <div className="cr-ghost-cell">
              <div className="cr-ghost-lane-label">{lane}</div>
              <div className="cr-ghost-node" style={{ animationDelay: `${i * 0.12}s` }}>
                <span className="cr-ghost-bar" />
                <span className="cr-ghost-bar cr-ghost-bar--short" />
              </div>
            </div>
            {i < lanes.length - 1 && <div className="cr-ghost-link" />}
          </div>
        ))}
      </div>
      <div className="cr-canvas-empty-title">진행 중인 work 없음</div>
      <div className="cr-canvas-empty-hint">
        plan을 propose/accept하면 여기 다이어그램으로 나타납니다.
      </div>
    </div>
  );
}
