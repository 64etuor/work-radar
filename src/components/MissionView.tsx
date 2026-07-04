import "./MissionView.css";

import { CalendarDays, Edit3, Plus, Target } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Mission, Objective } from "@/bindings";
import { CloseObjectiveDialog } from "@/components/okr/CloseObjectiveDialog";
import { GuardrailPanel } from "@/components/okr/GuardrailPanel";
import { HorizonShelf } from "@/components/okr/HorizonShelf";
import { ObjectiveCard } from "@/components/okr/ObjectiveCard";
import { ObjectiveDialog } from "@/components/okr/ObjectiveDialog";
import { WeeklyCheckInPanel } from "@/components/okr/WeeklyCheckInPanel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { currentQuarterKey } from "@/lib/lifeOs";
import { objectiveProgressRatio, weekStartMonday } from "@/lib/okr";
import {
  useGuardrails,
  useLifeWheelTags,
  useMission,
  useMissionHorizons,
  useObjectiveHorizonLinks,
  useObjectives,
  useObjectiveSignalStats,
  useOkrCheckIns,
  useProjects,
  useSetMission,
} from "@/lib/query";

type ObjectiveDialogState = Objective | null | undefined;

export function MissionView() {
  const [quarter, setQuarter] = useState(currentQuarterKey());
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
  const guardrails = useGuardrails(quarter);
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
  const quarterElapsed = quarterElapsedRatio(quarter);
  const overallProgress =
    objectiveRows.length === 0
      ? 0
      : objectiveRows.reduce(
          (sum, objective) => sum + objectiveProgressRatio(objective.keyResults),
          0,
        ) / objectiveRows.length;
  const weekStart = weekStartMonday();
  const nextSortRank = objectiveRows.length;

  return (
    <div className="mission">
      <header className="mission-top" data-tauri-drag-region>
        <div>
          <span className="mission-eyebrow typo-mono-label">
            <Target className="size-4" />
            Mission / OKR
          </span>
          <MissionStatement
            key={mission.data?.updatedAt ?? "empty-mission"}
            mission={mission.data ?? null}
          />
        </div>
        <Button
          onClick={(event) => {
            setObjectiveDialogFocusTarget(event.currentTarget);
            setObjectiveDialog(null);
          }}
        >
          <Plus className="size-4" />
          Objective 추가
        </Button>
      </header>

      <div className="mission-scroll">
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
          <p className="mission-quarter-summary typo-label-sm">
            전체 진척 {percentLabel(overallProgress)} · 분기 경과 {percentLabel(quarterElapsed)}
          </p>
        </section>

        {(mission.isError ||
          objectives.isError ||
          stats.isError ||
          checkIns.isError ||
          horizons.isError ||
          guardrails.isError ||
          horizonLinks.isError) && (
          <div className="mission-error typo-label-sm">
            OKR 데이터를 불러오지 못했습니다.{" "}
            {
              (
                mission.error ??
                objectives.error ??
                stats.error ??
                checkIns.error ??
                horizons.error ??
                guardrails.error ??
                (horizonLinks.error as Error | null)
              )?.message
            }
          </div>
        )}

        <div className="mission-life-grid">
          <HorizonShelf horizons={horizons.data ?? []} />
          <GuardrailPanel
            quarter={quarter}
            guardrails={guardrails.data ?? []}
            tags={tags.data ?? []}
          />
        </div>

        <WeeklyCheckInPanel
          objectives={objectiveRows}
          checkIns={checkIns.data ?? []}
          weekStart={weekStart}
        />

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
          {objectiveRows.length === 0 && (
            <div className="mission-empty">
              <span className="typo-title-sm">아직 Objective가 없습니다.</span>
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
            </div>
          )}
        </section>
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

function MissionStatement({ mission }: { mission: Mission | null }) {
  const setMission = useSetMission();
  const savedStatement =
    mission?.statement ?? "이번 시즌 내가 지키려는 방향을 한 문장으로 적어두세요.";
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(savedStatement);

  const cancel = () => {
    setStatement(savedStatement);
    setEditing(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanStatement = statement.trim();
    if (!cleanStatement) return;
    await setMission.mutateAsync({ statement: cleanStatement, note: mission?.note ?? null });
    setEditing(false);
  };

  if (editing) {
    return (
      <form className="mission-statement-form" onSubmit={submit}>
        <Textarea
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          rows={2}
          autoFocus
        />
        <div className="mission-statement-actions">
          <Button type="button" variant="outline" size="sm" onClick={cancel}>
            취소
          </Button>
          <Button type="submit" size="sm" disabled={setMission.isPending || !statement.trim()}>
            저장
          </Button>
        </div>
      </form>
    );
  }

  return (
    <button type="button" className="mission-statement" onClick={() => setEditing(true)}>
      <span className="typo-title-md">{statement}</span>
      <Edit3 className="size-5" aria-hidden="true" />
    </button>
  );
}

function quarterOptions(centerQuarter: string): string[] {
  const parsed = parseQuarter(centerQuarter);
  return Array.from({ length: 7 }, (_, index) =>
    quarterFromIndex(parsed.year, parsed.quarter, index - 4),
  );
}

function quarterFromIndex(year: number, quarter: number, offset: number): string {
  const zeroBased = year * 4 + (quarter - 1) + offset;
  const nextYear = Math.floor(zeroBased / 4);
  const nextQuarter = (zeroBased % 4) + 1;
  return `${nextYear}-Q${nextQuarter}`;
}

function quarterElapsedRatio(quarter: string, date = new Date()): number {
  const parsed = parseQuarter(quarter);
  const start = new Date(parsed.year, (parsed.quarter - 1) * 3, 1);
  const end = new Date(parsed.year, parsed.quarter * 3, 0, 23, 59, 59, 999);
  if (date <= start) return 0;
  if (date >= end) return 1;
  return (date.getTime() - start.getTime()) / (end.getTime() - start.getTime());
}

function quarterLabel(quarter: string): string {
  const parsed = parseQuarter(quarter);
  return `${parsed.year}년 ${parsed.quarter}분기`;
}

function parseQuarter(quarter: string): { year: number; quarter: number } {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return { year: new Date().getFullYear(), quarter: 1 };
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function percentLabel(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}
