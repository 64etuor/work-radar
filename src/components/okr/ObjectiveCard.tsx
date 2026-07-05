import { Archive, Edit3, Flag, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

import type {
  KeyResultKind,
  LifeWheelTagConfig,
  MissionHorizon,
  Objective,
  ObjectiveSignalStats,
  OkrCheckIn,
  Project,
} from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { objectiveProgressRatio } from "@/lib/okr";
import { useCreateKeyResult } from "@/lib/query";

import { KeyResultRow, ProgressTrack } from "./KeyResultRow";
import { parseNullableNumber } from "./okrControls";

export function ObjectiveCard({
  objective,
  tags,
  projects,
  horizons,
  horizonIds,
  stats,
  checkIns,
  onEdit,
  onClose,
}: {
  objective: Objective;
  tags: LifeWheelTagConfig[];
  projects: Project[];
  horizons: MissionHorizon[];
  horizonIds: string[];
  stats: ObjectiveSignalStats | null;
  checkIns: OkrCheckIn[];
  onEdit: (objective: Objective, opener: HTMLElement) => void;
  onClose: (objective: Objective, opener: HTMLElement) => void;
}) {
  const readOnly = objective.status === "closed";
  const progress = objectiveProgressRatio(objective.keyResults);
  const sortedKrs = [...objective.keyResults].sort((a, b) => a.sortRank - b.sortRank);

  return (
    <article className="mission-objective" data-status={objective.status}>
      <div className="mission-objective-head">
        <div className="mission-objective-copy">
          <div className="mission-objective-eyebrow typo-mono-label">
            <Flag className="size-4" />
            <span>Objective</span>
            {readOnly && <Badge variant="secondary">마감됨</Badge>}
          </div>
          <h2 className="mission-objective-title typo-title-md">{objective.title}</h2>
          {objective.description && (
            <p className="mission-objective-desc typo-body-md">{objective.description}</p>
          )}
        </div>
        <div className="mission-objective-actions">
          {!readOnly && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => onEdit(objective, event.currentTarget)}
              >
                <Edit3 className="size-4" />
                수정
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => onClose(objective, event.currentTarget)}
              >
                <Archive className="size-4" />
                마감
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mission-chip-row">
        {objective.linkedAreaKeys.map((tagId) => (
          <AreaChip key={tagId} tagId={tagId} tags={tags} />
        ))}
        {objective.linkedProjectIds.map((projectId) => (
          <Badge key={projectId} variant="outline">
            {projects.find((project) => project.id === projectId)?.name ?? projectId}
          </Badge>
        ))}
        {horizonIds.map((horizonId) => (
          <Badge key={horizonId} variant="secondary">
            {horizons.find((horizon) => horizon.id === horizonId)?.title ?? horizonId}
          </Badge>
        ))}
        {objective.linkedAreaKeys.length === 0 &&
          objective.linkedProjectIds.length === 0 &&
          horizonIds.length === 0 && (
            <span className="mission-muted typo-body-md">연결된 태그/프로젝트/장기 목표 없음</span>
          )}
      </div>

      <div className="mission-objective-progress">
        <div className="mission-progress-line">
          <span className="typo-label-sm">진척 {Math.round(progress * 100)}%</span>
          <span className="mission-muted typo-caption-sm">
            KR {sortedKrs.length}개 평균 · 이번 주 캡처 {stats?.week.captured ?? 0} · 완료{" "}
            {stats?.week.completed ?? 0} · {formatHours(stats?.week.scheduledMinutes ?? 0)}
          </span>
        </div>
        <ProgressTrack ratio={progress} />
      </div>

      <div className="mission-kr-list">
        {sortedKrs.map((kr) => (
          <KeyResultRow
            key={`${kr.id}-${kr.updatedAt}`}
            kr={kr}
            latestCheckIn={latestCheckInFor(kr.id, checkIns)}
            readOnly={readOnly}
          />
        ))}
        {sortedKrs.length === 0 && (
          <div className="mission-empty-line typo-body-md">아직 Key Result가 없습니다.</div>
        )}
      </div>

      {readOnly ? (
        <ClosedObjectiveHistory objective={objective} checkIns={checkIns} />
      ) : (
        <AddKeyResultForm objective={objective} />
      )}
    </article>
  );
}

function AddKeyResultForm({ objective }: { objective: Objective }) {
  const createKeyResult = useCreateKeyResult();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<KeyResultKind>("metric");
  const [current, setCurrent] = useState("");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [milestones, setMilestones] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    await createKeyResult.mutateAsync({
      objectiveId: objective.id,
      title: cleanTitle,
      kind,
      currentValue: kind === "metric" ? parseNullableNumber(current) : null,
      targetValue: kind === "metric" ? parseNullableNumber(target) : null,
      unit: kind === "metric" ? unit.trim() || null : null,
      milestones:
        kind === "milestone"
          ? milestones
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((label) => ({ label, done: false }))
          : [],
      sortRank: objective.keyResults.length,
    });
    setTitle("");
    setCurrent("");
    setTarget("");
    setUnit("");
    setMilestones("");
    setOpen(false);
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mission-add-kr" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        KR 추가
      </Button>
    );
  }

  return (
    <form className="mission-add-kr-form" onSubmit={submit}>
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="KR 제목"
        autoFocus
      />
      <Select value={kind} onValueChange={(value) => setKind(value as KeyResultKind)}>
        <SelectTrigger className="mission-kind-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="metric">수치형</SelectItem>
          <SelectItem value="milestone">마일스톤</SelectItem>
        </SelectContent>
      </Select>
      {kind === "metric" ? (
        <div className="mission-add-kr-metric">
          <Input
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            inputMode="decimal"
            placeholder="현재"
          />
          <Input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            inputMode="decimal"
            placeholder="목표"
          />
          <Input
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="단위"
          />
        </div>
      ) : (
        <Textarea
          value={milestones}
          onChange={(event) => setMilestones(event.target.value)}
          placeholder={"마일스톤을 한 줄씩 입력"}
          rows={3}
        />
      )}
      <div className="mission-add-kr-actions">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
          취소
        </Button>
        <Button type="submit" size="sm" disabled={createKeyResult.isPending || !title.trim()}>
          저장
        </Button>
      </div>
    </form>
  );
}

function ClosedObjectiveHistory({
  objective,
  checkIns,
}: {
  objective: Objective;
  checkIns: OkrCheckIn[];
}) {
  const krIds = new Set(objective.keyResults.map((kr) => kr.id));
  const rows = checkIns
    .filter((checkIn) => krIds.has(checkIn.keyResultId))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .slice(-10);
  return (
    <div className="mission-closed-history">
      <div>
        <span className="typo-label-sm">마감 회고</span>
        <p className="mission-muted typo-body-md">
          {objective.closedReflection || "회고가 비어 있습니다."}
        </p>
      </div>
      <div className="mission-sparkline" aria-label="체크인 이력">
        {rows.map((checkIn) => (
          <span
            key={checkIn.id}
            className="mission-spark-bar"
            data-confidence={checkIn.confidence}
            style={{
              height: `${Math.max(20, Math.min(100, (checkIn.valueSnapshot ?? 0) * 100))}%`,
            }}
            title={`${checkIn.weekStart} ${checkIn.confidence}`}
          />
        ))}
        {rows.length === 0 && (
          <span className="mission-muted typo-caption-sm">체크인 이력 없음</span>
        )}
      </div>
    </div>
  );
}

function AreaChip({ tagId, tags }: { tagId: string; tags: LifeWheelTagConfig[] }) {
  const tag = tags.find((candidate) => candidate.id === tagId);
  return (
    <span
      className="mission-area-chip typo-label-sm"
      style={tag ? { background: tag.color, color: readableTextColor(tag.color) } : undefined}
    >
      {tag?.label ?? tagId}
    </span>
  );
}

function latestCheckInFor(keyResultId: string, checkIns: OkrCheckIn[]): OkrCheckIn | null {
  return (
    checkIns
      .filter((checkIn) => checkIn.keyResultId === keyResultId)
      .sort((a, b) =>
        `${b.weekStart}${b.createdAt}`.localeCompare(`${a.weekStart}${a.createdAt}`),
      )[0] ?? null
  );
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return "0h";
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

function readableTextColor(hex: string): string {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.48 ? "#ffffff" : "#212121";
}
