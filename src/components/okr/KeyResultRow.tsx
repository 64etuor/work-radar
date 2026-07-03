import { Check, ListChecks, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import type { KeyResult, OkrCheckIn, OkrMilestone } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { keyResultProgressRatio } from "@/lib/okr";
import { useDeleteKeyResult, useUpdateKeyResult } from "@/lib/query";

import { CONFIDENCE_LABELS, parseNullableNumber } from "./okrControls";

export function KeyResultRow({
  kr,
  latestCheckIn,
  readOnly,
}: {
  kr: KeyResult;
  latestCheckIn: OkrCheckIn | null;
  readOnly: boolean;
}) {
  const updateKeyResult = useUpdateKeyResult();
  const deleteKeyResult = useDeleteKeyResult();
  const [title, setTitle] = useState(kr.title);
  const [current, setCurrent] = useState(numberDraft(kr.currentValue));
  const [target, setTarget] = useState(numberDraft(kr.targetValue));
  const [unit, setUnit] = useState(kr.unit ?? "");
  const progress = keyResultProgressRatio(kr);
  const pending = updateKeyResult.isPending || deleteKeyResult.isPending;

  const saveMetric = async () => {
    await updateKeyResult.mutateAsync({
      id: kr.id,
      title: title.trim() || kr.title,
      kind: "metric",
      currentValue: parseNullableNumber(current),
      targetValue: parseNullableNumber(target),
      unit: unit.trim() || null,
      milestones: [],
      sortRank: kr.sortRank,
    });
  };

  const saveTitle = async () => {
    await updateKeyResult.mutateAsync({
      id: kr.id,
      title: title.trim() || kr.title,
      kind: kr.kind,
      currentValue: kr.currentValue,
      targetValue: kr.targetValue,
      unit: kr.unit,
      milestones: kr.milestones,
      sortRank: kr.sortRank,
    });
  };

  return (
    <div className="mission-kr-row">
      <div className="mission-kr-main">
        <Input
          className="mission-kr-title"
          value={title}
          disabled={readOnly}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (!readOnly && title.trim() !== kr.title) void saveTitle();
          }}
          aria-label="KR 제목"
        />
        <ProgressTrack ratio={progress} />
      </div>

      {kr.kind === "metric" ? (
        <div className="mission-kr-metric" aria-label="수치형 KR 값">
          <Input
            value={current}
            disabled={readOnly}
            onChange={(event) => setCurrent(event.target.value)}
            inputMode="decimal"
            aria-label="현재값"
          />
          <span className="mission-muted typo-label-sm">/</span>
          <Input
            value={target}
            disabled={readOnly}
            onChange={(event) => setTarget(event.target.value)}
            inputMode="decimal"
            aria-label="목표값"
          />
          <Input
            value={unit}
            disabled={readOnly}
            onChange={(event) => setUnit(event.target.value)}
            aria-label="단위"
          />
          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void saveMetric()}
            >
              <Save className="size-3.5" />
              저장
            </Button>
          )}
        </div>
      ) : (
        <MilestonePopover kr={kr} readOnly={readOnly} />
      )}

      <ConfidenceBadge checkIn={latestCheckIn} />
      {!readOnly && (
        <Button
          size="sm"
          variant="destructiveGhost"
          disabled={pending}
          aria-label="KR 삭제"
          onClick={() => void deleteKeyResult.mutateAsync(kr.id)}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
}

function MilestonePopover({ kr, readOnly }: { kr: KeyResult; readOnly: boolean }) {
  const updateKeyResult = useUpdateKeyResult();
  const [milestones, setMilestones] = useState<OkrMilestone[]>(kr.milestones);
  const [newMilestone, setNewMilestone] = useState("");
  const done = milestones.filter((milestone) => milestone.done).length;

  const save = async () => {
    await updateKeyResult.mutateAsync({
      id: kr.id,
      title: kr.title,
      kind: "milestone",
      currentValue: null,
      targetValue: null,
      unit: null,
      milestones,
      sortRank: kr.sortRank,
    });
  };

  const addMilestone = () => {
    const label = newMilestone.trim();
    if (!label) return;
    setMilestones((current) => [...current, { label, done: false }]);
    setNewMilestone("");
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="mission-kr-checklist">
          <ListChecks className="size-4" />
          체크리스트 {done}/{milestones.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="mission-milestone-popover" align="end">
        <div className="mission-popover-head">
          <span className="typo-title-sm">마일스톤</span>
          <span className="mission-muted typo-caption-sm">
            {done}/{milestones.length}
          </span>
        </div>
        <div className="mission-milestone-list">
          {milestones.map((milestone, index) => (
            <label key={`${milestone.label}-${index}`} className="mission-check-row">
              <Checkbox
                checked={milestone.done}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  setMilestones((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, done: checked === true } : item,
                    ),
                  )
                }
              />
              <span className="typo-body-md">{milestone.label}</span>
            </label>
          ))}
          {milestones.length === 0 && (
            <span className="mission-muted typo-body-md">마일스톤 없음</span>
          )}
        </div>
        {!readOnly && (
          <div className="mission-milestone-add">
            <Input
              value={newMilestone}
              onChange={(event) => setNewMilestone(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addMilestone();
                }
              }}
              placeholder="새 항목"
            />
            <Button type="button" variant="outline" size="sm" onClick={addMilestone}>
              추가
            </Button>
            <Button type="button" size="sm" disabled={updateKeyResult.isPending} onClick={save}>
              <Check className="size-4" />
              적용
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function ConfidenceBadge({ checkIn }: { checkIn: OkrCheckIn | null }) {
  const confidence = checkIn?.confidence ?? null;
  return (
    <span className="mission-confidence typo-caption-sm" data-confidence={confidence ?? "none"}>
      <span className="mission-confidence-dot" aria-hidden="true" />
      <span>{confidence ? CONFIDENCE_LABELS[confidence] : "체크인 없음"}</span>
    </span>
  );
}

export function ProgressTrack({ ratio }: { ratio: number }) {
  return (
    <span className="mission-progress" aria-label={`진척 ${Math.round(ratio * 100)}%`}>
      <span className="mission-progress-fill" style={{ width: `${barPercent(ratio)}%` }} />
    </span>
  );
}

function numberDraft(value: number | null): string {
  return value == null ? "" : String(value);
}

function barPercent(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
