import "./MissionView.css";

import { CalendarDays, CopyPlus, Edit3, Plus, Sparkles, Target } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { Mission, Objective } from "@/bindings";
import { CloseObjectiveDialog } from "@/components/okr/CloseObjectiveDialog";
import { GuardrailPanel } from "@/components/okr/GuardrailPanel";
import { HorizonShelf } from "@/components/okr/HorizonShelf";
import { ObjectiveCard } from "@/components/okr/ObjectiveCard";
import { ObjectiveDialog } from "@/components/okr/ObjectiveDialog";
import { WeeklyCheckInPanel } from "@/components/okr/WeeklyCheckInPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
  useCodexStatus,
  useCreateKeyResult,
  useCreateObjective,
  useGuardrails,
  useLifeWheelTags,
  useLinkObjectiveHorizon,
  useMission,
  useMissionHorizons,
  useObjectiveHorizonLinks,
  useObjectives,
  useObjectiveSignalStats,
  useOkrCheckIns,
  useOkrImportActiveRun,
  useOkrImportAwaitingRun,
  useProjects,
  useSetMission,
  useTriggerOkrImport,
} from "@/lib/query";
import { useUIStore } from "@/store";

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

const MISSION_PLACEHOLDER = "이번 시즌 내가 지키려는 방향을 한 문장으로 적어두세요.";

function MissionStatement({ mission }: { mission: Mission | null }) {
  const setMission = useSetMission();
  // 미설정이면 빈 값으로 시작 — placeholder 문구를 지우고 타이핑하게 만들지 않는다.
  const savedStatement = mission?.statement ?? "";
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
          placeholder={MISSION_PLACEHOLDER}
          onChange={(event) => setStatement(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          rows={1}
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
      <span className="typo-title-md" data-placeholder={savedStatement ? undefined : ""}>
        {savedStatement || MISSION_PLACEHOLDER}
      </span>
      <Edit3 className="size-5" aria-hidden="true" />
    </button>
  );
}

/**
 * OKR 받아쓰기 진입점 — 자유 텍스트를 붙여넣으면 codex 잡이 OKR 초안을 뽑고(awaiting_approval),
 * 사람이 AgentRunModal의 초안 패널에서 검토·편집 후 적용해야 생성된다(INVARIANT #1/#2).
 * 상태: 실행 중=비활성 라벨, 검토 대기=잡 모달 열기 버튼, 그 외=텍스트 입력 다이얼로그.
 */
function OkrImportButton({ quarter }: { quarter: string }) {
  const codex = useCodexStatus();
  const trigger = useTriggerOkrImport();
  const activeRun = useOkrImportActiveRun();
  const awaitingRun = useOkrImportAwaitingRun();
  const setOpenAgentRunId = useUIStore((s) => s.setOpenAgentRunId);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const codexReady = !!codex.data?.installed && !!codex.data?.authed;
  const running = activeRun != null && activeRun.status !== "awaiting_approval";

  if (awaitingRun) {
    return (
      <Button variant="outline" onClick={() => setOpenAgentRunId(awaitingRun.id)}>
        <Sparkles className="size-4" />
        받아쓰기 초안 검토
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={!codexReady || running}
        title={
          codexReady
            ? "자유 텍스트를 붙여넣으면 에이전트가 OKR 초안을 만듭니다 (적용은 검토 후 사람이)"
            : "codex CLI 설치/로그인 후 사용 가능"
        }
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" />
        {running ? "초안 생성 중…" : "받아쓰기 (AI)"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent className="mission-dialog" aria-describedby={undefined}>
            <DialogTitle>OKR 받아쓰기</DialogTitle>
            <p className="mission-muted typo-body-md">
              미션/장기 목표/Objective/KR이 섞인 자유 텍스트를 붙여넣으세요. 에이전트가{" "}
              {quarterLabel(quarter)} 초안으로 정리하면, 검토·편집 후 적용할 때만 생성됩니다.
            </p>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={12}
              placeholder={"예)\n장기 목표: …\n1년 목표: …\nObjective 1 … KR: …"}
              autoFocus
            />
            {trigger.error != null && (
              <p className="mission-error typo-label-sm">{(trigger.error as Error).message}</p>
            )}
            <div className="mission-dialog-actions">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                취소
              </Button>
              <Button
                type="button"
                disabled={trigger.isPending || text.trim().length === 0}
                onClick={() =>
                  trigger.mutate(
                    {
                      text,
                      quarter,
                      timeoutSec: 240,
                      maxTurns: 8,
                      costCapUsd: 0.5,
                    },
                    {
                      onSuccess: () => {
                        setText("");
                        setOpen(false);
                      },
                    },
                  )
                }
              >
                {trigger.isPending ? "시작 중…" : "초안 생성"}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/**
 * 지난 분기 활성 Objective 이월(복제) — 제목/설명/링크/KR 구조·현재값·장기목표 링크까지 그대로
 * 새 분기에 만든다. 지난 분기 원본은 건드리지 않는다(마감은 사용자 결정 — INVARIANT #1).
 * 기존 IPC(createObjective/createKeyResult/linkObjectiveHorizon)만 사용.
 */
function RolloverFromPrevQuarter({ quarter }: { quarter: string }) {
  const prevQuarter = adjacentQuarter(quarter, -1);
  const prevObjectives = useObjectives(prevQuarter);
  const prevLinks = useObjectiveHorizonLinks(prevQuarter);
  const createObjective = useCreateObjective();
  const createKeyResult = useCreateKeyResult();
  const linkHorizon = useLinkObjectiveHorizon();
  const [running, setRunning] = useState(false);

  const actives = (prevObjectives.data ?? [])
    .filter((objective) => objective.status === "active")
    .sort((a, b) => a.sortRank - b.sortRank);
  if (actives.length === 0) return null;

  const horizonIdsByObjective = new Map<string, string[]>();
  for (const link of prevLinks.data ?? []) {
    const ids = horizonIdsByObjective.get(link.objectiveId) ?? [];
    ids.push(link.horizonId);
    horizonIdsByObjective.set(link.objectiveId, ids);
  }

  const rollover = async () => {
    setRunning(true);
    try {
      for (const [index, objective] of actives.entries()) {
        const created = await createObjective.mutateAsync({
          quarter,
          title: objective.title,
          description: objective.description,
          sortRank: index,
          linkedAreaKeys: objective.linkedAreaKeys,
          linkedProjectIds: objective.linkedProjectIds,
        });
        for (const kr of [...objective.keyResults].sort((a, b) => a.sortRank - b.sortRank)) {
          await createKeyResult.mutateAsync({
            objectiveId: created.id,
            title: kr.title,
            kind: kr.kind,
            currentValue: kr.currentValue,
            targetValue: kr.targetValue,
            unit: kr.unit,
            milestones: kr.milestones,
            sortRank: kr.sortRank,
          });
        }
        for (const horizonId of horizonIdsByObjective.get(objective.id) ?? []) {
          await linkHorizon.mutateAsync({ objectiveId: created.id, horizonId });
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={running}
      title={`${quarterLabel(prevQuarter)} 활성 Objective ${actives.length}개를 이 분기로 복제합니다 (원본 유지)`}
      onClick={() => void rollover()}
    >
      <CopyPlus className="size-4" />
      {running ? "이월 중…" : `${quarterLabel(prevQuarter)}에서 이월 (${actives.length})`}
    </Button>
  );
}

function adjacentQuarter(quarter: string, offset: number): string {
  const parsed = parseQuarter(quarter);
  return quarterFromIndex(parsed.year, parsed.quarter, offset);
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
