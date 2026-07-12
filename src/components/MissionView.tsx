import "./MissionView.css";

import { CalendarDays, Plus, Target } from "lucide-react";
import { useState } from "react";

import type { Objective } from "@/bindings";
import { CloseObjectiveDialog } from "@/components/okr/CloseObjectiveDialog";
import { HorizonShelf } from "@/components/okr/HorizonShelf";
import { MissionStatement } from "@/components/okr/MissionStatement";
import { ObjectiveCard } from "@/components/okr/ObjectiveCard";
import { ObjectiveDialog } from "@/components/okr/ObjectiveDialog";
import { OkrImportButton } from "@/components/okr/OkrImportButton";
import { RolloverFromPrevQuarter } from "@/components/okr/RolloverButton";
import { WeeklyCheckInPanel } from "@/components/okr/WeeklyCheckInPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { currentQuarterKey } from "@/lib/lifeOs";
import {
  objectiveProgressRatio,
  percentLabel,
  quarterElapsedRatio,
  quarterLabel,
  quarterOptions,
  uncheckedKrCount,
  weekStartMonday,
} from "@/lib/okr";
import {
  useLifeWheelTags,
  useMission,
  useMissionHorizons,
  useObjectiveHorizonLinks,
  useObjectives,
  useObjectiveSignalStats,
  useOkrCheckIns,
  useProjects,
} from "@/lib/query";
import { useScrollRestore } from "@/lib/useScrollRestore";
import { useViewSessionState } from "@/lib/useViewSessionState";

type ObjectiveDialogState = Objective | null | undefined;

/**
 * 페이지 구조 = 3탭 (Perdoo/Lattice/Weekdone 공통 패턴: 기록·구조·기반 분리):
 * - 주간 기록: 이번 주 체크인만 — 매주 실제로 "하는 일"이 첫 화면.
 * - Objectives: 분기 목표 트리(카드) + 추가/이월.
 * - 기반: 장기 목표(가끔 만지는 설정성 내용).
 * 기본 탭은 남은 체크인이 있으면 주간 기록, 없으면 Objectives.
 */
type MissionTab = "checkin" | "objectives" | "foundation";

export function MissionView() {
  // 뷰 전환 생존(세션) — 보던 분기/스크롤 유지(재시작 시 현재 분기로 리셋).
  const [quarter, setQuarter] = useViewSessionState("mission.quarter", currentQuarterKey);
  const scrollRef = useScrollRestore("mission");
  const [tabOverride, setTabOverride] = useState<MissionTab | null>(null);
  const [objectiveDialog, setObjectiveDialog] = useState<ObjectiveDialogState>(undefined);
  const [closingObjective, setClosingObjective] = useState<Objective | null>(null);
  const [objectiveDialogFocusTarget, setObjectiveDialogFocusTarget] = useState<HTMLElement | null>(
    null,
  );
  const [closeDialogFocusTarget, setCloseDialogFocusTarget] = useState<HTMLElement | null>(null);

  const mission = useMission();
  const objectives = useObjectives(quarter);
  const stats = useObjectiveSignalStats(quarter);
  const checkIns = useOkrCheckIns(quarter);
  const horizons = useMissionHorizons();
  const horizonLinks = useObjectiveHorizonLinks(quarter);
  const tags = useLifeWheelTags();
  const projects = useProjects();

  const objectiveRows = [...(objectives.data ?? [])].sort((a, b) => a.sortRank - b.sortRank);
  const statsByObjective = new Map((stats.data ?? []).map((row) => [row.objectiveId, row]));
  const horizonIdsByObjective = new Map<string, string[]>();
  for (const link of horizonLinks.data ?? []) {
    const ids = horizonIdsByObjective.get(link.objectiveId) ?? [];
    ids.push(link.horizonId);
    horizonIdsByObjective.set(link.objectiveId, ids);
  }
  const weekStart = weekStartMonday();
  const pendingCheckIns = uncheckedKrCount(objectiveRows, checkIns.data ?? [], weekStart);
  const overallProgress =
    objectiveRows.length === 0
      ? 0
      : objectiveRows.reduce(
          (sum, objective) => sum + objectiveProgressRatio(objective.keyResults),
          0,
        ) / objectiveRows.length;
  const nextSortRank = objectiveRows.length;

  // 스마트 기본 탭: 남은 체크인 있으면 기록으로 — 사용자가 고르면 그 선택이 우선.
  const tab: MissionTab = tabOverride ?? (pendingCheckIns > 0 ? "checkin" : "objectives");

  const loadError =
    mission.isError ||
    objectives.isError ||
    stats.isError ||
    checkIns.isError ||
    horizons.isError ||
    horizonLinks.isError;

  return (
    <div className="mission">
      <header className="mission-top" data-tauri-drag-region>
        <div className="mission-top-copy">
          <span className="mission-eyebrow typo-mono-label">
            <Target className="size-4" />
            Mission / OKR
          </span>
          <MissionStatement
            key={mission.data?.updatedAt ?? "empty-mission"}
            mission={mission.data ?? null}
          />
        </div>
        <div className="mission-top-actions">
          <OkrImportButton quarter={quarter} />
          <Button
            onClick={(event) => {
              setObjectiveDialogFocusTarget(event.currentTarget);
              setObjectiveDialog(null);
            }}
          >
            <Plus className="size-4" />
            Objective 추가
          </Button>
        </div>
      </header>

      <div className="mission-scroll" ref={scrollRef}>
        <section className="mission-quarter-row">
          <div className="mission-quarter-select">
            <CalendarDays className="size-4" />
            <Select value={quarter} onValueChange={setQuarter}>
              <SelectTrigger className="mission-quarter-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {quarterOptions(currentQuarterKey()).map((option) => (
                  <SelectItem key={option} value={option}>
                    {quarterLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <MissionTabs tab={tab} onSelect={setTabOverride} pendingCheckIns={pendingCheckIns} />
          <p className="mission-quarter-summary typo-label-sm">
            전체 진척 {percentLabel(overallProgress)} · 분기 경과{" "}
            {percentLabel(quarterElapsedRatio(quarter))}
          </p>
        </section>

        {loadError && (
          <div className="mission-error typo-label-sm">
            OKR 데이터를 불러오지 못했습니다.{" "}
            {
              (
                mission.error ??
                objectives.error ??
                stats.error ??
                checkIns.error ??
                horizons.error ??
                (horizonLinks.error as Error | null)
              )?.message
            }
          </div>
        )}

        {tab === "checkin" && (
          <WeeklyCheckInPanel
            objectives={objectiveRows}
            checkIns={checkIns.data ?? []}
            weekStart={weekStart}
          />
        )}

        {tab === "objectives" && (
          <section className="mission-objectives">
            {objectiveRows.map((objective) => (
              <ObjectiveCard
                key={objective.id}
                objective={objective}
                tags={tags.data ?? []}
                projects={projects.data ?? []}
                horizons={horizons.data ?? []}
                horizonIds={horizonIdsByObjective.get(objective.id) ?? []}
                stats={statsByObjective.get(objective.id) ?? null}
                checkIns={checkIns.data ?? []}
                onEdit={(nextObjective, opener) => {
                  setObjectiveDialogFocusTarget(opener);
                  setObjectiveDialog(nextObjective);
                }}
                onClose={(nextObjective, opener) => {
                  setCloseDialogFocusTarget(opener);
                  setClosingObjective(nextObjective);
                }}
              />
            ))}
            {!objectives.isLoading && objectiveRows.length === 0 && (
              <div className="mission-empty">
                <span className="typo-title-sm">아직 Objective가 없습니다.</span>
                <div className="mission-empty-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) => {
                      setObjectiveDialogFocusTarget(event.currentTarget);
                      setObjectiveDialog(null);
                    }}
                  >
                    <Plus className="size-4" />첫 Objective 만들기
                  </Button>
                  <RolloverFromPrevQuarter quarter={quarter} />
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "foundation" && (
          <div className="mission-life-grid">
            <HorizonShelf horizons={horizons.data ?? []} />
          </div>
        )}
      </div>

      <ObjectiveDialog
        open={objectiveDialog !== undefined}
        onOpenChange={(open) => {
          if (!open) setObjectiveDialog(undefined);
        }}
        objective={objectiveDialog ?? null}
        quarter={quarter}
        nextSortRank={nextSortRank}
        tags={tags.data ?? []}
        projects={projects.data ?? []}
        horizons={horizons.data ?? []}
        linkedHorizonIds={
          objectiveDialog?.id ? (horizonIdsByObjective.get(objectiveDialog.id) ?? []) : []
        }
        returnFocusTo={objectiveDialogFocusTarget}
      />
      <CloseObjectiveDialog
        objective={closingObjective}
        onOpenChange={(open) => {
          if (!open) setClosingObjective(null);
        }}
        returnFocusTo={closeDialogFocusTarget}
      />
    </div>
  );
}

const TAB_DEFS: { key: MissionTab; label: string }[] = [
  { key: "checkin", label: "주간 기록" },
  { key: "objectives", label: "Objectives" },
  { key: "foundation", label: "기반" },
];

/** 세그먼트 탭 — 기록/구조/기반 분리. 남은 체크인 수를 기록 탭 배지로. */
function MissionTabs({
  tab,
  onSelect,
  pendingCheckIns,
}: {
  tab: MissionTab;
  onSelect: (tab: MissionTab) => void;
  pendingCheckIns: number;
}) {
  return (
    <div className="mission-tabs" role="tablist" aria-label="Mission 섹션">
      {TAB_DEFS.map((def) => (
        <button
          key={def.key}
          type="button"
          role="tab"
          aria-selected={tab === def.key}
          className="mission-tab typo-label-sm"
          // 클릭 후 포커스 잔류 방지(툴바 패턴) — 전역 Enter 하이재킹 예방.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onSelect(def.key)}
        >
          {def.label}
          {def.key === "checkin" && pendingCheckIns > 0 && (
            <span className="mission-tab-badge">{pendingCheckIns}</span>
          )}
        </button>
      ))}
    </div>
  );
}
